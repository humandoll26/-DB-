import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { draftSchema, customerSchema, issuerSchema } from '../shared/domain.js';
import { login, session, verifyPassword } from './auth.js';
import type { Config } from './config.js';
import type { ReceiptService } from './service.js';
export function createApp(config: Config, service: ReceiptService) {
  const app = express(); app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'" + (config.production ? '' : ' ws:') + "; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (config.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store'); next();
  });
  app.use(express.json({ limit: '100kb' }));
  // Cookie認証の全変更APIにOrigin検証を適用。ログインも対象。
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== config.origin) { res.status(403).json({ error: 'アクセス元を確認できません' }); return; } next();
  });
  app.get('/api/session', (req, res) => { const s = session(req, config); res.json({ authenticated: !!s, csrf: s?.csrf, mode: config.mode }); });
  let failures = 0; let resetAt = 0;
  app.post('/api/login', (req, res) => {
    if (Date.now() > resetAt) { failures = 0; resetAt = Date.now() + 15 * 60000; }
    if (failures >= 5) { res.status(429).json({ error: '試行回数を超えました。15分後に再試行してください' }); return; }
    const password = z.string().min(1).max(1024).parse(req.body.password);
    if (!verifyPassword(password, config.passwordHash)) { failures++; res.status(401).json({ error: 'パスワードが違います' }); return; }
    res.json({ csrf: login(res, config) });
  });
  app.use('/api', (req, res, next) => {
    const s = session(req, config); if (!s) { res.status(401).json({ error: 'ログインしてください' }); return; }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-csrf-token'] !== s.csrf) { res.status(403).json({ error: '再ログインしてください' }); return; } next();
  });
  app.post('/api/logout', (_req, res) => { res.clearCookie('receipt_session', { path: '/', httpOnly: true, sameSite: 'strict', secure: config.production }); res.json({ ok: true }); });
  app.get('/api/bootstrap', async (_req, res) => { res.json({ issuer: await service.repo.issuer(), customers: await service.repo.customers(), receipts: await service.repo.list(), mode: config.mode, auditPending: service.journal.pendingEvents().length, pendingJobs: service.journal.pendingJobs() }); });
  app.get('/api/check', async (_req, res) => { res.json(await service.repo.check()); });
  app.put('/api/issuer', async (req, res) => { const i = issuerSchema.parse(req.body); await service.serial(() => service.repo.saveIssuer(i)); res.json(i); });
  app.post('/api/customers', async (req, res) => { const c = customerSchema.parse(req.body); res.json(await service.serial(() => service.repo.addCustomer(c))); });
  app.post('/api/receipts', async (req, res) => {
    const body = z.object({ draft: draftSchema, id: z.uuid().optional(), version: z.string().optional(), issuanceId: z.uuid() }).parse(req.body);
    res.json(await service.saveDraft(body.draft, body.id, body.version, body.issuanceId));
  });
  app.get('/api/receipts/:id/preview', async (req, res) => { res.json(await service.preview(z.uuid().parse(req.params.id))); });
  app.post('/api/receipts/:id/issue', async (req, res) => { const body = z.object({ version: z.string(), issuerVersion: z.string(), confirmed: z.literal(true) }).parse(req.body); res.json(await service.issue(z.uuid().parse(req.params.id), body.version, body.issuerVersion)); });
  app.post('/api/receipts/:id/cancel', async (req, res) => { const body = z.object({ version: z.string(), reason: z.string().trim().min(1).max(500) }).parse(req.body); res.json(await service.cancel(z.uuid().parse(req.params.id), body.reason, body.version)); });
  app.get('/api/receipts/:id/pdf', async (req, res) => { const { bytes, number } = await service.download(z.uuid().parse(req.params.id)); res.type('application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="receipt-${number}.pdf"`); res.send(Buffer.from(bytes)); });
  app.post('/api/retry-audit', async (_req, res) => { await service.serial(() => service.flush()); res.json({ pending: service.journal.pendingEvents().length }); });
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'APIが見つかりません' }); });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(' / ') : error instanceof Error ? error.message : '処理に失敗しました';
    res.status(400).json({ error: message });
  });
  return app;
}
