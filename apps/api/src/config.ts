import { z } from 'zod';

const optionalUrl = z.preprocess((value) => value === '' ? undefined : value, z.string().url().optional());
const optionalSecret = (minimumLength: number) => z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().min(minimumLength).optional(),
);

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  DATABASE_URL: optionalUrl,
  DIRECT_URL: optionalUrl,
  JWT_ACCESS_SECRET: optionalSecret(32),
  RATE_LIMIT_HASH_SECRET: optionalSecret(32),
  BOOTSTRAP_CODE: optionalSecret(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(1800).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(8).default(0),
});

const parsedEnvironment = environmentSchema.parse(process.env);

export const config = {
  ...parsedEnvironment,
  corsOrigins: parsedEnvironment.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
};

export type RuntimeConfig = typeof config;

export function assertRuntimeConfiguration(): void {
  const missing: string[] = [];
  if (!config.DATABASE_URL) missing.push('DATABASE_URL');
  if (!config.JWT_ACCESS_SECRET) missing.push('JWT_ACCESS_SECRET');
  if (!config.RATE_LIMIT_HASH_SECRET) missing.push('RATE_LIMIT_HASH_SECRET');
  if (missing.length > 0) throw new Error(`Missing required API configuration: ${missing.join(', ')}`);
  if (config.NODE_ENV === 'production' && !config.DIRECT_URL) {
    throw new Error('DIRECT_URL is required in production for controlled Prisma migrations.');
  }
}
