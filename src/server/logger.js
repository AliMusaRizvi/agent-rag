import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'crypto';
import { config } from './config.js';

export const logger = pino({
  level: config.isProduction ? 'info' : 'debug',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'req.headers.cookie',
      '*.apiKey',
      '*.password',
      '*.token',
    ],
    censor: '[redacted]',
  },
  transport: config.isProduction
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
});

// Every request gets a correlation id. It's echoed back to the client so a
// user can hand it to support without ever seeing a raw stack trace.
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const existing = req.headers['x-request-id'];
    const id = typeof existing === 'string' && existing.length < 128 ? existing : randomUUID();
    res.setHeader('x-request-id', id);
    return id;
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  serializers: {
    req: (req) => ({ method: req.method, url: req.url, id: req.id }),
  },
});
