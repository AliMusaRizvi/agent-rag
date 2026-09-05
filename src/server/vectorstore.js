import { randomUUID } from 'crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from './config.js';
import { logger } from './logger.js';
import { embedDocuments, embedQuery, cosineSimilarity } from './embeddings.js';
import { BM25Index, reciprocalRankFusion } from './bm25.js';
import { upsertChunks, loadAllChunks } from './db.js';

// Hybrid retrieval: dense (Gemini embeddings, cosine) fused with sparse
// (BM25 over the corpus's real vocabulary) via Reciprocal Rank Fusion.
// Dense storage is Qdrant when configured and reachable; otherwise an
// in-process array, chosen explicitly by VECTOR_BACKEND rather than
// inferred from whether the URL string happens to contain "localhost".
//
// Every chunk is scoped by tenantId. GLOBAL_TENANT holds the shared
// ingested handbook; every other tenantId is a private, per-session
// upload. A search always includes GLOBAL_TENANT plus the caller's own
// tenant, so one session's uploads are never visible to another session,
// while everyone still sees the shared knowledge base.

export const GLOBAL_TENANT = 'global';

const memoryStore = []; // { id, content, metadata, tenantId, vector }
const bm25 = new BM25Index();
let qdrantClient = null;
let backend = 'memory';
let corpusVersion = 0; // bumped on every ingest/upload — used to invalidate the answer cache

export function getCorpusVersion() {
  return corpusVersion;
}

function resolveBackend() {
  if (config.VECTOR_BACKEND === 'memory') return 'memory';
  if (config.VECTOR_BACKEND === 'qdrant') return 'qdrant';
  return config.hasQdrant ? 'qdrant' : 'memory'; // 'auto'
}

export async function initVectorStore() {
  backend = resolveBackend();

  if (backend === 'qdrant') {
    // Only send the API key over a secure connection. A local Qdrant
    // (http://localhost:6333, no auth configured) doesn't want one, and
    // sending a real Qdrant Cloud key to it in plaintext is both pointless
    // and a small credential-leak risk — the client itself warns "Api key
    // is used with unsecure connection." for exactly this. Omitting it on
    // http keeps local development quiet and cloud deployments unchanged.
    const isSecure = config.QDRANT_URL.startsWith('https://');
    qdrantClient = new QdrantClient({
      url: config.QDRANT_URL,
      ...(isSecure && config.QDRANT_API_KEY ? { apiKey: config.QDRANT_API_KEY } : {}),
    });
    let collectionExisted = false;
    try {
      const exists = await qdrantClient.collectionExists(config.QDRANT_COLLECTION);
      collectionExisted = exists.exists;
      if (!collectionExisted) {
        await qdrantClient.createCollection(config.QDRANT_COLLECTION, {
          vectors: { size: config.EMBEDDING_DIM, distance: 'Cosine' },
        });
        logger.info({ collection: config.QDRANT_COLLECTION }, 'Created Qdrant collection');
      }
    } catch (err) {
      logger.error({ err }, 'Qdrant configured but unreachable — falling back to the in-memory store for this run. Fix QDRANT_URL/QDRANT_API_KEY before deploying.');
      backend = 'memory';
      qdrantClient = null;
    }

    // Deliberately outside the try/catch above: a dimension mismatch is a
    // configuration error, not a reachability problem, and must not be
    // silently downgraded to "fall back to memory" the way an unreachable
    // Qdrant is — that would hide a real bug (every future write failing)
    // behind a generic warning. A collection created under an earlier
    // EMBEDDING_DIM (or a different embedding model) rejects every single
    // write from then on; this was caught exactly that way once already,
    // so fail loudly at boot instead of on the first real ingest/upload.
    if (backend === 'qdrant' && collectionExisted) {
      const info = await qdrantClient.getCollection(config.QDRANT_COLLECTION);
      const existingSize = info.config?.params?.vectors?.size;
      if (existingSize && existingSize !== config.EMBEDDING_DIM) {
        throw new Error(
          `Qdrant collection "${config.QDRANT_COLLECTION}" was created with ${existingSize}-dimensional vectors, but EMBEDDING_DIM is ${config.EMBEDDING_DIM}. Every write will fail until this is resolved — either fix EMBEDDING_DIM to match, or delete the collection (all data in it) and let it recreate at the correct size.`,
        );
      }
    }
  }

  if (backend === 'memory') {
    logger.warn('Vector store running in-memory: the corpus is lost on restart and is not shared across replicas. Set VECTOR_BACKEND=qdrant (or leave "auto" with QDRANT_URL/QDRANT_API_KEY set) before deploying.');
  }

  await rebuildSparseIndex();
  return { backend };
}

export function getBackend() {
  return backend;
}

async function scrollAllQdrantChunks() {
  const points = [];
  let offset = undefined;
  while (true) {
    const res = await qdrantClient.scroll(config.QDRANT_COLLECTION, {
      limit: 256,
      offset,
      with_payload: true,
      with_vector: false,
    });
    for (const p of res.points) {
      points.push({ id: String(p.id), content: p.payload.content, metadata: p.payload.metadata, tenantId: p.payload.tenantId });
    }
    if (!res.next_page_offset) break;
    offset = res.next_page_offset;
  }
  return points;
}

// id -> { tenantId, content, metadata }. Kept in sync with the BM25 index
// (both are rebuilt from the same corpus snapshot) so a sparse-only hit can
// be tenant-filtered and its text looked up without re-scrolling the whole
// Qdrant collection on every query.
const chunkCache = new Map();

async function rebuildSparseIndex() {
  let docs;
  if (backend === 'qdrant') {
    docs = await scrollAllQdrantChunks();
  } else {
    docs = memoryStore;
  }
  chunkCache.clear();
  for (const d of docs) chunkCache.set(d.id, { tenantId: d.tenantId, content: d.content, metadata: d.metadata });
  bm25.build(docs.map((d) => ({ id: d.id, content: d.content })));
  logger.info({ count: docs.length, backend }, 'Sparse (BM25) index rebuilt');
  return docs.length;
}

// Qdrant's HTTP API rejects any single request body over 32MB. A full
// handbook ingest (~3,000+ chunks, 768-dim vectors) upserted as one request
// comes out around 54MB — verified live: a real full-corpus ingestion
// failed with exactly "JSON payload (54456626 bytes) is larger than
// allowed (limit: 33554432 bytes)" after already spending over an hour
// generating every embedding, losing all of that work in one shot. Each
// point is roughly 15-17KB (768 floats + content + metadata), so 200 points
// per request (~3MB) stays an order of magnitude under the limit while
// keeping the number of round trips reasonable.
const QDRANT_UPSERT_BATCH = 200;

export async function addDocuments(docs, { tenantId = GLOBAL_TENANT } = {}) {
  // docs: [{ content, metadata }]
  if (docs.length === 0) return 0;
  const vectors = await embedDocuments(docs.map((d) => d.content));
  const records = docs.map((d, i) => ({
    id: randomUUID(),
    content: d.content,
    metadata: d.metadata || {},
    tenantId,
    vector: vectors[i],
  }));

  if (backend === 'qdrant') {
    for (let i = 0; i < records.length; i += QDRANT_UPSERT_BATCH) {
      const batch = records.slice(i, i + QDRANT_UPSERT_BATCH);
      await qdrantClient.upsert(config.QDRANT_COLLECTION, {
        wait: true,
        points: batch.map((r) => ({
          id: r.id,
          vector: r.vector,
          payload: { content: r.content, metadata: r.metadata, tenantId: r.tenantId },
        })),
      });
    }
  } else {
    memoryStore.push(...records);
  }

  // Best-effort durable copy for audit/debug and BM25 rebuild-without-Qdrant-scroll;
  // harmless no-op when Postgres isn't configured.
  await upsertChunks(records.map((r) => ({ id: r.id, content: r.content, metadata: r.metadata })), tenantId).catch(
    (err) => logger.warn({ err }, 'Could not mirror chunks to Postgres (non-fatal)'),
  );

  await rebuildSparseIndex();
  corpusVersion++;
  return records.length;
}

async function denseSearch(queryVector, { k, tenantIds }) {
  if (backend === 'qdrant') {
    const res = await qdrantClient.query(config.QDRANT_COLLECTION, {
      query: queryVector,
      limit: k,
      with_payload: true,
      filter: { must: [{ key: 'tenantId', match: { any: tenantIds } }] },
    });
    return res.points.map((p) => ({
      id: String(p.id),
      content: p.payload.content,
      metadata: p.payload.metadata,
      score: p.score, // cosine similarity, 0..1
    }));
  }

  const scored = memoryStore
    .filter((r) => tenantIds.includes(r.tenantId))
    .map((r) => ({ id: r.id, content: r.content, metadata: r.metadata, score: cosineSimilarity(queryVector, r.vector) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// Returns candidates fused via RRF, each carrying its raw dense/sparse
// scores plus a fused relevance in 0..1 (the max possible RRF contribution
// from two lists, so it's comparable across queries and safe to threshold).
export async function hybridSearch(query, { k = 12, tenantId = GLOBAL_TENANT } = {}) {
  // Nothing indexed at all — searching it cannot return anything, and
  // embedding the query first would spend a request against a metered
  // embedding quota to prove that. Relevant in practice: a freshly
  // deployed instance serves traffic before its first ingestion run, and
  // on the Gemini free tier those wasted calls come out of the same daily
  // budget the ingestion itself needs.
  if (getCorpusSize() === 0) {
    logger.warn('Search attempted against an empty corpus — run ingestion before querying');
    return [];
  }

  const tenantIds = tenantId === GLOBAL_TENANT ? [GLOBAL_TENANT] : [GLOBAL_TENANT, tenantId];
  const queryVector = await embedQuery(query);
  const [denseResults, sparseResultsAll] = await Promise.all([
    denseSearch(queryVector, { k, tenantIds }),
    Promise.resolve(bm25.search(query, k * 2)),
  ]);

  const contentById = new Map(denseResults.map((d) => [d.id, d]));
  // The BM25 index spans every tenant (rebuilt from the whole corpus for
  // simplicity at this scale) — a hit dense search didn't already vet must
  // be checked against chunkCache before it's allowed into the fused
  // result, or a private upload from another session could leak in via an
  // exact keyword match. This is real tenant isolation, not incidental.
  const sparseResults = sparseResultsAll.filter(
    (s) => contentById.has(s.id) || tenantIds.includes(chunkCache.get(s.id)?.tenantId),
  );

  const fused = reciprocalRankFusion([denseResults, sparseResults], { k: 60 });
  const maxPossible = 1 / 61 + 1 / 61; // both lists rank an item #1

  const denseScoreById = new Map(denseResults.map((d) => [d.id, d.score]));
  const sparseScoreById = new Map(sparseResults.map((s) => [s.id, s.score]));

  const results = [];
  for (const f of fused.slice(0, k)) {
    let content = contentById.get(f.id)?.content;
    let metadata = contentById.get(f.id)?.metadata;
    if (!content) {
      // Present only in the sparse list — the cache built alongside the
      // BM25 index already has its text, no need to re-scroll Qdrant.
      const rec = chunkCache.get(f.id);
      if (!rec) continue;
      content = rec.content;
      metadata = rec.metadata;
    }
    results.push({
      id: f.id,
      content,
      metadata,
      denseScore: denseScoreById.get(f.id) ?? null,
      sparseScore: sparseScoreById.get(f.id) ?? null,
      fusedScore: Math.min(1, f.score / maxPossible),
    });
  }
  return results;
}

export function getCorpusSize() {
  return backend === 'memory' ? memoryStore.length : bm25.size;
}

export async function loadPersistedChunksIntoMemory(tenantId = GLOBAL_TENANT) {
  // Used only for the in-memory backend on boot, to recover chunks that were
  // mirrored to Postgres by a previous process (so a memory-backend restart
  // in dev doesn't silently lose everything an operator already ingested).
  if (backend !== 'memory' || memoryStore.length > 0) return 0;
  const rows = await loadAllChunks(tenantId);
  if (rows.length === 0) return 0;
  const vectors = await embedDocuments(rows.map((r) => r.content));
  rows.forEach((r, i) => memoryStore.push({ id: r.id, content: r.content, metadata: r.metadata, tenantId, vector: vectors[i] }));
  await rebuildSparseIndex();
  return rows.length;
}
