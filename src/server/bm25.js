// Okapi BM25 over the corpus's own vocabulary — real sparse lexical scoring,
// the exact-match half of hybrid retrieval that a dense embedding misses
// (policy names, ticket IDs, acronyms). No hashing, no random collisions.

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'for', 'with', 'as', 'by', 'at', 'from', 'that', 'this', 'it',
  'we', 'you', 'i', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will',
]);

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'_-]*/g) || []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t),
  );
}

export class BM25Index {
  constructor({ k1 = 1.5, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.docs = []; // { id, terms: Map<term, count>, length }
    this.docFreq = new Map(); // term -> number of docs containing it
    this.avgDocLength = 0;
    this.idToIndex = new Map();
  }

  build(documents) {
    // documents: [{ id, content }]
    this.docs = [];
    this.docFreq.clear();
    this.idToIndex.clear();
    let totalLength = 0;

    for (const doc of documents) {
      const tokens = tokenize(doc.content);
      const terms = new Map();
      for (const t of tokens) terms.set(t, (terms.get(t) || 0) + 1);
      for (const t of terms.keys()) this.docFreq.set(t, (this.docFreq.get(t) || 0) + 1);
      this.idToIndex.set(doc.id, this.docs.length);
      this.docs.push({ id: doc.id, terms, length: tokens.length });
      totalLength += tokens.length;
    }
    this.avgDocLength = this.docs.length > 0 ? totalLength / this.docs.length : 0;
  }

  get size() {
    return this.docs.length;
  }

  // Returns [{ id, score }] sorted descending, scores are raw BM25 (unbounded, >= 0).
  search(query, topK = 20) {
    if (this.docs.length === 0) return [];
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return [];

    const N = this.docs.length;
    const scores = new Float64Array(this.docs.length);

    for (const term of new Set(queryTerms)) {
      const df = this.docFreq.get(term);
      if (!df) continue;
      // BM25 idf with the +1 floor so idf never goes negative for very common terms.
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

      for (let i = 0; i < this.docs.length; i++) {
        const doc = this.docs[i];
        const tf = doc.terms.get(term);
        if (!tf) continue;
        const denom = tf + this.k1 * (1 - this.b + (this.b * doc.length) / (this.avgDocLength || 1));
        scores[i] += idf * ((tf * (this.k1 + 1)) / denom);
      }
    }

    const results = [];
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] > 0) results.push({ id: this.docs[i].id, score: scores[i] });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }
}

// Reciprocal Rank Fusion: combines two ranked lists without needing their
// scores to be on the same scale (dense cosine similarity and BM25 scores
// are not comparable numbers — this is why naive score-averaging hybrid
// retrieval is a common bug).
export function reciprocalRankFusion(rankedLists, { k = 60 } = {}) {
  const fused = new Map(); // id -> score
  for (const list of rankedLists) {
    list.forEach((item, rank) => {
      const prior = fused.get(item.id) || 0;
      fused.set(item.id, prior + 1 / (k + rank + 1));
    });
  }
  return [...fused.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
