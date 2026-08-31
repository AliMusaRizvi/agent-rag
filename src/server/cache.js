import crypto from 'crypto';
import { getCorpusVersion } from './vectorstore.js';

// A correct answer cache, replacing the one that used to key on lowercased
// message text alone (BUG-07: same question with a different persona
// returned the wrong cached answer) and lived in one process-global Map
// with no tenant scoping (SEC-05: one tenant's cached answer, built from
// their uploaded document, was served to the next person who asked a
// similar question). Every dimension that changes the answer is now part
// of the key, and the key is scoped per tenant. Invalidated automatically
// whenever the corpus changes (ingest or upload bumps corpusVersion).

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 500;

const store = new Map(); // key -> { value, expiresAt }

function makeKey({ tenantId, modelType, persona, systemPrompt, query }) {
  const raw = JSON.stringify({
    tenantId,
    modelType,
    persona,
    systemPrompt: systemPrompt || '',
    query: query.trim().toLowerCase(),
    corpusVersion: getCorpusVersion(),
  });
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function getCached(params) {
  const key = makeKey(params);
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    store.delete(key);
    return null;
  }
  // refresh recency for simple LRU-ish eviction
  store.delete(key);
  store.set(key, entry);
  return entry.value;
}

export function setCached(params, value) {
  const key = makeKey(params);
  if (store.size >= MAX_ENTRIES) {
    const oldestKey = store.keys().next().value;
    store.delete(oldestKey);
  }
  store.set(key, { value, expiresAt: Date.now() + TTL_MS, tenantId: params.tenantId });
}

// Scoped to the caller's own tenant — matches what the "Clear" button in
// the UI's per-session context panel implies it does. Every cache read/
// write was already tenant-scoped (see makeKey above); the clear operation
// used to be the one exception, wiping every concurrent user's cached
// answers on the deployment when any single session clicked "Clear",
// which contradicted this module's own tenant-isolation guarantee. Omit
// tenantId only for a deliberate full-store flush (e.g. an ops/admin
// action), never as the default for a user-triggered request.
export function clearCache(tenantId) {
  if (tenantId === undefined) {
    const size = store.size;
    store.clear();
    return size;
  }
  let cleared = 0;
  for (const [key, entry] of store) {
    if (entry.tenantId === tenantId) {
      store.delete(key);
      cleared++;
    }
  }
  return cleared;
}

export function cacheSize() {
  return store.size;
}
