import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

import { config } from '../config.js';

const ISSUER = 'mobile-repair-shop-api';
const AUDIENCE = 'mobile-repair-shop-mobile';

export type AccessClaims = {
  ownerId: string;
  sessionId: string;
  familyId: string;
  tokenVersion: number;
};

function accessKey(): Uint8Array {
  if (!config.JWT_ACCESS_SECRET) throw new Error('JWT_ACCESS_SECRET is not configured.');
  return new TextEncoder().encode(config.JWT_ACCESS_SECRET);
}

export async function createAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ sid: claims.sessionId, fid: claims.familyId, ver: claims.tokenVersion })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(claims.ownerId)
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(accessKey());
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, accessKey(), {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ['HS256'],
    clockTolerance: 30,
  });
  if (
    typeof payload.sub !== 'string' || typeof payload.sid !== 'string' ||
    typeof payload.fid !== 'string' || typeof payload.ver !== 'number'
  ) throw new Error('Invalid access token claims.');
  return { ownerId: payload.sub, sessionId: payload.sid, familyId: payload.fid, tokenVersion: payload.ver };
}

export function createOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
