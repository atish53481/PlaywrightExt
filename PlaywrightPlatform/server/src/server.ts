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
  const app = await buildApp({ config, db });

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
