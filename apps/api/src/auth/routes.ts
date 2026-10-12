import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';

import { bootstrapSchema, ownerCredentialsSchema } from '@repair-shop/shared';

import { config } from '../config.js';
import { prisma } from '../db/client.js';
import { asyncHandler } from '../http/async-handler.js';
import { HttpError, unauthorized } from '../http/errors.js';
import { getAuthContext } from '../http/request-context.js';
import { requireOwner } from './middleware.js';
import { consumeAuthBudget } from './rate-limit.js';
import { hashPassword, verifyPassword } from './password.js';
import { createAccessToken, createOpaqueToken, hashOpaqueToken } from './tokens.js';

const loginSchema = ownerCredentialsSchema.extend({ deviceId: z.string().uuid() }).strict();
const bootstrapRequestSchema = bootstrapSchema.extend({ deviceId: z.string().uuid() }).strict();
const refreshSchema = z.object({ refreshToken: z.string().min(32).max(128) }).strict();
const recoverySchema = z.object({
  email: z.email().trim().toLowerCase().max(254),
  recoveryCode: z.string().min(32).max(128),
  newPassword: z.string().min(12).max(128),
}).strict();

const genericCredentialsError = () => new HttpError(401, 'invalid_credentials', 'Email or password was not accepted.');
const DUMMY_HASH_PROMISE = hashPassword(randomUUID());

function clientIp(request: Request): string {
  return request.ip || request.socket.remoteAddress || 'unknown';
}

function matchesSecret(candidate: string, expected: string): boolean {
  const candidateHash = Buffer.from(hashOpaqueToken(candidate), 'hex');
  const expectedHash = Buffer.from(hashOpaqueToken(expected), 'hex');
  return timingSafeEqual(candidateHash, expectedHash);
}

function matchesSecretHash(candidate: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashOpaqueToken(candidate), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

function makeRecoveryCode(): string {
  return createOpaqueToken();
}

function tokenExpiryDate(): Date {
  return new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

type OwnerSummary = { id: string; email: string; shopName: string };

async function createSession(
  database: typeof prisma,
  owner: { id: string; tokenVersion: number },
  deviceId: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const sessionId = randomUUID();
  const familyId = randomUUID();
  const refreshToken = createOpaqueToken();
  await database.refreshSession.create({
    data: {
      id: sessionId,
      ownerId: owner.id,
      familyId,
      deviceId,
      tokenHash: hashOpaqueToken(refreshToken),
      expiresAt: tokenExpiryDate(),
    },
  });
  const accessToken = await createAccessToken({ ownerId: owner.id, sessionId, familyId, tokenVersion: owner.tokenVersion });
  return { accessToken, refreshToken, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS };
}

export const authRouter = Router();

authRouter.get('/bootstrap/status', asyncHandler(async (_request, response) => {
  const ownerExists = await prisma.owner.findUnique({ where: { singleton: 1 }, select: { id: true } });
  response.json({ needsSetup: !ownerExists });
}));

authRouter.post('/bootstrap', asyncHandler(async (request, response) => {
  const input = bootstrapRequestSchema.parse(request.body);
  const ip = clientIp(request);
  const [ipAllowed, accountAllowed] = await Promise.all([
    consumeAuthBudget('bootstrap-ip', ip, 5, 3600),
    consumeAuthBudget('recovery-account', input.email, 5, 3600),
  ]);
  if (!ipAllowed || !accountAllowed) throw new HttpError(429, 'auth_throttled', 'Too many attempts. Try again later.');
  if (!config.BOOTSTRAP_CODE || !matchesSecret(input.bootstrapCode, config.BOOTSTRAP_CODE)) {
    throw new HttpError(404, 'setup_unavailable', 'Secure owner setup is unavailable.');
  }

  const existingOwner = await prisma.owner.findUnique({ where: { singleton: 1 }, select: { id: true } });
  if (existingOwner) throw new HttpError(404, 'setup_unavailable', 'Secure owner setup is unavailable.');

  const recoveryCode = makeRecoveryCode();
  const passwordHash = await hashPassword(input.password);
  try {
    const result = await prisma.$transaction(async (transaction) => {
      const owner = await transaction.owner.create({
        data: {
          singleton: 1,
          email: input.email,
          passwordHash,
          recoveryCodeHash: hashOpaqueToken(recoveryCode),
          shopName: input.shopName,
        },
        select: { id: true, email: true, shopName: true, tokenVersion: true },
      });
      const sessionId = randomUUID();
      const familyId = randomUUID();
      const refreshToken = createOpaqueToken();
      await transaction.refreshSession.create({
        data: { id: sessionId, ownerId: owner.id, familyId, deviceId: input.deviceId, tokenHash: hashOpaqueToken(refreshToken), expiresAt: tokenExpiryDate() },
      });
      await transaction.auditEvent.create({ data: { ownerId: owner.id, eventType: 'owner.bootstrap', metadata: { channel: 'one_time_code' } } });
      const accessToken = await createAccessToken({ ownerId: owner.id, sessionId, familyId, tokenVersion: owner.tokenVersion });
      return { owner: { id: owner.id, email: owner.email, shopName: owner.shopName }, accessToken, refreshToken };
    }, { isolationLevel: 'Serializable' });
    response.status(201).json({ ...result, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS, recoveryCode });
  } catch (error) {
    if (isUniqueConstraintError(error)) throw new HttpError(404, 'setup_unavailable', 'Secure owner setup is unavailable.');
    throw error;
  }
}));

authRouter.post('/login', asyncHandler(async (request, response) => {
  const input = loginSchema.parse(request.body);
  const ip = clientIp(request);
  const [ipAllowed, accountAllowed] = await Promise.all([
    consumeAuthBudget('login-ip', ip, 20, 900),
    consumeAuthBudget('login-account', input.email, 8, 900),
  ]);
  if (!ipAllowed || !accountAllowed) throw new HttpError(429, 'auth_throttled', 'Too many attempts. Try again later.');

  const owner = await prisma.owner.findUnique({
    where: { singleton: 1 },
    select: { id: true, email: true, shopName: true, passwordHash: true, tokenVersion: true },
  });
  const verified = await verifyPassword(input.password, owner?.passwordHash ?? await DUMMY_HASH_PROMISE);
  if (!owner || owner.email !== input.email || !verified) throw genericCredentialsError();

  const pair = await createSession(prisma, owner, input.deviceId);
  await prisma.auditEvent.create({ data: { ownerId: owner.id, eventType: 'owner.login' } });
  response.json({ owner: { id: owner.id, email: owner.email, shopName: owner.shopName }, ...pair });
}));

authRouter.post('/refresh', asyncHandler(async (request, response) => {
  const { refreshToken } = refreshSchema.parse(request.body);
  const tokenHash = hashOpaqueToken(refreshToken);
  const rotated = await prisma.$transaction(async (transaction) => {
    const locked = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "RefreshSession" WHERE "tokenHash" = ${tokenHash} FOR UPDATE
    `;
    const current = locked[0]
      ? await transaction.refreshSession.findUnique({ where: { id: locked[0].id }, include: { owner: true } })
      : null;
    if (!current) return null;

    if (current.revokedAt) {
      await transaction.refreshSession.updateMany({
        where: { ownerId: current.ownerId, familyId: current.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await transaction.auditEvent.create({ data: { ownerId: current.ownerId, eventType: 'owner.refresh_reuse_detected' } });
      return null;
    }
    if (current.expiresAt <= new Date()) {
      await transaction.refreshSession.update({ where: { id: current.id }, data: { revokedAt: new Date() } });
      return null;
    }

    const nextToken = createOpaqueToken();
    const nextHash = hashOpaqueToken(nextToken);
    const nextSessionId = randomUUID();
    await transaction.refreshSession.update({ where: { id: current.id }, data: { revokedAt: new Date(), replacedByHash: nextHash } });
    await transaction.refreshSession.create({
      data: {
        id: nextSessionId,
        ownerId: current.ownerId,
        familyId: current.familyId,
        deviceId: current.deviceId,
        tokenHash: nextHash,
        expiresAt: tokenExpiryDate(),
      },
    });
    const accessToken = await createAccessToken({
      ownerId: current.ownerId,
      sessionId: nextSessionId,
      familyId: current.familyId,
      tokenVersion: current.owner.tokenVersion,
    });
    return { accessToken, refreshToken: nextToken, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS };
  }, { isolationLevel: 'Serializable' });
  if (!rotated) throw unauthorized();
  response.json(rotated);
}));

authRouter.post('/recover', asyncHandler(async (request, response) => {
  const input = recoverySchema.parse(request.body);
  const ip = clientIp(request);
  const [ipAllowed, accountAllowed] = await Promise.all([
    consumeAuthBudget('recovery-ip', ip, 8, 3600),
    consumeAuthBudget('recovery-account', input.email, 5, 3600),
  ]);
  if (!ipAllowed || !accountAllowed) throw new HttpError(429, 'auth_throttled', 'Too many attempts. Try again later.');

  const owner = await prisma.owner.findUnique({ where: { singleton: 1 } });
  const valid = Boolean(owner && owner.email === input.email && matchesSecretHash(input.recoveryCode, owner.recoveryCodeHash));
  if (!valid || !owner) {
    response.status(202).json({ message: 'If the recovery details were valid, the password was reset.' });
    return;
  }

  const nextRecoveryCode = makeRecoveryCode();
  const nextPasswordHash = await hashPassword(input.newPassword);
  const recovered = await prisma.$transaction(async (transaction) => {
    const changed = await transaction.owner.updateMany({
      where: { id: owner.id, recoveryCodeHash: owner.recoveryCodeHash },
      data: {
        passwordHash: nextPasswordHash,
        recoveryCodeHash: hashOpaqueToken(nextRecoveryCode),
        tokenVersion: { increment: 1 },
      },
    });
    if (changed.count !== 1) return false;
    await transaction.refreshSession.updateMany({ where: { ownerId: owner.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await transaction.auditEvent.create({ data: { ownerId: owner.id, eventType: 'owner.password_recovered' } });
    return true;
  }, { isolationLevel: 'Serializable' });
  if (!recovered) {
    response.status(202).json({ message: 'If the recovery details were valid, the password was reset.' });
    return;
  }
  response.status(202).json({ message: 'If the recovery details were valid, the password was reset.', recoveryCode: nextRecoveryCode });
}));

authRouter.get('/me', requireOwner, asyncHandler(async (request, response) => {
  const auth = getAuthContext(request);
  const owner = await prisma.owner.findUnique({ where: { id: auth.ownerId }, select: { id: true, email: true, shopName: true } });
  if (!owner) throw unauthorized();
  response.json({ owner });
}));

authRouter.post('/logout', requireOwner, asyncHandler(async (request, response) => {
  const auth = getAuthContext(request);
  await prisma.refreshSession.updateMany({
    where: { ownerId: auth.ownerId, familyId: auth.familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  response.status(204).end();
}));

authRouter.post('/sessions/revoke-all', requireOwner, asyncHandler(async (request, response) => {
  const auth = getAuthContext(request);
  await prisma.$transaction(async (transaction) => {
    await transaction.owner.update({ where: { id: auth.ownerId }, data: { tokenVersion: { increment: 1 } } });
    await transaction.refreshSession.updateMany({ where: { ownerId: auth.ownerId, revokedAt: null }, data: { revokedAt: new Date() } });
    await transaction.auditEvent.create({ data: { ownerId: auth.ownerId, eventType: 'owner.sessions_revoked' } });
  });
  response.status(204).end();
}));

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
