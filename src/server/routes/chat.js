import { randomUUID } from 'crypto';
import { getGraph, INTERRUPT } from '../graph.js';
import { redactPII } from '../guardrails.js';
import { writeAuditRow, chargeSessionTokens, getSessionTokenUsage } from '../db.js';
import { normalizeModelType } from '../providers.js';
import { config } from '../config.js';
import { getCached, setCached } from '../cache.js';
import { logger } from '../logger.js';

function buildSources(retrievedDocs = [], citations = []) {
  const citedIds = new Set(citations.map((c) => c.chunkId));
  return retrievedDocs.map((d) => {
    const uploaded = d.metadata?.type === 'uploaded';
    const url = uploaded
      ? '#'
      : d.metadata?.repo && d.metadata?.source
        ? `https://gitlab.com/${d.metadata.repo}/-/blob/${d.metadata.ref || 'main'}/${d.metadata.source}`
        : '#';
    return {
      chunkId: d.id,
      title: d.metadata?.section || d.metadata?.source || 'Document',
      url,
      snippet: d.content ? `${d.content.slice(0, 220)}...` : '',
      // Full scoring breakdown, not just the one number the UI happens to
      // chart — real transparency means showing dense vs. sparse vs. the
      // LLM reranker's independent judgment, not collapsing them upstream.
      denseScore: d.denseScore ?? null,
      sparseScore: d.sparseScore ?? null,
      fusedScore: d.fusedScore ?? null,
      rerankScore: d.rerankScore ?? null,
      score: d.rerankScore ?? d.fusedScore ?? 0,
      // Retrieved and reranked into the top candidates is not the same as
      // actually cited in the answer — both are worth showing separately.
      cited: citedIds.has(d.id),
    };
  });
}

// The real, structured per-node trace graph.js already builds — every node
// appends to it as it runs, in execution order, including repeats when the
// rewrite/regenerate loops fire. Sent as-is (not just folded into a prose
// summary) so the UI can render an actual execution-path diagram instead of
// a paraphrase of one.
function buildGraphTrace(finalState) {
  return {
    path: (finalState.trace || []).map((t) => t.node),
    steps: finalState.trace || [],
    rewriteCount: finalState.rewriteCount || 0,
    regenerateCount: finalState.regenerateCount || 0,
  };
}

function buildTraceSummary(finalState) {
  const parts = [];
  const retrieveStep = finalState.trace.find((t) => t.node === 'retrieve');
  if (retrieveStep) parts.push(`Retrieved ${retrieveStep.detail.candidates} candidates from hybrid search.`);
  const rerankStep = finalState.trace.find((t) => t.node === 'rerank');
  if (rerankStep) parts.push(`Reranked to the top ${rerankStep.detail.kept}.`);
  if (finalState.rewriteCount > 0) parts.push(`Rewrote the search query ${finalState.rewriteCount} time(s) to find better context.`);
  const grade = finalState.graderVerdict;
  if (grade) parts.push(`Relevance grader: ${grade.reason}`);
  const hallucination = finalState.hallucinationVerdict;
  if (hallucination) {
    parts.push(
      hallucination.grounded
        ? 'Groundedness check passed — every claim traces back to a retrieved source.'
        : `Groundedness check flagged ${hallucination.unsupportedClaims?.length || 0} unsupported claim(s)${finalState.regenerateCount > 0 ? ' before the final regenerate pass' : ''}.`,
    );
  }
  return parts.join(' ') || 'No retrieval was needed for this response.';
}

// The requested provider isn't necessarily what answered — the fallback
// chain in providers.js may have switched to a different one mid-request.
// The generate (or chatReply) node's own trace entry records which model
// actually produced the answer; that's the honest thing to report, not
// the client's original request.
function actualModelUsed(finalState, requestedModelType) {
  const answerStep = (finalState.trace || []).findLast((t) => t.node === 'generate' || t.node === 'chatReply');
  return answerStep?.detail?.modelUsed || requestedModelType;
}

function verdictFor(finalState) {
  if (finalState.refused) return 'Refused — insufficient grounded context';
  if (finalState.unverified) return 'Unverified — groundedness check failed after the retry';
  if (finalState.route === 'chat') return 'Direct response — no retrieval needed';
  return 'Verified by LangGraph checks';
}

export async function chatHandler(req, res) {
  const start = Date.now();
  const { message, thread_id, model, persona, systemPrompt } = req.body;
  const threadId = thread_id || randomUUID();
  const tenantId = req.sessionId;
  const modelType = normalizeModelType(model || config.LLM_PROVIDER);

  const usage = await getSessionTokenUsage(tenantId);
  if (usage >= config.DAILY_TOKEN_BUDGET_PER_SESSION) {
    return res.status(429).json({ error: 'Daily usage limit reached for this session. Try again tomorrow.' });
  }

  const cacheParams = { tenantId, modelType, persona: persona || 'concise', systemPrompt, query: message };
  const cached = getCached(cacheParams);
  if (cached) {
    req.log.info({ threadId }, 'Answer cache hit');
    return res.json({ ...cached, thread_id: threadId, cached: true });
  }

  const graph = getGraph();
  const graphConfig = { configurable: { thread_id: threadId } };

  const inputs = {
    messages: [{ role: 'user', content: message }],
    modelType,
    persona: persona || 'concise',
    systemPrompt: systemPrompt || '',
    tenantId,
  };

  const result = await graph.invoke(inputs, graphConfig);

  if (result[INTERRUPT]?.length) {
    const payload = result[INTERRUPT][0].value;
    await writeAuditRow({
      requestId: req.id,
      threadId,
      tenantId,
      route: 'tool',
      query: redactPII(message).redacted,
      pendingTool: payload,
      latencyMs: Date.now() - start,
    });
    return res.json({ thread_id: threadId, requires_approval: true, pending_tool_args: payload });
  }

  const responsePayload = {
    response: result.answer,
    requires_approval: false,
    sources: buildSources(result.retrievedDocs, result.citations),
    unverified: Boolean(result.unverified || result.refused),
    reasoning: {
      attempts: (result.rewriteCount || 0) + 1,
      verdict: verdictFor(result),
      trace: buildTraceSummary(result),
    },
    graphTrace: buildGraphTrace(result),
    modelUsed: actualModelUsed(result, modelType),
  };

  await writeAuditRow({
    requestId: req.id,
    threadId,
    tenantId,
    route: result.route,
    query: redactPII(message).redacted,
    rewrittenQuery: result.query !== result.originalQuery ? result.query : null,
    retrievedChunkIds: (result.retrievedDocs || []).map((d) => d.id),
    graderVerdict: result.graderVerdict,
    rewriteCount: result.rewriteCount,
    hallucinationVerdict: result.hallucinationVerdict,
    regenerateCount: result.regenerateCount,
    refused: result.refused,
    refusalReason: result.refusalReason,
    answer: result.answer,
    citations: result.citations,
    latencyMs: Date.now() - start,
  });

  // Rough token accounting (chars/4) when a provider didn't report usage —
  // good enough for a soft per-session daily budget, not a billing meter.
  const estimatedTokens = Math.ceil((message.length + (result.answer?.length || 0)) / 4);
  const charge = await chargeSessionTokens(tenantId, estimatedTokens);
  if (!charge.ok) {
    logger.warn({ tenantId, used: charge.used }, 'Session exceeded its daily token budget on this turn');
  }

  if (!result.refused && !result.unverified) {
    setCached(cacheParams, responsePayload);
  }

  return res.json({ ...responsePayload, thread_id: threadId });
}
