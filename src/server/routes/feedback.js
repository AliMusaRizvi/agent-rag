import { writeFeedback } from '../db.js';
import { logger } from '../logger.js';

// Real persistence for the thumbs up/down UI — every rating lands in the
// message_feedback table (or, with no Postgres configured, is at least
// logged) rather than only ever flipping local React state. Scoped to the
// caller's own tenant/session the same way chat.js and cache.js are.
export async function feedbackHandler(req, res) {
  const { thread_id: threadId, message_id: messageId, rating, answer, citations } = req.body;
  const tenantId = req.sessionId;

  logger.info({ threadId, messageId, tenantId, rating }, 'Message feedback received');
  const result = await writeFeedback({ threadId, messageId, tenantId, rating, answer, citations }).catch((err) => {
    logger.error({ err }, 'Failed to persist feedback (non-fatal)');
    return { persisted: false };
  });

  return res.json({ success: true, persisted: result.persisted });
}
