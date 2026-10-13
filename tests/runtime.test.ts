import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { hashPassword } from '../server/auth.js';
test('開発サーバーを起動して日本語UIとAPIを配信する', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'receipt-runtime-'));
  const portServer = createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
  const port = (portServer.address() as AddressInfo).port; await new Promise<void>(resolve => portServer.close(() => resolve()));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/main.ts'], { env: { ...process.env, NODE_ENV: 'development', STORAGE_MODE: 'demo', APP_ORIGIN: `http://localhost:${port}`, PORT: String(port), DATA_DIR: dir, APP_PASSWORD_HASH: hashPassword('runtime-test-password'), SESSION_SECRET: 'runtime-test-secret'.repeat(3) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stopped = once(child, 'exit'); let log = ''; child.stderr.on('data', c => { log += String(c); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`起動タイムアウト: ${log}`)), 15000);
      child.stdout.on('data', c => { if (String(c).includes('領収書台帳:')) { clearTimeout(timeout); resolve(); } });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error(`起動失敗: ${log}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const html = await fetch(base); assert.equal(html.status, 200); assert.match(await html.text(), /領収書台帳/);
    assert.equal((await fetch(base + '/api/bootstrap')).status, 401);
    const source = await fetch(base + '/web/main.tsx'); assert.equal(source.status, 200); assert.match(await source.text(), /内容を確認して発行/);
    const journal = await fetch(base + `/@fs${dir}/operations.sqlite`); assert.equal(journal.status, 403);
  } finally {
    child.kill('SIGTERM'); await Promise.race([stopped, new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000); timer.unref(); })]);
    await rm(dir, { recursive: true, force: true });
  }
});
