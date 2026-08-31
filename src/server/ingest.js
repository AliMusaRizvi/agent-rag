import { fileURLToPath } from 'url';
import { config } from './config.js';
import { logger } from './logger.js';
import { addDocuments, initVectorStore, getCorpusSize, GLOBAL_TENANT } from './vectorstore.js';

// Real ingestion: crawl the actual handbook (paginated, not the first 100
// tree entries truncated to 5 files), header-aware chunk each file instead
// of embedding it whole, and only fall back to the five hardcoded sentences
// if the network fetch genuinely fails — clearly labeled when it does, so
// nobody mistakes the fallback for the real corpus.

// Gemini's free tier cannot reliably bulk-embed the full ~400-file/~5,000-
// chunk corpus in one run — verified repeatedly, including after a multi-
// day quota reset: the constraint is a sustained per-minute cap across the
// ~150 sequential embedding requests a full ingest needs, not just a daily
// total. Ollama has no such ceiling (self-hosted, no rate limit — just
// slower on CPU), so it gets the full default; Gemini gets a number
// actually proven to complete reliably. Override with INGEST_MAX_FILES if
// you know your own quota tolerates more.
const DEFAULT_MAX_FILES = config.EMBEDDING_PROVIDER === 'ollama' ? 400 : 150;
const MAX_FILES = Number(process.env.INGEST_MAX_FILES || DEFAULT_MAX_FILES);
const CONCURRENCY = 6;
const MAX_CHUNK_CHARS = 1400;
const CHUNK_OVERLAP = 150;
// Verified against the live API (see config.js): GitLab's recursive tree
// listing for this repo returns directories for a long stretch before any
// blobs appear — the first ~1,000 entries under content/handbook are 100%
// directories, and files only start showing up around page 15-20 of 57.
// Stopping after a few pages (the original bug) or after a small fixed
// page budget silently returns zero files. This pages through everything
// GitLab reports via x-total-pages, capped only as a worst-case safety net.
const MAX_PAGES_SAFETY_CAP = 120;

async function fetchJsonWithPaging(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const totalPages = Number(res.headers.get('x-total-pages')) || 1;
  const data = await res.json();
  return { data, totalPages };
}

async function listMarkdownFiles(repo, docsPath) {
  const files = [];
  const baseUrl = `https://gitlab.com/api/v4/projects/${encodeURIComponent(repo)}/repository/tree`;
  const pathParam = docsPath ? `&path=${encodeURIComponent(docsPath)}` : '';

  const first = await fetchJsonWithPaging(`${baseUrl}?recursive=true&per_page=100&page=1${pathParam}`);
  for (const item of first.data) {
    if (item.type === 'blob' && item.name.endsWith('.md')) files.push(item.path);
  }

  const lastPage = Math.min(first.totalPages, MAX_PAGES_SAFETY_CAP);
  for (let page = 2; page <= lastPage && files.length < MAX_FILES; page++) {
    const { data } = await fetchJsonWithPaging(`${baseUrl}?recursive=true&per_page=100&page=${page}${pathParam}`);
    if (!Array.isArray(data) || data.length === 0) break;
    for (const item of data) {
      if (item.type === 'blob' && item.name.endsWith('.md')) files.push(item.path);
    }
  }
  return files.slice(0, MAX_FILES);
}

async function getDefaultBranch(repo) {
  const res = await fetch(`https://gitlab.com/api/v4/projects/${encodeURIComponent(repo)}`);
  if (!res.ok) return 'main';
  const data = await res.json();
  return data.default_branch || 'main'; // NOT "master" — verified live: this repo's default is "main"
}

async function fetchFileContent(repo, filePath, ref) {
  const url = `https://gitlab.com/api/v4/projects/${encodeURIComponent(repo)}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

async function mapWithConcurrency(items, limit, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx).catch((err) => {
        logger.warn({ err: err.message, item: items[idx] }, 'Ingestion item failed, skipping');
        return null;
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results.filter((r) => r !== null);
}

// Split on markdown headers first (keeps each chunk topically coherent —
// citations point at "the Remote Work Policy section", not an arbitrary
// character span). Any section still too long gets sub-split on paragraph
// boundaries with a small overlap so a sentence isn't cut mid-idea.
const hasContent = (lines) => lines.some((l) => l.trim().length > 0);

// Last-resort raw character slice for a unit with no usable break points at
// all (no blank lines, no single newlines — e.g. one enormous unbroken
// sentence or a minified table row).
function hardSlice(text, maxChars, overlap) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + maxChars));
    if (i + maxChars >= text.length) break;
    i += maxChars - overlap;
  }
  return out;
}

// Breaks a single over-cap unit into pieces <= maxChars, preferring to
// split on line boundaries first — an oversized "paragraph" is usually a
// table or list with no blank lines between rows (verified against a real
// handbook page: it produced a single ~15,000-char paragraph with zero
// `\n{2,}` boundaries), and splitting on lines keeps each row intact
// instead of cutting mid-row. Only a genuinely unbreakable single line
// falls back to a raw character slice.
function shrinkUnit(unit, maxChars, overlap) {
  if (unit.length <= maxChars) return [unit];
  const lines = unit.split('\n');
  if (lines.length === 1) return hardSlice(unit, maxChars, overlap);
  return accumulateChunks(lines, maxChars, overlap, '\n');
}

// Accumulates `units` (paragraphs, or lines when shrinkUnit recurses into
// an oversized paragraph) into chunks up to maxChars, carrying a small
// overlap tail into each new chunk for context continuity.
//
// Two correctness properties that a simpler "just check before appending"
// loop doesn't actually guarantee, both caught via a real ingestion run:
//  1. A single unit can itself exceed maxChars (see shrinkUnit above) — a
//     loop that only checks combined length *between* units lets it sail
//     through untouched. Every unit is shrunk to <= maxChars up front.
//  2. Right after a cap-triggered reset, the new buf is `overlap tail +
//     unit` — if `unit` is itself close to maxChars, tail + unit can
//     already exceed the cap before the next iteration's check ever runs.
//     Two consecutive near-cap units this way combined into one 1,516-char
//     chunk that blew past nomic-embed-text's context window during a real
//     ingestion. The overlap tail is capped at whatever room the unit
//     leaves (`maxChars - unit.length - joiner.length`), not a fixed size,
//     so the freshly-seeded buf is always within the cap too.
function accumulateChunks(units, maxChars, overlap, joiner) {
  const out = [];
  let buf = '';
  for (const rawUnit of units) {
    for (const unit of shrinkUnit(rawUnit, maxChars, overlap)) {
      const candidate = buf ? `${buf}${joiner}${unit}` : unit;
      if (candidate.length <= maxChars) {
        buf = candidate;
        continue;
      }
      if (buf.length > 0) out.push(buf.trim());
      const room = Math.max(0, maxChars - unit.length - joiner.length);
      const tail = buf.length > 0 ? buf.slice(Math.max(0, buf.length - Math.min(overlap, room))) : '';
      buf = tail ? `${tail}${joiner}${unit}` : unit;
    }
  }
  if (buf.trim().length > 0) out.push(buf.trim());
  return out;
}

export function headerAwareChunk(markdown, sourcePath) {
  const lines = markdown.split('\n');
  const sections = [];
  // bodyLines excludes the header line itself, so a stub section like
  // "## See Also" with nothing under it doesn't produce a noise chunk
  // whose entire indexed content is the heading syntax — the header text
  // alone has no retrieval value, only what's written under it does.
  let current = { heading: sourcePath, level: 0, headerLine: null, bodyLines: [] };

  for (const line of lines) {
    const match = line.match(/^(#{1,3})\s+(.*)/);
    if (match) {
      if (hasContent(current.bodyLines)) sections.push(current);
      current = { heading: match[2].trim(), level: match[1].length, headerLine: line, bodyLines: [] };
    } else {
      current.bodyLines.push(line);
    }
  }
  if (hasContent(current.bodyLines)) sections.push(current);

  const chunks = [];
  for (const section of sections) {
    const allLines = section.headerLine ? [section.headerLine, ...section.bodyLines] : section.bodyLines;
    const text = allLines.join('\n').trim();
    if (text.length === 0) continue;

    if (text.length <= MAX_CHUNK_CHARS) {
      chunks.push({ heading: section.heading, text });
      continue;
    }

    const pieces = accumulateChunks(text.split(/\n{2,}/), MAX_CHUNK_CHARS, CHUNK_OVERLAP, '\n\n');
    for (const piece of pieces) chunks.push({ heading: section.heading, text: piece });
  }
  return chunks;
}

const FALLBACK_DOCS = [
  { pageContent: 'Remote work is the default — there are no company offices. Team members can work from anywhere with a good internet connection. This aligns with our all-remote philosophy.', metadata: { source: 'handbook/remote-work.md', fallback: true } },
  { pageContent: 'Asynchronous by default. Decisions are written down before they are discussed. Meetings are optional and should have an agenda.', metadata: { source: 'handbook/communication.md', fallback: true } },
  { pageContent: 'Our core values are Collaboration, Results, Efficiency, Diversity, Inclusion & Belonging, Iteration, and Transparency (CREDIT). Transparency means making everything public by default.', metadata: { source: 'handbook/values.md', fallback: true } },
  { pageContent: 'For issue tracking, always apply relevant labels such as ~bug, ~feature, or ~documentation. Assign the issue to the appropriate team milestone.', metadata: { source: 'doc/development/issues.md', fallback: true } },
  { pageContent: 'Deployments are automated through GitLab CI/CD. The pipeline includes stages for build, test, and production deployment.', metadata: { source: 'doc/ci/pipelines.md', fallback: true } },
];

export async function ingest({ tenantId = GLOBAL_TENANT } = {}) {
  const repo = config.GITLAB_REPO;
  logger.info({ repo, maxFiles: MAX_FILES }, 'Starting ingestion');

  let chunks = [];
  try {
    const [paths, ref] = await Promise.all([
      listMarkdownFiles(repo, config.GITLAB_DOCS_PATH),
      getDefaultBranch(repo),
    ]);
    logger.info({ found: paths.length, ref }, 'Markdown files listed');
    if (paths.length === 0) throw new Error('GitLab tree API returned no markdown files');

    const files = await mapWithConcurrency(paths, CONCURRENCY, async (path) => {
      const content = await fetchFileContent(repo, path, ref);
      return content ? { path, content } : null;
    });

    for (const file of files) {
      const fileChunks = headerAwareChunk(file.content, file.path);
      for (const c of fileChunks) {
        chunks.push({
          content: `${c.heading}\n\n${c.text}`,
          metadata: { source: file.path, section: c.heading, repo, ref },
        });
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'Live ingestion failed — indexing the small fallback document set instead. This is NOT the real handbook corpus.');
  }

  if (chunks.length === 0) {
    logger.warn('Using fallback documents (5 hardcoded sentences) — the real handbook could not be fetched.');
    chunks = FALLBACK_DOCS.map((d) => ({ content: d.pageContent, metadata: d.metadata }));
  }

  const count = await addDocuments(chunks, { tenantId });
  logger.info({ chunksIndexed: count, corpusSize: getCorpusSize() }, 'Ingestion complete');
  return { chunksIndexed: count, corpusSize: getCorpusSize(), usedFallback: chunks.some((c) => c.metadata.fallback) };
}

// CLI entry point: `npm run ingest`
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  const { initDatabase } = await import('./db.js');
  await initDatabase();
  await initVectorStore();
  const result = await ingest();
  logger.info(result, 'Done');
  process.exit(0);
}
