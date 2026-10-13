import express from 'express';
import path from 'node:path';
import { readConfig } from './config.js';
import { acquireInstance, Journal } from './journal.js';
import { DemoRepository, NotionRepository } from './repository.js';
import { ReceiptService } from './service.js';
import { createApp } from './app.js';
const config = readConfig();
const release = acquireInstance(config.dataDir);
const journal = new Journal(config.dataDir);
const repo = config.mode === 'demo' ? new DemoRepository(config.dataDir) : new NotionRepository(config);
const service = new ReceiptService(repo, journal);
const app = createApp(config, service);
if (config.production) {
  app.use(express.static(path.resolve('dist'), { index: false }));
  app.get('/{*path}', (_req, res) => res.sendFile(path.resolve('dist/index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' }); app.use(vite.middlewares);
}
const server = app.listen(config.port, config.production ? '0.0.0.0' : '127.0.0.1', () => console.log(`領収書台帳: ${config.origin} (${config.mode})`));
const interval = setInterval(() => { void service.serial(() => service.flush()).catch(() => {}); }, 60000); interval.unref();
process.on('exit', release);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { clearInterval(interval); server.close(() => { journal.close(); release(); process.exit(0); }); });
