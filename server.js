import express from 'express';
import path from 'path';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';

import { config } from './src/server/config.js';
import { logger, httpLogger } from './src/server/logger.js';
import { initDatabase, closeDatabase, isUsingMemoryCheckpointer } from './src/server/db.js';
import { initVectorStore, loadPersistedChunksIntoMemory, getBackend, getCorpusSize } from './src/server/vectorstore.js';
import { buildGraph } from './src/server/graph.js';
import {
  corsMiddleware, helmetMiddleware, sessionMiddleware, requireApiKey,
  chatLimiter, uploadLimiter, generalLimiter,
  validateBody, chatBodySchema, approveBodySchema, feedbackBodySchema,
  notFoundHandler, errorHandler, wrapAsync,
} from './src/server/security.js';
import { chatHandler, chatStreamHandler } from './src/server/routes/chat.js';
import { approveHandler } from './src/server/routes/approve.js';
import { feedbackHandler } from './src/server/routes/feedback.js';
import { upload, uploadHandler } from './src/server/routes/upload.js';
import { modelsHandler } from './src/server/routes/models.js';
import { ingestHandler } from './src/server/routes/ingestRoute.js';
import { auditHandler } from './src/server/routes/audit.js';
import { healthHandler, readyHandler } from './src/server/routes/health.js';
import { clearCache } from './src/server/cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  await initDatabase();
  await initVectorStore();
  await loadPersistedChunksIntoMemory();
  buildGraph();

  if (isUsingMemoryCheckpointer() && config.isProduction) {
    // Belt and suspenders: config.js already refuses to boot in production
    // without POSTGRES_URL, but this guards against that check being
    // bypassed by a future change without duplicating the invariant.
    logger.error('Refusing to accept traffic in production with an in-memory checkpointer — conversation state and human-approval gates would not survive a restart.');
    process.exit(1);
  }

  const app = express();
  app.set('trust proxy', 1); // required for correct client IPs / secure cookies behind a load balancer

  app.use(helmetMiddleware);
  app.use(corsMiddleware);
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use(httpLogger);
  app.use(sessionMiddleware);
  app.use(generalLimiter);

  // API routes.
  //
  // requireApiKey gates *admin* operations only (/ingest, /api/audit) — a
  // shared secret the browser SPA can't legitimately hold, since anything
  // shipped in client-side JS is visible to anyone who opens dev tools.
  // /chat, /approve-tool, /api/feedback, /api/upload, and /api/clear-cache
  // are called directly by the browser and are protected instead by the
  // anonymous session cookie (tenant scoping, approval ownership), rate
  // limiting, and input validation — see security.js and routes/approve.js.
  app.post('/chat', chatLimiter, validateBody(chatBodySchema), wrapAsync(chatHandler));
  app.post('/chat/stream', chatLimiter, validateBody(chatBodySchema), wrapAsync(chatStreamHandler));
  app.post('/approve-tool', validateBody(approveBodySchema), wrapAsync(approveHandler));
  app.post('/api/feedback', validateBody(feedbackBodySchema), wrapAsync(feedbackHandler));
  app.post('/api/upload', uploadLimiter, upload.single('file'), wrapAsync(uploadHandler));
  app.get('/api/models', wrapAsync(modelsHandler));
  app.post('/api/clear-cache', (req, res) => res.json({ success: true, cleared: clearCache(req.sessionId) }));
  app.post('/ingest', requireApiKey, wrapAsync(ingestHandler));
  app.get('/api/audit', requireApiKey, wrapAsync(auditHandler));
  app.get('/health', healthHandler);
  app.get('/ready', wrapAsync(readyHandler));

  app.use('/api/*', notFoundHandler);

  // Static frontend
  app.use(express.static(path.join(__dirname, 'dist')));

  // A request under /assets that express.static didn't resolve is a
  // missing file, never a client-side route — /assets is exclusively
  // Vite's hashed build output. Without this, such requests fall through
  // to the SPA catch-all below and get index.html back under a 200, so a
  // browser that asked for JS/CSS receives HTML and fails with an opaque
  // MIME-type error instead of a plain "it's not there".
  //
  // This is not hypothetical: every deploy changes the content hash in
  // each asset's filename, so any browser still holding the previous
  // index.html requests that build's now-deleted bundle. Diagnosing it
  // from the outside sent one reviewer to entirely the wrong conclusion
  // (a supposed static-middleware ordering bug — the ordering here is in
  // fact correct, which is exactly why the miss reaches the catch-all).
  app.use('/assets', (req, res) => res.sendStatus(404));

  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));

  app.use(errorHandler);

  const server = app.listen(config.PORT, '0.0.0.0', () => {
    logger.info(
      {
        port: config.PORT,
        env: config.NODE_ENV,
        vectorBackend: getBackend(),
        corpusSize: getCorpusSize(),
        checkpointer: isUsingMemoryCheckpointer() ? 'memory (dev)' : 'postgres',
        githubTool: config.hasGithubTool,
      },
      'Server started',
    );
    if (getCorpusSize() === 0) {
      logger.warn('Corpus is empty — run `npm run ingest` (or POST /ingest) before the agent can answer anything.');
    }
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down');
    server.close(async () => {
      await closeDatabase();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref(); // force-exit if connections don't drain in time
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error during boot');
  process.exit(1);
});
