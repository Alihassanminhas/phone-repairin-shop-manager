import type { RequestHandler } from 'express';

/** Wraps handlers so async errors are forwarded consistently across Express versions. */
export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}
