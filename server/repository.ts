import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { Customer, Draft, Issuer, Receipt, Snapshot } from '../shared/domain.js';
import { calculate, draftSchema, issuerSchema } from '../shared/domain.js';
import { z } from 'zod';
import type { Config } from './config.js';
export type Event = { id: string; receiptId: string; type: string; summary: string; at: string };
export interface Repository {
  list(): Promise<Receipt[]>;
  get(id: string): Promise<Receipt>;
  find(issuanceId: string): Promise<Receipt | undefined>;
  save(receipt: Receipt): Promise<Receipt>;
  attachPdf(id: string, bytes: Uint8Array): Promise<void>;
  pdf(id: string): Promise<Uint8Array>;
  customers(): Promise<Customer[]>;
  addCustomer(customer: Omit<Customer, 'id'>): Promise<Customer>;
  issuer(): Promise<Issuer | null>;
  saveIssuer(issuer: Issuer): Promise<void>;
  audit(event: Event): Promise<void>;
  check(): Promise<unknown>;
}
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const pdfDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function receiptVersion(r: Receipt) { return digest({ issuanceId: r.issuanceId, number: r.number, draft: r.draft, status: r.status, snapshot: r.snapshot, pdfHash: r.pdfHash, cancelReason: r.cancelReason }); }
type DemoData = { receipts: Receipt[]; customers: Customer[]; issuer: Issuer | null; events: Event[] };
export class DemoRepository implements Repository {
  constructor(private dir: string) {}
  private async read(): Promise<DemoData> {
    try { return JSON.parse(await readFile(path.join(this.dir, 'demo.json'), 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return { receipts: [], customers: [], issuer: null, events: [] }; }
  }
  private async write(data: DemoData) { await mkdir(this.dir, { recursive: true, mode: 0o700 }); const p = path.join(this.dir, 'demo.json'); await writeFile(p + '.tmp', JSON.stringify(data), { mode: 0o600 }); await rename(p + '.tmp', p); }
  async list() { return (await this.read()).receipts; }
  async get(id: string) { const r = (await this.list()).find(r => r.id === id); if (!r) throw new Error('領収書が見つかりません'); return r; }
  async find(id: string) { return (await this.list()).find(r => r.issuanceId === id); }
  async save(r: Receipt) { const data = await this.read(); r = { ...r, id: r.id || randomUUID(), version: receiptVersion(r) }; const i = data.receipts.findIndex(v => v.id === r.id); if (i < 0) data.receipts.push(r); else data.receipts[i] = r; await this.write(data); return r; }
  async attachPdf(id: string, bytes: Uint8Array) { await mkdir(this.dir, { recursive: true, mode: 0o700 }); await writeFile(path.join(this.dir, `${id}.pdf`), bytes, { mode: 0o600 }); }
  async pdf(id: string) { await this.get(id); return new Uint8Array(await readFile(path.join(this.dir, `${id}.pdf`))); }
  async customers() { return (await this.read()).customers; }
  async addCustomer(c: Omit<Customer, 'id'>) { const d = await this.read(); const customer = { ...c, id: randomUUID() }; d.customers.push(customer); await this.write(d); return customer; }
  async issuer() { return (await this.read()).issuer; }
  async saveIssuer(i: Issuer) { const d = await this.read(); d.issuer = i; await this.write(d); }
  async audit(e: Event) { const d = await this.read(); if (!d.events.some(v => v.id === e.id)) d.events.push(e); await this.write(d); }
  async check() { return { mode: 'demo', ok: true }; }
}

type Page = { id: string; url?: string; parent?: { data_source_id?: string }; properties: Record<string, any>; in_trash?: boolean; archived?: boolean };
const rich = (v: string) => ({ rich_text: [{ type: 'text', text: { content: v } }] });
const title = (v: string) => ({ title: [{ type: 'text', text: { content: v } }] });
const select = (name: string) => ({ select: { name } });
const num = (n: number) => ({ number: n });
const txt = (p: Page, key: string) => (p.properties[key]?.rich_text ?? p.properties[key]?.title ?? []).map((v: any) => v.plain_text ?? v.text?.content ?? '').join('');
export const requiredSchemas: Record<keyof Config['ids'], Record<string, string>> = {
  receipts: { 名称: 'title', 発行ID: 'rich_text', 発行番号: 'rich_text', 取引先: 'relation', 取引日: 'date', 発行日: 'date', 書式: 'select', ステータス: 'select', 合計金額: 'number', 但し書き: 'rich_text', 支払方法: 'select', PDF原本: 'files', 確定データJSON: 'files', 原本ハッシュ: 'rich_text', 取消理由: 'rich_text', 元書類: 'relation', ...Object.fromEntries([10, 8, 1].flatMap(r => [`${r}％対象税込額`, `${r}％対象税抜額`, `${r}％消費税額`]).concat(['非課税額', '免税等額']).map(v => [v, 'number'])) },
  customers: { 名称: 'title', 敬称: 'select', 住所: 'rich_text', 連絡先: 'rich_text', 備考: 'rich_text' },
  issuer: { 名称: 'title', 住所: 'rich_text', 登録番号: 'rich_text', 連絡先: 'rich_text', 番号接頭辞: 'rich_text', 既定税区分: 'select', 税計算方式: 'select', 端数処理: 'select' },
  audit: { 名称: 'title', 対象領収書: 'relation', 操作種別: 'select', 操作者: 'rich_text', 操作日時: 'date', 変更概要: 'rich_text', 操作ID: 'rich_text' },
};
export class NotionRepository implements Repository {
  private nextRequest = 0;
  constructor(private config: Pick<Config, 'token' | 'ids'>, private transport: typeof fetch = fetch, private requestSpacing = 350) {}
  private async api(endpoint: string, method = 'GET', body?: unknown) {
    const wait = Math.max(0, this.nextRequest - Date.now());
    this.nextRequest = Math.max(this.nextRequest, Date.now()) + this.requestSpacing;
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    const response = await this.transport(`https://api.notion.com/v1/${endpoint}`, {
      method, headers: { Authorization: `Bearer ${this.config.token}`, 'Notion-Version': '2025-09-03', ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    // POST作成の通信失敗を自動再送しない。呼び出し元が発行ID等で照合する。
    if (!response.ok) throw new Error(`Notion接続エラー (${response.status})。権限・DB設定を確認して再試行してください`);
    return response.json();
  }
  private async query(kind: keyof Config['ids'], filter?: unknown): Promise<Page[]> {
    const results: Page[] = []; let cursor: string | undefined;
    do { const page = await this.api(`data_sources/${this.config.ids[kind]}/query`, 'POST', { page_size: 100, ...(filter ? { filter } : {}), ...(cursor ? { start_cursor: cursor } : {}) }); results.push(...page.results); cursor = page.has_more ? page.next_cursor : undefined; } while (cursor);
    return results;
  }
  private async owned(id: string, kind: keyof Config['ids']) {
    const p: Page = await this.api(`pages/${id}`);
    if (p.parent?.data_source_id?.replaceAll('-', '') !== this.config.ids[kind].replaceAll('-', '') || p.in_trash || p.archived) throw new Error('対象データへのアクセスを拒否しました');
    return p;
  }
  private async upload(bytes: Uint8Array, name: string, mime: string) {
    if (bytes.length > 5 * 1024 * 1024) throw new Error('ファイルが5MiBを超えています。容量を確認してください');
    const upload = await this.api('file_uploads', 'POST', { mode: 'single_part', filename: name, content_type: mime });
    const form = new FormData(); form.set('file', new Blob([Buffer.from(bytes)], { type: mime }), name);
    await this.api(`file_uploads/${upload.id}/send`, 'POST', form);
    return { type: 'file_upload', file_upload: { id: upload.id }, name };
  }
  private async download(p: Page, property: string, max = 5 * 1024 * 1024) {
    const file = p.properties[property]?.files?.[0];
    if (file?.type !== 'file' || !file.file?.url) throw new Error(`${property}が保存されていません`);
    const url = new URL(file.file.url);
    const allowed = ['secure.notion-static.com', 'prod-files-secure.s3.us-west-2.amazonaws.com', 's3.us-west-2.amazonaws.com', 'attachment.notion.so'];
    if (url.protocol !== 'https:' || !allowed.includes(url.hostname) || url.username || url.password) throw new Error('Notion保管ファイル以外は取得できません');
    const response = await this.transport(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok || !response.body) throw new Error('Notionファイルを取得できません');
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) { size += chunk.length; if (size > max) throw new Error('ファイル容量が上限を超えています'); chunks.push(chunk); }
    return new Uint8Array(Buffer.concat(chunks));
  }
  private async fromPage(p: Page): Promise<Receipt> {
    const bytes = await this.download(p, '確定データJSON', 100000);
    const data = JSON.parse(Buffer.from(bytes).toString('utf8'));
    const issuanceId = z.uuid().parse(txt(p, '発行ID'));
    if (data.schemaVersion !== 1 || data.issuanceId !== issuanceId) throw new Error('台帳とJSONの発行IDが一致しません');
    const draft = draftSchema.parse(data.draft);
    const status = p.properties['ステータス']?.select?.name;
    if (!['下書き', '発行処理中', '発行済み', '発行失敗', '取消'].includes(status)) throw new Error('台帳のステータスが不正です');
    const number = txt(p, '発行番号');
    if (number && !/^[A-Za-z0-9-]{6,60}$/.test(number)) throw new Error('台帳の発行番号が不正です');
    if (data.snapshot) {
      issuerSchema.parse(data.snapshot.issuer);
      const snapDraft = draftSchema.parse(data.snapshot.draft);
      if (digest(snapDraft) !== digest(draft) || digest(calculate(snapDraft)) !== digest(data.snapshot.totals) || data.snapshot.number !== number || !Number.isFinite(Date.parse(data.snapshot.issuedAt))) throw new Error('確定スナップショットに不整合があります');
    }
    if (['発行済み', '取消'].includes(status) && (!data.snapshot || !/^[a-f0-9]{64}$/.test(txt(p, '原本ハッシュ')))) throw new Error('確定データまたは原本ハッシュがありません');
    const r: Receipt = { id: p.id, issuanceId, version: '', status, number, draft, snapshot: data.snapshot, pdfHash: txt(p, '原本ハッシュ'), cancelReason: txt(p, '取消理由'), url: p.url };
    r.version = receiptVersion(r); return r;
  }
  async list() { const pages = await this.query('receipts'); const records: Receipt[] = []; for (const p of pages) records.push(await this.fromPage(p)); return records; }
  async get(id: string) { return this.fromPage(await this.owned(id, 'receipts')); }
  async find(id: string) { const p = await this.query('receipts', { property: '発行ID', rich_text: { equals: id } }); if (p.length > 1) throw new Error('発行IDの重複が検出されました。台帳を確認してください'); return p[0] ? this.fromPage(p[0]) : undefined; }
  async save(r: Receipt) {
    if (r.id) await this.owned(r.id, 'receipts');
    if (r.draft.customerId) await this.owned(r.draft.customerId, 'customers');
    if (r.draft.originalId) await this.owned(r.draft.originalId, 'receipts');
    const json = Buffer.from(JSON.stringify({ schemaVersion: 1, issuanceId: r.issuanceId, draft: r.draft, snapshot: r.snapshot }));
    const attachment = await this.upload(json, `${r.issuanceId}.json`, 'application/json');
    const totals = r.snapshot?.totals ?? calculate(r.draft);
    const properties: Record<string, unknown> = {
      名称: title(r.number || `${r.draft.customerName}｜下書き`), 発行ID: rich(r.issuanceId), 発行番号: rich(r.number),
      取引先: { relation: r.draft.customerId ? [{ id: r.draft.customerId }] : [] }, 元書類: { relation: r.draft.originalId ? [{ id: r.draft.originalId }] : [] },
      取引日: { date: { start: r.draft.transactionDate } }, 発行日: { date: { start: r.draft.issueDate } }, 書式: select(r.draft.format === 'qualified' ? '適格請求書' : '適格簡易請求書'),
      ステータス: select(r.status), 合計金額: num(totals.total), 但し書き: rich(r.draft.purpose), 支払方法: select(r.draft.paymentMethod),
      確定データJSON: { files: [attachment] }, 原本ハッシュ: rich(r.pdfHash ?? ''), 取消理由: rich(r.cancelReason ?? ''),
    };
    for (const rate of [10, 8, 1]) { const g = totals.groups.find(g => g.rate === rate); properties[`${rate}％対象税込額`] = num(g?.gross ?? 0); properties[`${rate}％対象税抜額`] = num(g?.net ?? 0); properties[`${rate}％消費税額`] = num(g?.tax ?? 0); }
    properties['非課税額'] = num(totals.groups.find(g => g.categories.includes('NON_TAXABLE'))?.gross ?? 0);
    properties['免税等額'] = num(totals.groups.find(g => g.categories.includes('EXEMPT'))?.gross ?? 0);
    const p: Page = r.id ? await this.api(`pages/${r.id}`, 'PATCH', { properties }) : await this.api('pages', 'POST', { parent: { type: 'data_source_id', data_source_id: this.config.ids.receipts }, properties });
    return this.fromPage(p);
  }
  async attachPdf(id: string, bytes: Uint8Array) { await this.owned(id, 'receipts'); const file = await this.upload(bytes, `${id}.pdf`, 'application/pdf'); await this.api(`pages/${id}`, 'PATCH', { properties: { PDF原本: { files: [file] } } }); }
  async pdf(id: string) { return this.download(await this.owned(id, 'receipts'), 'PDF原本'); }
  async customers(): Promise<Customer[]> { return (await this.query('customers')).map(p => ({ id: p.id, name: txt(p, '名称'), honorific: p.properties['敬称']?.select?.name ?? '様', address: txt(p, '住所'), contact: txt(p, '連絡先'), note: txt(p, '備考') })); }
  async addCustomer(c: Omit<Customer, 'id'>) { const p = await this.api('pages', 'POST', { parent: { type: 'data_source_id', data_source_id: this.config.ids.customers }, properties: { 名称: title(c.name), 敬称: select(c.honorific), 住所: rich(c.address), 連絡先: rich(c.contact), 備考: rich(c.note) } }); return { ...c, id: p.id }; }
  async issuer() {
    const pages = await this.query('issuer'); if (!pages.length) return null; if (pages.length > 1) throw new Error('発行者設定は1件にしてください');
    const p = pages[0];
    return issuerSchema.parse({ name: txt(p, '名称'), address: txt(p, '住所'), registrationNumber: txt(p, '登録番号'), contact: txt(p, '連絡先'), prefix: txt(p, '番号接頭辞'), defaultCategory: ({ '標準10％': 'STANDARD', '食品8％': 'REDUCED_FOOD', '新聞8％': 'REDUCED_NEWS' } as any)[p.properties['既定税区分']?.select?.name], taxMode: p.properties['税計算方式']?.select?.name === '外税' ? 'exclusive' : 'inclusive', rounding: ({ 切り捨て: 'floor', 四捨五入: 'round', 切り上げ: 'ceil' } as any)[p.properties['端数処理']?.select?.name] });
  }
  async saveIssuer(i: Issuer) {
    const pages = await this.query('issuer'); if (pages.length > 1) throw new Error('発行者設定は1件にしてください');
    const properties = { 名称: title(i.name), 住所: rich(i.address), 登録番号: rich(i.registrationNumber), 連絡先: rich(i.contact), 番号接頭辞: rich(i.prefix), 既定税区分: select({ STANDARD: '標準10％', REDUCED_FOOD: '食品8％', REDUCED_NEWS: '新聞8％' }[i.defaultCategory]), 税計算方式: select(i.taxMode === 'inclusive' ? '内税' : '外税'), 端数処理: select({ floor: '切り捨て', round: '四捨五入', ceil: '切り上げ' }[i.rounding]) };
    if (pages[0]) await this.api(`pages/${pages[0].id}`, 'PATCH', { properties }); else await this.api('pages', 'POST', { parent: { type: 'data_source_id', data_source_id: this.config.ids.issuer }, properties });
  }
  async audit(e: Event) {
    const existing = await this.query('audit', { property: '操作ID', rich_text: { equals: e.id } }); if (existing.length) return;
    await this.owned(e.receiptId, 'receipts');
    await this.api('pages', 'POST', { parent: { type: 'data_source_id', data_source_id: this.config.ids.audit }, properties: { 名称: title(`${e.type}｜${e.at}`), 対象領収書: { relation: [{ id: e.receiptId }] }, 操作種別: select(e.type), 操作者: rich('本人'), 操作日時: { date: { start: e.at } }, 変更概要: rich(e.summary), 操作ID: rich(e.id) } });
  }
  async check() {
    const errors: string[] = [];
    for (const kind of Object.keys(requiredSchemas) as (keyof Config['ids'])[]) {
      const schema = await this.api(`data_sources/${this.config.ids[kind]}`);
      for (const [name, type] of Object.entries(requiredSchemas[kind])) if (schema.properties[name]?.type !== type) errors.push(`${kind}: ${name}は${type}型が必要です`);
    }
    if (errors.length) throw new Error(errors.join(' / '));
    return { mode: 'notion', ok: true };
  }
}
