import { ingest } from '../ingest.js';
import { GLOBAL_TENANT } from '../vectorstore.js';
import { logger } from '../logger.js';

// Ingestion takes minutes — fetching hundreds of handbook pages, chunking
// them, and embedding every chunk against a rate-limited API. That is far
// longer than a hosting proxy will hold an HTTP connection open: on Render
// this exact route returned a platform-level `502 Bad Gateway` HTML page
// mid-run, with no way to tell from the response whether the work had
// failed, was still going, or had never started.
//
// So the request no longer waits for the work. POST starts the run and
// returns 202 immediately; GET /ingest/status reports how it went. The
// run itself lives in module state, independent of any client connection,
// which is also what let the earlier interrupted run keep going after its
// caller was disconnected.
let inFlight = null;
let state = {
  status: 'idle', // idle | running | succeeded | failed
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
};

export function ingestHandler(req, res) {
  if (inFlight) {
    return res.status(202).json({
      status: 'running',
      startedAt: state.startedAt,
      message: 'An ingestion run is already in progress; this request did not start another.',
      statusUrl: '/ingest/status',
    });
  }

  state = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null };
  logger.info('Ingestion started (running in the background; poll /ingest/status)');

  inFlight = ingest({ tenantId: GLOBAL_TENANT })
    .then((result) => {
      state = { ...state, status: 'succeeded', finishedAt: new Date().toISOString(), result };
      logger.info(result, 'Ingestion succeeded');
    })
    .catch((err) => {
      state = { ...state, status: 'failed', finishedAt: new Date().toISOString(), error: err.message };
      logger.error({ err }, 'Ingestion failed');
    })
    .finally(() => {
      inFlight = null;
    });

  return res.status(202).json({
    status: 'running',
    startedAt: state.startedAt,
    message: 'Ingestion started. This runs in the background and can take several minutes.',
    statusUrl: '/ingest/status',
  });
}

export function ingestStatusHandler(req, res) {
  const durationMs = state.startedAt
    ? (state.finishedAt ? new Date(state.finishedAt) : new Date()) - new Date(state.startedAt)
    : null;
  res.json({ ...state, inProgress: Boolean(inFlight), durationSeconds: durationMs == null ? null : Math.round(durationMs / 1000) });
}
