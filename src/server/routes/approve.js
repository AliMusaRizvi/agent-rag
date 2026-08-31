import { Command } from '@langchain/langgraph';
import { getGraph, INTERRUPT } from '../graph.js';
import { writeAuditRow } from '../db.js';

// Resumes the paused graph exactly where prepareToolNode called interrupt().
// No hardcoded "Action approved and executed successfully" string here —
// the response is whatever executeTool actually did (real GitHub issue URL,
// or the real error if the API call failed).
export async function approveHandler(req, res) {
  const start = Date.now();
  const { thread_id: threadId, approved } = req.body;
  const tenantId = req.sessionId;
  const graphConfig = { configurable: { thread_id: threadId } };

  const graph = getGraph();

  const state = await graph.getState(graphConfig);
  const hasPendingInterrupt = state?.tasks?.some((t) => t.interrupts?.length);
  if (!state || !hasPendingInterrupt) {
    return res.status(404).json({ error: 'No pending approval found for this thread (it may have already been resolved, or the thread does not exist).' });
  }
  // The thread was created under a specific session's tenantId (graph.js
  // input); only that same session may approve or reject its pending
  // action — a guessed or shared thread_id alone isn't enough (SEC-09).
  if (state.values.tenantId && state.values.tenantId !== tenantId) {
    return res.status(403).json({ error: 'This action was not requested by your session.' });
  }

  const result = await graph.invoke(new Command({ resume: { approved, approver: tenantId, approvedAt: new Date().toISOString() } }), graphConfig);

  if (result[INTERRUPT]?.length) {
    // Extremely unlikely (a node calling interrupt() twice), but handled rather than silently dropped.
    return res.json({ thread_id: threadId, requires_approval: true, pending_tool_args: result[INTERRUPT][0].value });
  }

  await writeAuditRow({
    requestId: req.id,
    threadId,
    tenantId,
    route: 'tool',
    query: '(tool approval)',
    pendingTool: result.pendingTool,
    toolApprover: tenantId,
    toolResult: result.toolResult,
    answer: result.answer,
    latencyMs: Date.now() - start,
  });

  return res.json({ thread_id: threadId, response: result.answer, toolResult: result.toolResult });
}
