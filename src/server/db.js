import pg from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { MemorySaver } from '@langchain/langgraph';
import { config } from './config.js';
import { logger } from './logger.js';

const { Pool } = pg;

let pool = null;
let checkpointer = null;
let usingMemoryCheckpointer = false;
let postgresReachable = false; // distinct from config.hasPostgres: this tracks whether it actually answered at boot

const AUDIT_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  request_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  route TEXT NOT NULL,
  query TEXT NOT NULL,
  rewritten_query TEXT,
  retrieved_chunk_ids JSONB NOT NULL DEFAULT '[]',
  grader_verdict JSONB,
  rewrite_count INT NOT NULL DEFAULT 0,
  hallucination_verdict JSONB,
  regenerate_count INT NOT NULL DEFAULT 0,
  refused BOOLEAN NOT NULL DEFAULT FALSE,
  refusal_reason TEXT,
  answer TEXT,
  citations JSONB NOT NULL DEFAULT '[]',
  pending_tool JSONB,
  tool_approver TEXT,
  tool_result JSONB,
  latency_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_thread_idx ON audit_log (thread_id);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  tenant_id TEXT NOT NULL DEFAULT 'default',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chunks_tenant_idx ON chunks (tenant_id);

CREATE TABLE IF NOT EXISTS session_usage (
  session_id TEXT NOT NULL,
  usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
  tokens_used BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, usage_date)
);

CREATE TABLE IF NOT EXISTS message_feedback (
  id BIGSERIAL PRIMARY KEY,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  answer TEXT,
  citations JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (thread_id, message_id)
);
CREATE INDEX IF NOT EXISTS message_feedback_thread_idx ON message_feedback (thread_id);
`;

// Returns null whenever Postgres isn't usable right now — either it was
// never configured, or initDatabase()'s boot-time ping failed. Every
// data-access function below goes through this, so "configured but
// unreachable" degrades the same way as "not configured" everywhere, not
// just at boot (this used to only get checked in initDatabase(), so a
// dead-but-configured Postgres crashed loadPersistedChunksIntoMemory() a
// few lines later instead of falling back like everything else did).
export function getPool() {
  if (!config.hasPostgres || !postgresReachable) return null;
  if (!pool) {
    pool = new Pool({ connectionString: config.POSTGRES_URL, max: 10, idleTimeoutMillis: 30_000 });
    pool.on('error', (err) => logger.error({ err }, 'Postgres pool error'));
  }
  return pool;
}

export async function initDatabase() {
  if (!config.hasPostgres) {
    logger.warn('POSTGRES_URL not set — falling back to an in-memory checkpointer and skipping the audit log. Conversation state and audit history will NOT survive a restart. Do not run this way in production.');
    checkpointer = new MemorySaver();
    usingMemoryCheckpointer = true;
    return { checkpointer, hasPostgres: false };
  }

  const probe = new Pool({ connectionString: config.POSTGRES_URL, max: 10, idleTimeoutMillis: 30_000 });
  probe.on('error', (err) => logger.error({ err }, 'Postgres pool error'));
  try {
    await probe.query('SELECT 1');
    postgresReachable = true;
    pool = probe;
  } catch (err) {
    logger.error({ err }, 'Could not reach Postgres at POSTGRES_URL — falling back to an in-memory checkpointer. Fix POSTGRES_URL before deploying.');
    await probe.end().catch(() => {});
    checkpointer = new MemorySaver();
    usingMemoryCheckpointer = true;
    return { checkpointer, hasPostgres: false };
  }

  const p = getPool();
  await p.query(AUDIT_TABLE_SQL);

  const saver = PostgresSaver.fromConnString(config.POSTGRES_URL);
  await saver.setup();
  checkpointer = saver;
  usingMemoryCheckpointer = false;
  logger.info('Postgres checkpointer and audit log ready');
  return { checkpointer, hasPostgres: true };
}

export function getCheckpointer() {
  if (!checkpointer) throw new Error('initDatabase() must run before getCheckpointer()');
  return checkpointer;
}

export function isUsingMemoryCheckpointer() {
  return usingMemoryCheckpointer;
}

export async function writeAuditRow(row) {
  const p = getPool();
  if (!p) return; // memory-mode dev fallback — nothing durable to write to
  try {
    await p.query(
      `INSERT INTO audit_log
        (request_id, thread_id, tenant_id, route, query, rewritten_query, retrieved_chunk_ids,
         grader_verdict, rewrite_count, hallucination_verdict, regenerate_count, refused, refusal_reason,
         answer, citations, pending_tool, tool_approver, tool_result, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        row.requestId, row.threadId, row.tenantId || 'default', row.route, row.query, row.rewrittenQuery || null,
        JSON.stringify(row.retrievedChunkIds || []), row.graderVerdict ? JSON.stringify(row.graderVerdict) : null,
        row.rewriteCount || 0, row.hallucinationVerdict ? JSON.stringify(row.hallucinationVerdict) : null,
        row.regenerateCount || 0, Boolean(row.refused), row.refusalReason || null,
        row.answer || null, JSON.stringify(row.citations || []),
        row.pendingTool ? JSON.stringify(row.pendingTool) : null, row.toolApprover || null,
        row.toolResult ? JSON.stringify(row.toolResult) : null, row.latencyMs || null,
      ],
    );
  } catch (err) {
    logger.error({ err }, 'Failed to write audit log row (non-fatal, request already served)');
  }
}

// Real feedback persistence — replaces the old thumbs up/down UI that only
// ever flipped local React state and was discarded on reload, with nothing
// on the server ever receiving it. ON CONFLICT lets a user change their
// mind (up -> down or vice versa) instead of accumulating duplicate rows,
// and clearing back to unrated deletes the row rather than storing a
// meaningless third rating value.
export async function writeFeedback({ threadId, messageId, tenantId, rating, answer, citations }) {
  const p = getPool();
  if (!p) return { persisted: false };
  if (rating === null) {
    await p.query('DELETE FROM message_feedback WHERE thread_id = $1 AND message_id = $2', [threadId, messageId]);
    return { persisted: true };
  }
  await p.query(
    `INSERT INTO message_feedback (thread_id, message_id, tenant_id, rating, answer, citations)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (thread_id, message_id) DO UPDATE SET rating = $4, created_at = now()`,
    [threadId, messageId, tenantId || 'default', rating, answer || null, JSON.stringify(citations || [])],
  );
  return { persisted: true };
}

export async function readAuditLog({ threadId, limit = 50, offset = 0 } = {}) {
  const p = getPool();
  if (!p) return { rows: [], total: 0, source: 'memory-mode (no persistence)' };
  const params = [];
  let where = '';
  if (threadId) {
    params.push(threadId);
    where = `WHERE thread_id = $${params.length}`;
  }
  params.push(limit, offset);
  const rows = await p.query(
    `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const count = await p.query(`SELECT count(*)::int AS n FROM audit_log ${where}`, threadId ? [threadId] : []);
  return { rows: rows.rows, total: count.rows[0].n, source: 'postgres' };
}

// Coarse per-session daily token budget, enforced at the guardrail layer.
// A real multi-tenant deployment would track this per authenticated user;
// here it's per session id (see security.js) which is the right unit for a
// single-tenant portfolio deployment.
export async function chargeSessionTokens(sessionId, tokens) {
  const p = getPool();
  if (!p) return { used: tokens, ok: true }; // memory-mode: no cross-request budget to enforce
  const result = await p.query(
    `INSERT INTO session_usage (session_id, usage_date, tokens_used)
     VALUES ($1, CURRENT_DATE, $2)
     ON CONFLICT (session_id, usage_date) DO UPDATE SET tokens_used = session_usage.tokens_used + $2
     RETURNING tokens_used`,
    [sessionId, tokens],
  );
  const used = Number(result.rows[0].tokens_used);
  return { used, ok: used <= config.DAILY_TOKEN_BUDGET_PER_SESSION };
}

export async function getSessionTokenUsage(sessionId) {
  const p = getPool();
  if (!p) return 0;
  const result = await p.query(
    `SELECT tokens_used FROM session_usage WHERE session_id = $1 AND usage_date = CURRENT_DATE`,
    [sessionId],
  );
  return result.rows[0] ? Number(result.rows[0].tokens_used) : 0;
}

export async function upsertChunks(chunks, tenantId = 'default') {
  const p = getPool();
  if (!p || chunks.length === 0) return;
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    for (const c of chunks) {
      await client.query(
        `INSERT INTO chunks (id, content, metadata, tenant_id) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET content = $2, metadata = $3, tenant_id = $4`,
        [c.id, c.content, JSON.stringify(c.metadata || {}), tenantId],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function loadAllChunks(tenantId = 'default') {
  const p = getPool();
  if (!p) return [];
  const result = await p.query(`SELECT id, content, metadata FROM chunks WHERE tenant_id = $1`, [tenantId]);
  return result.rows.map((r) => ({ id: r.id, content: r.content, metadata: r.metadata }));
}

export async function closeDatabase() {
  if (pool) await pool.end();
}
