import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const CURRENT_N = 32_768;
const CURRENT_R = 8;
const CURRENT_P = 1;
const KEY_BYTES = 32;
const MAX_MEMORY = 64 * 1024 * 1024;

function deriveKey(password: string, salt: Buffer, cost: number, blockSize: number, parallelism: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, KEY_BYTES, {
      N: cost,
      r: blockSize,
      p: parallelism,
      maxmem: MAX_MEMORY,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey as Buffer);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, CURRENT_N, CURRENT_R, CURRENT_P);
  return `scrypt$${CURRENT_N}$${CURRENT_R}$${CURRENT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const [algorithm, costValue, blockValue, parallelValue, saltValue, keyValue, extra] = encodedHash.split('$');
  const cost = Number(costValue);
  const blockSize = Number(blockValue);
  const parallelism = Number(parallelValue);
  if (
    algorithm !== 'scrypt' || extra !== undefined ||
    !Number.isInteger(cost) || cost < 16_384 || cost > CURRENT_N ||
    !Number.isInteger(blockSize) || blockSize < 1 || blockSize > CURRENT_R ||
    !Number.isInteger(parallelism) || parallelism < 1 || parallelism > CURRENT_P ||
    !saltValue || !keyValue
  ) return false;

  try {
    const salt = Buffer.from(saltValue, 'base64url');
    const expected = Buffer.from(keyValue, 'base64url');
    if (salt.length !== 16 || expected.length !== KEY_BYTES) return false;
    const actual = await deriveKey(password, salt, cost, blockSize, parallelism);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
