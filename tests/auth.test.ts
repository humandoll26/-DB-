import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { hashPassword, verifyPassword } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { fixture, draft } from './fixtures.js';
test('パスワードをハッシュ照合し、誤ったパスワードを拒否する', () => { const hash = hashPassword('long-test-password'); assert.equal(verifyPassword('long-test-password', hash), true); assert.equal(verifyPassword('incorrect', hash), false); });
test('本番はデモ・HTTP・秘密情報未設定で起動しない', () => {
  assert.throws(() => readConfig({ NODE_ENV: 'production', STORAGE_MODE: 'demo' }), /デモ/);
  assert.throws(() => readConfig({ NODE_ENV: 'production', STORAGE_MODE: 'notion', APP_ORIGIN: 'http://localhost:3000' }), /HTTPS/);
  assert.throws(() => readConfig({ STORAGE_MODE: 'demo' }), /PASSWORD/);
});
test('未認証API・異なるOrigin・CSRFなし・Cookie改変を拒否する', async () => {
  const f = await fixture(async () => new Uint8Array([1]));
  const config = readConfig({ STORAGE_MODE: 'demo', APP_ORIGIN: 'http://localhost:3000', APP_PASSWORD_HASH: hashPassword('long-test-password'), SESSION_SECRET: 'x'.repeat(40), DATA_DIR: f.dir });
  const server = createApp(config, f.service).listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (url: string, options: RequestInit = {}) => fetch(base + '/api' + url, options);
  try {
    assert.equal((await request('/bootstrap')).status, 401);
    assert.equal((await request('/login', { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'long-test-password' }) })).status, 403);
    const login = await request('/login', { method: 'POST', headers: { Origin: config.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'long-test-password' }) });
    assert.equal(login.status, 200); const csrf = (await login.json()).csrf; const cookie = login.headers.get('set-cookie')!.split(';')[0];
    assert.match(login.headers.get('set-cookie')!, /HttpOnly/); assert.match(login.headers.get('set-cookie')!, /SameSite=Strict/);
    assert.equal((await request('/bootstrap', { headers: { Cookie: cookie } })).status, 200);
    const body = JSON.stringify(draft);
    assert.equal((await request('/issuer', { method: 'PUT', headers: { Origin: config.origin, Cookie: cookie, 'Content-Type': 'application/json' }, body })).status, 403);
    assert.equal((await request('/bootstrap', { headers: { Cookie: cookie + 'bad' } })).status, 401);
    assert.equal((await request('/issuer', { method: 'PUT', headers: { Origin: config.origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body })).status, 400);
    assert.equal((await request('/bootstrap', { headers: { Cookie: cookie } })).headers.get('cache-control'), 'no-store');
  } finally { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); await f.close(); }
});
