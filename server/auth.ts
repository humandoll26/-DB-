import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Config } from './config.js';
export const hashPassword = (password: string, salt = randomBytes(16).toString('hex')) => `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
export function verifyPassword(password: string, hash: string) {
  if (password.length > 1024) return false;
  const [salt, expected] = hash.split(':');
  const actual = scryptSync(password, salt, 64);
  const bytes = Buffer.from(expected ?? '', 'hex');
  return bytes.length === actual.length && timingSafeEqual(bytes, actual);
}
const sign = (v: string, secret: string) => createHmac('sha256', secret).update(v).digest('hex');
export function session(req: Request, config: Config): { csrf: string } | null {
  const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('receipt_session='))?.slice(16);
  if (!token) return null;
  const [body, signature] = token.split('.');
  const expected = sign(body, config.sessionSecret);
  if (!signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    return data.exp > Date.now() && typeof data.csrf === 'string' ? { csrf: data.csrf } : null;
  } catch { return null; }
}
export function login(res: Response, config: Config) {
  const csrf = randomBytes(24).toString('hex');
  const body = Buffer.from(JSON.stringify({ csrf, exp: Date.now() + 8 * 3600000 })).toString('base64url');
  res.cookie('receipt_session', `${body}.${sign(body, config.sessionSecret)}`, { httpOnly: true, secure: config.production, sameSite: 'strict', path: '/', maxAge: 8 * 3600000 });
  return csrf;
}
