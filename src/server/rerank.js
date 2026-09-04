import { z } from 'zod';
import { invokeStructured } from './providers.js';
import { config } from './config.js';
import { logger } from './logger.js';

// Cross-encoder rerankers (BGE, Cohere) score a query against a chunk
// jointly and are the standard choice, but self-hosting one is a Python/ML
// runtime this project doesn't have, and both trial APIs mentioned in the
// design doc are rate-capped in a way that breaks under eval sweeps.
// LLM-as-reranker is a documented, legitimate alternative: one structured
// call judges every fused candidate against the query and returns a real,
// query-specific relevance score — not a fixed heuristic. Swapping in a
// hosted cross-encoder later is a one-function change (see README).

const RerankSchema = z.object({
  scores: z.array(z.object({
    index: z.number().int(),
    relevance: z.number().min(0).max(10).describe('0 = irrelevant, 10 = directly and completely answers the query'),
  })),
});

export async function rerank(query, candidates, { topK = 5 } = {}) {
  if (candidates.length === 0) return [];
  if (candidates.length === 1) return candidates.map((c) => ({ ...c, rerankScore: 1 }));

  const listing = candidates
    .map((c, i) => `[${i}] (source: ${c.metadata?.source || 'unknown'})\n${c.content.slice(0, 800)}`)
    .join('\n\n---\n\n');

  const prompt = [
    ['system', 'You are a relevance grader. Score how well each numbered passage answers the user\'s query, from 0 (irrelevant) to 10 (directly and completely answers it). Judge only the text given — do not use outside knowledge. Return a score for every index.'],
    ['human', `Query: ${query}\n\nPassages:\n${listing}`],
  ];

  // Falling back to the already-meaningful fused hybrid-search order (real
  // dense+sparse scores, not arbitrary) rather than letting a broken
  // reranker call corrupt or kill the whole request — two real failure
  // modes verified live against llama3.2:3b, neither of which throws or
  // logs anything on its own:
  //  1. A total provider-chain failure (every fallback exhausted).
  //  2. A schema-valid but semantically empty response: `{"scores":[]}`
  //     satisfies RerankSchema fine (no `.min(1)`), so it never throws or
  //     even warns — but it silently zeroes every candidate's rerankScore
  //     via the `?? 0` default below, making a clearly-relevant top
  //     hybrid-search hit look exactly as "irrelevant" as everything else.
  let data;
  try {
    ({ data } = await invokeStructured(config.LLM_PROVIDER, prompt, RerankSchema, { name: 'score_passages', fast: true }));
  } catch (err) {
    logger.warn({ err: err.message }, 'Reranker call failed entirely — falling back to the fused hybrid-search order');
    return candidates.slice(0, topK).map((c) => ({ ...c, rerankScore: c.fusedScore ?? 0 }));
  }

  if (data.scores.length === 0) {
    logger.warn('Reranker returned no scores at all — falling back to the fused hybrid-search order');
    return candidates.slice(0, topK).map((c) => ({ ...c, rerankScore: c.fusedScore ?? 0 }));
  }

  const scoreByIndex = new Map(data.scores.map((s) => [s.index, s.relevance]));
  const scored = candidates.map((c, i) => ({ ...c, rerankScore: (scoreByIndex.get(i) ?? 0) / 10 }));
  scored.sort((a, b) => b.rerankScore - a.rerankScore);
  return scored.slice(0, topK);
}
