import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildApp } from './app';
import { ConfigError, loadConfig, loadEnvFile } from './config';
import { createDb } from './db';

async function main(): Promise<void> {
  loadEnvFile();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const db = createDb(config.databaseUrl);
  // Resolves to PlaywrightPlatform/web/dist from both src/ (tsx) and dist/ (node).
  const builtWeb = path.resolve(__dirname, '../../web/dist');
  const serveWeb = config.nodeEnv === 'production' && existsSync(path.join(builtWeb, 'index.html'));
  const app = await buildApp({ config, db, webRoot: serveWeb ? builtWeb : undefined });

  const shutdown = async () => {
    await app.close();
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
