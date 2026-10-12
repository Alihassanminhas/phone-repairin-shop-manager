import 'dotenv/config';

import { app } from './app.js';
import { assertRuntimeConfiguration, config } from './config.js';
import { prisma } from './db/client.js';

assertRuntimeConfiguration();

await prisma.$connect();
const server = app.listen(config.PORT, '0.0.0.0', (error?: Error) => {
  if (error) {
    console.error(JSON.stringify({ event: 'api.listen_failed', errorType: error.name }));
    process.exitCode = 1;
    return;
  }
  console.info(JSON.stringify({ event: 'api.started', port: config.PORT, environment: config.NODE_ENV }));
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(JSON.stringify({ event: 'api.stopping', signal }));
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15_000).unref();
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
