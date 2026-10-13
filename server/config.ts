import path from 'node:path';
export type Config = ReturnType<typeof readConfig>;
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === 'production';
  const mode = env.STORAGE_MODE ?? 'notion';
  if (!['demo', 'notion'].includes(mode)) throw new Error('STORAGE_MODEはdemoまたはnotionです');
  if (production && mode !== 'notion') throw new Error('本番環境ではデモ保存を使用できません');
  const origin = env.APP_ORIGIN ?? 'http://localhost:3000';
  const url = new URL(origin);
  if (origin !== url.origin || (production && url.protocol !== 'https:')) throw new Error('APP_ORIGINは本番でHTTPSのオリジンを指定してください');
  const ids = { receipts: env.NOTION_RECEIPTS_DATA_SOURCE_ID ?? '', customers: env.NOTION_CUSTOMERS_DATA_SOURCE_ID ?? '', issuer: env.NOTION_ISSUER_DATA_SOURCE_ID ?? '', audit: env.NOTION_AUDIT_DATA_SOURCE_ID ?? '' };
  if (!env.APP_PASSWORD_HASH || !/^\w+:[a-f0-9]{128}$/.test(env.APP_PASSWORD_HASH)) throw new Error('npm run passwordでAPP_PASSWORD_HASHを生成してください');
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRETは32文字以上必要です');
  if (mode === 'notion' && (!env.NOTION_TOKEN || Object.values(ids).some(v => !/^[a-f0-9-]{32,36}$/i.test(v)))) throw new Error('Notionトークンと4つのdata source IDを設定してください');
  return { production, mode: mode as 'demo' | 'notion', origin, ids, token: env.NOTION_TOKEN ?? '', passwordHash: env.APP_PASSWORD_HASH, sessionSecret: env.SESSION_SECRET, dataDir: path.resolve(env.DATA_DIR ?? '.data'), port: Number(env.PORT ?? 3000) };
}
