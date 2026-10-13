import { z } from 'zod';
import { taxPolicy } from './tax-policy.js';

export const taxCategories = {
  STANDARD: { label: '標準10％', rate: 10, help: '一般の商品・サービス、酒類、店内飲食など。' },
  REDUCED_FOOD: { label: '食品8％', rate: 8, help: '酒類・外食を除く軽減税率対象の飲食料品。セット販売は個別に区分を確認してください。' },
  REDUCED_NEWS: { label: '新聞8％', rate: 8, help: '定期購読契約がある週2回以上発行される新聞。食品の臨時税率とは別の区分です。' },
  TEMP_FOOD: { label: '食品1％（準備中）', rate: 1, help: '酒類・外食を除く飲食料品向けの予定区分。予定期間：2027年4月1日〜2029年3月31日。法改正の成立・施行確認まで確定発行に使用できません。酒類、店内飲食、非食品、新聞は対象外です。' },
  NON_TAXABLE: { label: '非課税', rate: 0, help: '非課税取引。適用の根拠を確認してください。' },
  EXEMPT: { label: '免税等', rate: 0, help: '非課税とは別の区分。適用の根拠を確認してください。' },
} as const;
export type TaxCategory = keyof typeof taxCategories;
const text = (max: number) => z.string().trim().max(max);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === v;
}, '実在する日付を指定してください');
export const issuerSchema = z.object({
  name: text(100).min(1), address: text(300), registrationNumber: z.string().regex(/^T\d{13}$/, '登録番号はTと13桁の数字です'),
  contact: text(200), prefix: z.string().regex(/^[A-Za-z0-9-]{0,20}$/),
  defaultCategory: z.enum(['STANDARD', 'REDUCED_FOOD', 'REDUCED_NEWS']),
  taxMode: z.enum(['inclusive', 'exclusive']), rounding: z.enum(['floor', 'round', 'ceil']),
});
export type Issuer = z.infer<typeof issuerSchema>;
export const customerSchema = z.object({ name: text(100).min(1), honorific: z.enum(['様', '御中', 'なし']), address: text(300), contact: text(200), note: text(500) });
export type Customer = z.infer<typeof customerSchema> & { id: string };
export const draftSchema = z.object({
  customerId: z.union([z.uuid(), z.literal('')]), customerName: text(100).min(1), honorific: z.enum(['様', '御中', 'なし']),
  customerAddress: text(300), transactionDate: date, issueDate: date,
  format: z.enum(['qualified', 'simplified']), simplifiedEligible: z.boolean(),
  purpose: text(300).min(1), paymentMethod: z.enum(['現金', '銀行振込', 'カード', 'その他']), note: text(1000),
  taxMode: z.enum(['inclusive', 'exclusive']), rounding: z.enum(['floor', 'round', 'ceil']),
  lines: z.array(z.object({ description: text(150).min(1), quantity: z.number().int().min(1).max(100000), unitPrice: z.number().int().min(0).max(100000000), category: z.enum(Object.keys(taxCategories) as [TaxCategory, ...TaxCategory[]]) })).min(1).max(50),
  originalId: z.union([z.uuid(), z.literal('')]).default(''),
}).refine(v => v.lines.reduce((n, l) => n + l.quantity * l.unitPrice, 0) <= 100000000000, '合計金額が上限を超えています');
export type Draft = z.infer<typeof draftSchema>;
export type Status = '下書き' | '発行処理中' | '発行済み' | '発行失敗' | '取消';
export type TaxGroup = { rate: number; categories: TaxCategory[]; amount: number; net: number; tax: number; gross: number };
export function calculate(draft: Draft) {
  // 同じ税率の明細をまとめてから一度だけ端数処理する。円・数量は整数。
  const groups = new Map<string, { rate: number; categories: Set<TaxCategory>; amount: number }>();
  for (const l of draft.lines) {
    const rate = taxCategories[l.category].rate;
    const key = rate === 0 ? l.category : String(rate);
    const g = groups.get(key) ?? { rate, categories: new Set<TaxCategory>(), amount: 0 };
    g.amount += l.quantity * l.unitPrice; g.categories.add(l.category); groups.set(key, g);
  }
  const round = Math[draft.rounding];
  const breakdown: TaxGroup[] = [...groups.values()].sort((a, b) => b.rate - a.rate).map(g => {
    const tax = round(g.amount * g.rate / (draft.taxMode === 'inclusive' ? 100 + g.rate : 100));
    const gross = draft.taxMode === 'inclusive' ? g.amount : g.amount + tax;
    return { rate: g.rate, categories: [...g.categories], amount: g.amount, net: gross - tax, tax, gross };
  });
  return { groups: breakdown, total: breakdown.reduce((n, g) => n + g.gross, 0) };
}
export function validateForIssue(draft: Draft, issuer: Issuer) {
  draftSchema.parse(draft); issuerSchema.parse(issuer);
  if (draft.format === 'simplified' && !draft.simplifiedEligible) throw new Error('適格簡易請求書の利用条件を確認してください');
  for (const line of draft.lines) {
    const policy: { enabled: boolean; startsAt: string | null; endsAt: string | null } = taxPolicy[line.category];
    if (!policy.enabled) throw new Error('食品1％は準備中のため確定発行できません');
    if ((policy.startsAt && draft.transactionDate < policy.startsAt) || (policy.endsAt && draft.transactionDate > policy.endsAt)) throw new Error('取引日が税区分の適用期間外です');
  }
}
export type Snapshot = { draft: Draft; issuer: Issuer; number: string; issuedAt: string; totals: ReturnType<typeof calculate>; templateVersion: string; taxPolicyVersion: string };
export type Receipt = { id: string; issuanceId: string; version: string; status: Status; number: string; draft: Draft; snapshot?: Snapshot; pdfHash?: string; cancelReason?: string; url?: string };
export const yen = (n: number) => new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' }).format(n);
