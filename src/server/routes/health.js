import { getPool, isUsingMemoryCheckpointer } from '../db.js';
import { getBackend, getCorpusSize } from '../vectorstore.js';
import { config } from '../config.js';

// Liveness: process is up, nothing more. Used by orchestrators to decide
// whether to restart the container.
export function healthHandler(req, res) {
  res.json({ status: 'ok' });
}

// Readiness: can this instance actually serve a request right now. Checks
// the dependencies /chat actually needs — a load balancer should stop
// routing traffic here if this fails, without restarting the container.
// getPool() (not config.hasPostgres) is the source of truth here: it
// returns null both when Postgres was never configured AND when it was
// configured but failed its boot-time ping, so this can't crash on a
// dead-but-configured database the way a config.hasPostgres check would.
export async function readyHandler(req, res) {
  const checks = {};
  const pool = getPool();

  if (!config.hasPostgres) {
    checks.postgres = 'not configured (dev mode — set POSTGRES_URL before deploying)';
  } else if (!pool) {
    checks.postgres = 'error: configured but unreachable at boot (using in-memory checkpointer)';
  } else {
    try {
      await pool.query('SELECT 1');
      checks.postgres = 'ok';
    } catch (err) {
      checks.postgres = `error: ${err.message}`;
    }
  }

  checks.vectorStore = `${getBackend()} (${getCorpusSize()} chunks)`;
  checks.llmProvider = config.geminiKey || config.GROQ_API_KEY ? 'ok' : 'no provider configured';
  checks.checkpointer = isUsingMemoryCheckpointer() ? 'memory (dev)' : 'postgres';

  const failed = Object.entries(checks).filter(([, v]) => typeof v === 'string' && v.startsWith('error'));
  const ready = failed.length === 0 && getCorpusSize() > 0 && (!config.isProduction || !isUsingMemoryCheckpointer());

  res.status(ready ? 200 : 503).json({ ready, checks });
}
