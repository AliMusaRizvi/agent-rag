import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { randomUUID } from 'crypto';
import { initDatabase } from '../db.js';
import { initVectorStore, loadPersistedChunksIntoMemory, getCorpusSize, GLOBAL_TENANT } from '../vectorstore.js';
import { buildGraph } from '../graph.js';
import { ingest } from '../ingest.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

// A deterministic, dependency-free evaluation harness — not RAGAS (a
// Python library; this project is Node end to end, and pulling in a
// second language runtime for one script isn't a trade worth making).
// It measures the same failure modes RAGAS targets, using signals the
// graph already produces rather than an extra LLM-judge call per metric:
//   - retrieval recall: did the expected source ever get retrieved
//   - keyword recall: does the final answer contain the expected facts
//   - refusal correctness: does the system refuse exactly when it should
//     (the two adversarial questions in the gold set expect a refusal)
//   - latency, rewrite-trigger rate, unverified rate
//
// 10 questions is a starter set, not a reportable result — expand
// gold-set.json toward 30-50 before citing these numbers anywhere real.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function runEval() {
  await initDatabase();
  await initVectorStore();
  const graph = buildGraph();

  // The eval script is a separate process from the server. With a
  // persistent Qdrant/Postgres (any real deployment) that's fine — it
  // connects to the same corpus the server already ingested. But run
  // standalone against the in-memory fallback (a fresh CI runner with no
  // provisioned vector DB, or this exact case) and there is nothing to
  // eval against, so bootstrap it here — a no-op once real persistence is
  // in place, since this only fires when the corpus is actually empty.
  await loadPersistedChunksIntoMemory();
  if (getCorpusSize() === 0) {
    logger.warn('Corpus is empty — running ingestion before evaluating (this only happens with no persistent vector store; a real deployment would already have one).');
    await ingest({ tenantId: GLOBAL_TENANT });
  }

  const corpusSize = getCorpusSize();
  if (corpusSize === 0) {
    logger.error('Corpus is still empty after attempting ingestion — cannot evaluate.');
    process.exit(1);
  }

  const goldSet = JSON.parse(readFileSync(path.join(__dirname, 'gold-set.json'), 'utf8'));
  const results = [];

  for (const item of goldSet) {
    const start = Date.now();
    const threadId = randomUUID();
    let state;
    try {
      state = await graph.invoke(
        {
          messages: [{ role: 'user', content: item.question }],
          modelType: config.LLM_PROVIDER,
          persona: 'concise',
          systemPrompt: '',
          tenantId: GLOBAL_TENANT,
        },
        { configurable: { thread_id: threadId } },
      );
    } catch (err) {
      results.push({ question: item.question, error: err.message, latencyMs: Date.now() - start });
      continue;
    }
    const latencyMs = Date.now() - start;

    const retrievedSources = (state.retrievedDocs || []).map((d) => d.metadata?.source || '').join(' ').toLowerCase();
    const retrievalHit = item.expectedSourceContains
      ? retrievedSources.includes(item.expectedSourceContains.toLowerCase())
      : null; // no expectation set for this question

    const answerLower = (state.answer || '').toLowerCase();
    const keywordHits = item.expectedKeywords.filter((k) => answerLower.includes(k.toLowerCase()));
    const keywordRecall = item.expectedKeywords.length > 0 ? keywordHits.length / item.expectedKeywords.length : null;

    const refusalCorrect = item.expectRefusal !== undefined ? Boolean(state.refused) === Boolean(item.expectRefusal) : null;

    results.push({
      question: item.question,
      answer: state.answer,
      route: state.route,
      refused: state.refused,
      unverified: state.unverified,
      rewriteCount: state.rewriteCount,
      retrievalHit,
      keywordRecall,
      refusalCorrect,
      latencyMs,
    });
  }

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const withRetrievalExpectation = results.filter((r) => r.retrievalHit !== null);
  const withKeywordExpectation = results.filter((r) => r.keywordRecall !== null);
  const withRefusalExpectation = results.filter((r) => r.refusalCorrect !== null);

  const summary = {
    corpusSize,
    n: results.length,
    retrievalRecall: avg(withRetrievalExpectation.map((r) => (r.retrievalHit ? 1 : 0))),
    keywordRecall: avg(withKeywordExpectation.map((r) => r.keywordRecall)),
    refusalAccuracy: avg(withRefusalExpectation.map((r) => (r.refusalCorrect ? 1 : 0))),
    rewriteTriggerRate: avg(results.map((r) => (r.rewriteCount > 0 ? 1 : 0))),
    unverifiedRate: avg(results.map((r) => (r.unverified ? 1 : 0))),
    errorRate: avg(results.map((r) => (r.error ? 1 : 0))),
    latencyMsP50: percentile(latencies, 50),
    latencyMsP95: percentile(latencies, 95),
  };

  console.log('\n=== Eval summary (starter gold set, n=%d — expand before citing) ===', results.length);
  console.table(
    results.map((r) => ({
      question: r.question.slice(0, 50),
      route: r.route,
      refused: r.refused,
      retrievalHit: r.retrievalHit,
      keywordRecall: r.keywordRecall,
      latencyMs: r.latencyMs,
    })),
  );
  console.log(summary);

  const reportPath = path.join(__dirname, 'eval-report.json');
  writeFileSync(reportPath, JSON.stringify({ summary, results, ranAt: new Date().toISOString() }, null, 2));
  console.log(`\nFull report written to ${reportPath}`);

  process.exit(0);
}

function avg(nums) {
  if (nums.length === 0) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 1000) / 1000;
}

runEval().catch((err) => {
  logger.error({ err }, 'Eval run failed');
  process.exit(1);
});
