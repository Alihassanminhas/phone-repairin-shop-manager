import type { Request } from 'express';

export type AuthenticatedContext = {
  ownerId: string;
  sessionId: string;
  familyId: string;
  tokenVersion: number;
};

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthenticatedContext;
    }
  }
}

export function getAuthContext(request: Request): AuthenticatedContext {
  if (!request.auth) throw new Error('Authenticated request context is missing.');
  return request.auth;
}
