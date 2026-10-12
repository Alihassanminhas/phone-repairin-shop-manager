import { PrismaNeon } from '@prisma/adapter-neon';
import { PrismaClient } from '../generated/prisma/client.js';

import { config } from '../config.js';

const connectionString = config.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required to connect to PostgreSQL.');

const adapter = new PrismaNeon({ connectionString });
export const prisma = new PrismaClient({ adapter });
