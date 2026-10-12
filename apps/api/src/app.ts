import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { ZodError } from 'zod';

import { config } from './config.js';
import { prisma } from './db/client.js';
import { HttpError } from './http/errors.js';
import { authRouter } from './auth/routes.js';
import { customerRouter } from './records/customer-routes.js';
import { repairRouter } from './records/repair-routes.js';
import { syncRouter } from './sync/routes.js';

export const app = express();

app.disable('x-powered-by');
app.set('trust proxy', config.TRUST_PROXY_HOPS);
app.use((request, response, next) => {
  request.requestId = randomUUID();
  response.setHeader('x-request-id', request.requestId);
  response.setHeader('cache-control', 'no-store');
  next();
});
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }));
app.use(cors({
  credentials: false,
  origin(origin, callback) {
    if (!origin || config.corsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new HttpError(403, 'origin_not_allowed', 'This origin is not allowed.'));
  },
}));
app.use(express.json({ limit: '2mb', strict: true }));

app.get('/health/live', (_request, response) => response.status(200).json({ status: 'ok' }));
app.get('/health/ready', async (_request, response, next) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    response.status(200).json({ status: 'ready' });
  } catch (error) {
    next(error);
  }
});

app.use('/v1/auth', authRouter);
app.use('/v1/sync', syncRouter);
app.use('/v1/customers', customerRouter);
app.use('/v1/repairs', repairRouter);
app.use('/v1', repairRouter);
app.use('/v1', (_request, _response, next) => next(new HttpError(404, 'route_not_found', 'The requested endpoint was not found.')));

const errorHandler: ErrorRequestHandler = (error: unknown, request, response, _next) => {
  if (response.headersSent) return;
  if (error instanceof ZodError) {
    response.status(400).json({
      error: { code: 'invalid_request', message: 'Check the submitted fields.', fields: error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })) },
      requestId: request.requestId,
    });
    return;
  }
  if (error instanceof HttpError) {
    response.status(error.statusCode).json({ error: { code: error.code, message: error.message }, requestId: request.requestId });
    return;
  }
  if (isBodyLimitError(error)) {
    response.status(413).json({ error: { code: 'request_too_large', message: 'The request is too large.' }, requestId: request.requestId });
    return;
  }

  // Error details and request contents may include credentials or customer data.
  console.error(JSON.stringify({ event: 'api.request_failed', requestId: request.requestId, errorType: error instanceof Error ? error.name : 'UnknownError' }));
  response.status(500).json({ error: { code: 'internal_error', message: 'The request could not be completed.' }, requestId: request.requestId });
};
app.use(errorHandler);

function isBodyLimitError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large';
}
