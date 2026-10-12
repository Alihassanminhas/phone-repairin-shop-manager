import type { RequestHandler } from 'express';

import { prisma } from '../db/client.js';
import { unauthorized } from '../http/errors.js';
import { verifyAccessToken } from './tokens.js';

export const requireOwner: RequestHandler = async (request, _response, next) => {
  const authorization = request.header('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    next(unauthorized());
    return;
  }
  const token = authorization.slice('Bearer '.length);
  if (!token || token.length > 4096) {
    next(unauthorized());
    return;
  }

  let claims: Awaited<ReturnType<typeof verifyAccessToken>>;
  try {
    claims = await verifyAccessToken(token);
  } catch {
    next(unauthorized());
    return;
  }

  try {
    const session = await prisma.refreshSession.findFirst({
      where: {
        id: claims.sessionId,
        familyId: claims.familyId,
        ownerId: claims.ownerId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        owner: { tokenVersion: claims.tokenVersion },
      },
      select: { id: true },
    });
    if (!session) throw unauthorized();
    request.auth = {
      ownerId: claims.ownerId,
      sessionId: claims.sessionId,
      familyId: claims.familyId,
      tokenVersion: claims.tokenVersion,
    };
    next();
  } catch (error) {
    next(error);
  }
};
