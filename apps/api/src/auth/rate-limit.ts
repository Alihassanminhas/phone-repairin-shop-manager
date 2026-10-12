import { createHmac } from 'node:crypto';

import { prisma } from '../db/client.js';
import { config } from '../config.js';

/** Uses Postgres so auth throttles survive restarts and are shared by API instances. */
export async function consumeAuthBudget(
  bucket: 'bootstrap-ip' | 'login-ip' | 'login-account' | 'recovery-ip' | 'recovery-account',
  identity: string,
  maximumHits: number,
  windowSeconds: number,
): Promise<boolean> {
  if (!config.RATE_LIMIT_HASH_SECRET) throw new Error('RATE_LIMIT_HASH_SECRET is not configured.');
  const key = createHmac('sha256', config.RATE_LIMIT_HASH_SECRET)
    .update(`${bucket}:${identity.trim().toLowerCase()}`)
    .digest('hex');
  const rows = await prisma.$queryRaw<Array<{ hitCount: number }>>`
    INSERT INTO "AuthRateLimit" ("bucketKey", "hitCount", "windowStart", "expiresAt")
    VALUES (${key}, 1, NOW(), NOW() + (${windowSeconds} * INTERVAL '1 second'))
    ON CONFLICT ("bucketKey") DO UPDATE SET
      "hitCount" = CASE
        WHEN "AuthRateLimit"."expiresAt" <= NOW() THEN 1
        ELSE "AuthRateLimit"."hitCount" + 1
      END,
      "windowStart" = CASE
        WHEN "AuthRateLimit"."expiresAt" <= NOW() THEN NOW()
        ELSE "AuthRateLimit"."windowStart"
      END,
      "expiresAt" = CASE
        WHEN "AuthRateLimit"."expiresAt" <= NOW() THEN NOW() + (${windowSeconds} * INTERVAL '1 second')
        ELSE "AuthRateLimit"."expiresAt"
      END
    RETURNING "hitCount"
  `;
  return (rows[0]?.hitCount ?? maximumHits + 1) <= maximumHits;
}
