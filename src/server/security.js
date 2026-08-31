import crypto from 'crypto';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from './config.js';

// --- CORS: explicit allowlist, not app.use(cors()) open-to-the-world. ---
export const corsMiddleware = cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true); // same-origin / curl / server-to-server health checks
    if (config.allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`Origin ${origin} is not allowed`));
  },
  credentials: true,
});

// --- Security headers. connect-src 'self' is enough because the frontend
// only ever calls this same origin's API. ---
export const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
});

// --- Rate limits. Memory store is fine for a single instance; note in
// README that a multi-instance deployment needs a shared store (Redis). ---
export const chatLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages — please slow down and try again in a minute.' },
});

export const uploadLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many uploads — please wait a minute before uploading again.' },
});

export const generalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// --- Auth: a shared-secret gate appropriate for a single-tenant portfolio
// deployment (there is no multi-user account system in scope here). Real
// per-user auth is the natural next step for a production, multi-tenant
// build — see README "known limitations". ---
export function requireApiKey(req, res, next) {
  if (!config.API_KEY) {
    if (config.isProduction) {
      // config.js already refuses to boot in production without API_KEY;
      // this branch only exists as defense in depth.
      return res.status(503).json({ error: 'Server misconfigured: no API key set.' });
    }
    return next(); // dev mode without an API key configured — allowed, loudly logged once at boot
  }
  const provided = req.headers['x-api-key'];
  if (provided !== config.API_KEY) {
    return res.status(401).json({ error: 'Missing or invalid API key. Send it as the x-api-key header.' });
  }
  return next();
}

// --- Session id: an anonymous, first-party cookie used only to scope rate
// limiting and the daily token budget per browser — not an identity system. ---
const SESSION_COOKIE = 'eka_sid';

function sign(value) {
  return crypto.createHmac('sha256', config.SESSION_SECRET).update(value).digest('hex');
}

export function sessionMiddleware(req, res, next) {
  const raw = req.cookies?.[SESSION_COOKIE];
  let sessionId = null;
  if (raw) {
    const [id, sig] = raw.split('.');
    if (id && sig && sign(id) === sig) sessionId = id;
  }
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    const cookieValue = `${sessionId}.${sign(sessionId)}`;
    res.cookie(SESSION_COOKIE, cookieValue, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }
  req.sessionId = sessionId;
  next();
}

// --- Input validation ---
export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Invalid request body',
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    req.body = result.data;
    next();
  };
}

export const chatBodySchema = z.object({
  message: z.string().min(1).max(config.MAX_MESSAGE_LENGTH),
  thread_id: z.string().uuid().optional(),
  model: z.string().max(40).optional(),
  persona: z.enum(['concise', 'formal', 'creative']).optional(),
  systemPrompt: z.string().max(config.MAX_SYSTEM_PROMPT_LENGTH).optional(),
}).strict();

export const approveBodySchema = z.object({
  thread_id: z.string().uuid(),
  approved: z.boolean(),
}).strict();

export const feedbackBodySchema = z.object({
  thread_id: z.string().uuid(),
  message_id: z.string().min(1).max(100),
  rating: z.enum(['up', 'down']).nullable(),
  answer: z.string().max(20_000).optional(),
  citations: z.array(z.any()).max(50).optional(),
}).strict();

// --- Error handling: never leak upstream provider bodies or stack traces
// to the client. Full detail goes to the logger with the request id. ---
export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Not found' });
}

// Express recognizes this as error-handling middleware by its arity (4
// params) — `next` must stay in the signature even though it's never
// called, or Express treats this as a normal (3-arg) middleware instead.
export function errorHandler(err, req, res, next) {
  req.log?.error({ err }, 'Unhandled request error');
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: config.isProduction ? 'Something went wrong on our end.' : err.message,
    requestId: req.id,
  });
}

export function wrapAsync(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
