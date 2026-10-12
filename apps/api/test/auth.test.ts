import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { hashPassword, verifyPassword } from '../src/auth/password.js';

test('scrypt password hash verifies without storing the plaintext', async () => {
  const password = 'shop-owner-strong-passphrase';
  const encodedHash = await hashPassword(password);
  assert.notEqual(encodedHash, password);
  assert.match(encodedHash, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword(password, encodedHash), true);
  assert.equal(await verifyPassword('wrong-passphrase', encodedHash), false);
});

test('opaque refresh tokens are random, and only their digest is stored', async () => {
  process.env.JWT_ACCESS_SECRET = 'test-only-secret-at-least-thirty-two-bytes';
  process.env.RATE_LIMIT_HASH_SECRET = 'test-rate-limit-secret-at-least-thirty-two-bytes';
  process.env.ACCESS_TOKEN_TTL_SECONDS = '300';
  const { createOpaqueToken, hashOpaqueToken } = await import('../src/auth/tokens.js');
  const first = createOpaqueToken();
  const second = createOpaqueToken();
  assert.equal(first.length, 43);
  assert.notEqual(first, second);
  assert.equal(hashOpaqueToken(first).length, 64);
  assert.notEqual(hashOpaqueToken(first), first);
});

test('access tokens carry the owner, session, family and version claims', async () => {
  process.env.JWT_ACCESS_SECRET = 'test-only-secret-at-least-thirty-two-bytes';
  process.env.RATE_LIMIT_HASH_SECRET = 'test-rate-limit-secret-at-least-thirty-two-bytes';
  process.env.ACCESS_TOKEN_TTL_SECONDS = '300';
  const { createAccessToken, verifyAccessToken } = await import('../src/auth/tokens.js');
  const input = { ownerId: randomUUID(), sessionId: randomUUID(), familyId: randomUUID(), tokenVersion: 2 };
  const token = await createAccessToken(input);
  assert.deepEqual(await verifyAccessToken(token), input);
  await assert.rejects(verifyAccessToken('not-a-jwt'));
});
