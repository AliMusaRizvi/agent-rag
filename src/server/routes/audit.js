import { z } from 'zod';
import { readAuditLog } from '../db.js';

const querySchema = z.object({
  thread_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// The accountability layer the audit called for: every retrieval, grader
// verdict, refusal, tool call, and approval decision, readable back out.
// Admin-gated (requireApiKey) — this is operational/audit data, not
// something a browser session should self-serve.
export async function auditHandler(req, res) {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query params', issues: parsed.error.issues });
  }
  const { thread_id, limit, offset } = parsed.data;
  const result = await readAuditLog({ threadId: thread_id, limit, offset });
  res.json(result);
}
