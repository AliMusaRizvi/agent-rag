import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { TaskType } from '@google/generative-ai';
import { OllamaEmbeddings } from '@langchain/ollama';
import { config } from './config.js';
import { logger } from './logger.js';

// Real dense embeddings — replaces the word-hash pseudo-embedding that used
// to live in server.js. Two backends: Ollama (self-hosted, free, no rate
// limits — the default for a no-budget deployment) and Gemini (for anyone
// who does have Gemini quota/budget). Selected via config.EMBEDDING_PROVIDER;
// both implement the same embedDocuments/embedQuery contract below.

// ---------------------------------------------------------------------------
// Ollama — local inference, no API key, no rate limits. A network hiccup or
// the model not being loaded yet can still fail a call, so real errors are
// retried, but there's no cloud quota to wait out — a short backoff is the
// right shape here, not the multi-minute one Gemini's swallowed-429s need.
// ---------------------------------------------------------------------------

const ollamaDocumentEmbedder = new OllamaEmbeddings({
  baseUrl: config.OLLAMA_BASE_URL,
  model: config.OLLAMA_EMBEDDING_MODEL,
});

// nomic-embed-text has a 2048-token context window. The Gemini embedder
// batches many texts into one request fine (its API embeds each text
// independently server-side regardless of batch size), so the same
// pattern was used here initially — but verified live against a real
// ~400-file ingestion: Ollama's /api/embed rejects a batch of many texts
// sent as one array input with "the input length exceeds the context
// length" once the combined size is large enough, even though every
// individual chunk is well under the per-text limit (capped at 1,400
// chars ≈ 350 tokens in ingest.js). One request per text sidesteps this
// entirely — there's no rate limit to justify batching for a local model
// the way there is for Gemini's cloud quota, so the extra HTTP round trips
// cost nothing that matters.
const OLLAMA_MAX_RETRIES = 3;
// A hard safety cap even on a single text, independent of ingest.js's own
// chunk-size limit — this function has no way to know if it's ever called
// with something longer (e.g. a future caller, or a pasted upload that
// skipped chunking). ~6,000 chars is comfortably under nomic-embed-text's
// 2048-token window at a conservative ~3 chars/token.
const OLLAMA_MAX_CHARS_PER_TEXT = 6000;

function isContextLengthError(err) {
  return /context length|context window|input length exceeds/i.test(String(err?.message || ''));
}

async function ollamaEmbedOne(text, label) {
  const safeText = text.length > OLLAMA_MAX_CHARS_PER_TEXT
    ? text.slice(0, OLLAMA_MAX_CHARS_PER_TEXT)
    : text;

  let lastErr;
  for (let attempt = 0; attempt <= OLLAMA_MAX_RETRIES; attempt++) {
    try {
      const [vector] = await ollamaDocumentEmbedder.embedDocuments([safeText]);
      if (!vector || vector.length === 0) throw new Error('empty vector returned');
      return vector;
    } catch (err) {
      lastErr = err;
      // A context-length error on a single, already-capped text will
      // never succeed by retrying the exact same input — that's a
      // permanent rejection, not a transient failure, so fail fast
      // instead of burning the full backoff schedule for nothing.
      if (isContextLengthError(err)) {
        throw new Error(`Text still exceeds the embedding model's context window even at ${safeText.length} chars: ${err.message}`);
      }
      const waitMs = 1000 * 2 ** attempt;
      logger.warn({ err: err.message, attempt: attempt + 1, waitMs, label }, 'Ollama embedding call failed, retrying (is the Ollama server up and the model pulled?)');
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastErr;
}

async function ollamaEmbedDocuments(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i++) {
    out.push(await ollamaEmbedOne(texts[i], `embedDocuments[${i}]`));
  }
  return out;
}

async function ollamaEmbedQuery(text) {
  return ollamaEmbedOne(text, 'embedQuery');
}

// ---------------------------------------------------------------------------
// Gemini — cloud, free tier is real but tightly rate-limited. Two embedder
// instances because Gemini's retrieval embeddings are trained asymmetrically:
// a document embedded with RETRIEVAL_DOCUMENT and a query embedded with
// RETRIEVAL_QUERY land closer together than if both used the same task type.
// ---------------------------------------------------------------------------

const geminiDocumentEmbedder = new GoogleGenerativeAIEmbeddings({
  apiKey: config.geminiKey,
  model: config.EMBEDDING_MODEL,
  taskType: TaskType.RETRIEVAL_DOCUMENT,
});

const geminiQueryEmbedder = new GoogleGenerativeAIEmbeddings({
  apiKey: config.geminiKey,
  model: config.EMBEDDING_MODEL,
  taskType: TaskType.RETRIEVAL_QUERY,
});

// Groq, the chat fallback everywhere else, does not offer an embeddings
// endpoint (verified against their live API and docs — a real provider
// gap, not an oversight), so a 429 here has nowhere to fall back to and
// the correct response is to respect the API's own backoff. Google's 429
// body includes a suggested `retryDelay` (e.g. "46s") when the client is
// asking too fast for its free-tier quota; honor it when present,
// otherwise back off exponentially.
const GEMINI_MAX_RETRIES = 4;

function parseRetryDelaySeconds(err) {
  const match = String(err?.message || '').match(/"retryDelay":"(\d+)s"/);
  return match ? Number(match[1]) : null;
}

function isRateLimitError(err) {
  return /429|Too Many Requests|RESOURCE_EXHAUSTED/i.test(String(err?.message || ''));
}

async function geminiWithRetry(fn, label) {
  let lastErr;
  for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRateLimitError(err) || attempt === GEMINI_MAX_RETRIES) throw err;
      const suggested = parseRetryDelaySeconds(err);
      const waitMs = suggested ? suggested * 1000 + 500 : 1000 * 2 ** attempt;
      logger.warn({ attempt: attempt + 1, waitMs, label }, 'Gemini embedding rate-limited, backing off before retry');
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastErr;
}

// IMPORTANT: @langchain/google-genai's embedDocuments() does NOT throw on a
// rate-limited sub-batch — internally it uses Promise.allSettled and, for
// any rejected chunk, silently substitutes an empty [] vector for every
// text in it (confirmed by reading the installed package's source). That
// means geminiWithRetry() above never even sees an error: the call
// "succeeds" while quietly handing back dead vectors. Caught this via a
// real 400-file ingestion against real Qdrant, which rejected the empty
// vectors outright ("dense vector must not be empty") — but the in-memory
// backend has no such validation, so the same failure would have silently
// degraded retrieval quality for a random subset of chunks (a zero vector
// always scores 0 in cosine similarity) with no error anywhere. Every
// returned vector is validated and any empty ones are re-embedded
// individually with real backoff, since the SDK's own retry chain won't
// catch this. Because the empty-vector case is a swallowed error, the real
// 429's `retryDelay` never reaches us — there's no suggested wait time to
// honor, only the fact that Gemini's free tier is quota-limited per
// minute. A short exponential backoff (seconds) doesn't come close to
// clearing a per-minute window; bulk ingestion is a one-time,
// non-interactive operation, so waiting a couple of minutes worst-case is
// a fine trade for not silently indexing dead vectors.
const GEMINI_BULK_RETRY_WAIT_MS = 65_000; // a bit over a minute, to clear an RPM-based quota window
const GEMINI_MAX_BULK_RETRIES = 3;

async function geminiEmbedBatchWithValidation(embedder, texts, label) {
  let vectors = await geminiWithRetry(() => embedder.embedDocuments(texts), label);

  for (let attempt = 0; attempt < GEMINI_MAX_BULK_RETRIES; attempt++) {
    const emptyIdx = vectors.reduce((acc, v, i) => (!v || v.length === 0 ? [...acc, i] : acc), []);
    if (emptyIdx.length === 0) return vectors;

    logger.warn(
      { count: emptyIdx.length, attempt: attempt + 1, waitMs: GEMINI_BULK_RETRY_WAIT_MS, label },
      'Embedding API silently returned empty vector(s) (a rate-limited sub-batch the SDK swallows instead of throwing) — waiting out the quota window before retrying just those texts',
    );
    await new Promise((resolve) => setTimeout(resolve, GEMINI_BULK_RETRY_WAIT_MS));

    const retried = await geminiWithRetry(() => embedder.embedDocuments(emptyIdx.map((i) => texts[i])), `${label}-retry`);
    emptyIdx.forEach((origIdx, j) => { vectors[origIdx] = retried[j]; });
  }

  const stillEmpty = vectors.filter((v) => !v || v.length === 0).length;
  if (stillEmpty > 0) {
    throw new Error(`${stillEmpty} text(s) still returned an empty embedding after ${GEMINI_MAX_BULK_RETRIES} waits of ${GEMINI_BULK_RETRY_WAIT_MS / 1000}s each — refusing to index a chunk with a dead vector. This usually means the API key's quota is exhausted for longer than a per-minute window (e.g. a daily cap) — check the provider's dashboard before retrying.`);
  }
  return vectors;
}

// Verified live against a real 429 body: Gemini's free tier allows 100
// embedContent requests/minute. Each BATCH below is one request, so
// pacing them at ~650ms apart (a safety margin over the 600ms/request the
// 100/min budget allows) keeps ingestion from tripping the limit on its
// own — the empty-vector retry path above still exists for when other
// traffic on the same key (or a lower real quota) eats into that budget.
const GEMINI_BATCH_INTERVAL_MS = 650;
const GEMINI_BATCH = 32;

async function geminiEmbedDocuments(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += GEMINI_BATCH) {
    const batch = texts.slice(i, i + GEMINI_BATCH);
    const vectors = await geminiEmbedBatchWithValidation(geminiDocumentEmbedder, batch, 'embedDocuments');
    out.push(...vectors);
    if (i + GEMINI_BATCH < texts.length) await new Promise((resolve) => setTimeout(resolve, GEMINI_BATCH_INTERVAL_MS));
  }
  return out;
}

async function geminiEmbedQuery(text) {
  // Same swallowed-empty-response risk as embedDocuments, just without the
  // batch fan-out — the SDK falls back to `?? []` internally on a malformed
  // response instead of throwing.
  for (let attempt = 0; attempt < GEMINI_MAX_RETRIES; attempt++) {
    const vector = await geminiWithRetry(() => geminiQueryEmbedder.embedQuery(text), 'embedQuery');
    if (vector && vector.length > 0) return vector;
    const waitMs = 1000 * 2 ** attempt;
    logger.warn({ attempt: attempt + 1, waitMs }, 'Query embedding came back empty — retrying');
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  throw new Error('Query embedding repeatedly returned empty — refusing to search with a dead vector.');
}

// ---------------------------------------------------------------------------
// Public interface — dispatches on config.EMBEDDING_PROVIDER.
// ---------------------------------------------------------------------------

export async function embedDocuments(texts) {
  return config.EMBEDDING_PROVIDER === 'ollama' ? ollamaEmbedDocuments(texts) : geminiEmbedDocuments(texts);
}

export async function embedQuery(text) {
  return config.EMBEDDING_PROVIDER === 'ollama' ? ollamaEmbedQuery(text) : geminiEmbedQuery(text);
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
