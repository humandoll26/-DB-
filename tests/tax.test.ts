import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate, draftSchema, issuerSchema, validateForIssue } from '../shared/domain.js';
import { draft, issuer } from './fixtures.js';
test('8%食品・新聞をまとめ、10%と別集計する', () => {
  const d = { ...draft, lines: [{ description: '食品', quantity: 1, unitPrice: 1080, category: 'REDUCED_FOOD' as const }, { description: '新聞', quantity: 1, unitPrice: 1080, category: 'REDUCED_NEWS' as const }, ...draft.lines] };
  const totals = calculate(d); assert.equal(totals.total, 3260); assert.equal(totals.groups.length, 2); assert.deepEqual(totals.groups.map(g => [g.rate, g.tax, g.net]), [[10, 100, 1000], [8, 160, 2000]]);
});
test('内税は税率別税額を1回だけ切り捨てる', () => {
  const totals = calculate({ ...draft, lines: [0, 1].map(() => ({ description: '端数', quantity: 1, unitPrice: 6, category: 'STANDARD' as const })) });
  assert.equal(totals.groups[0].tax, 1); assert.equal(totals.groups[0].net, 11);
});
test('外税は明細ごとに丸めず税率別に合算する', () => {
  const totals = calculate({ ...draft, taxMode: 'exclusive', lines: [0, 1].map(() => ({ description: '端数', quantity: 1, unitPrice: 6, category: 'STANDARD' as const })) });
  assert.equal(totals.total, 13); assert.equal(totals.groups[0].tax, 1);
});
test('四捨五入と切り上げを明示的に選べる', () => {
  const d = { ...draft, taxMode: 'exclusive' as const, lines: [{ ...draft.lines[0], unitPrice: 5 }] };
  assert.equal(calculate({ ...d, rounding: 'floor' }).groups[0].tax, 0); assert.equal(calculate({ ...d, rounding: 'round' }).groups[0].tax, 1); assert.equal(calculate({ ...d, rounding: 'ceil' }).groups[0].tax, 1);
});
test('非課税と免税等は異なる区分として保持する', () => {
  const totals = calculate({ ...draft, lines: [{ ...draft.lines[0], category: 'NON_TAXABLE' }, { ...draft.lines[0], category: 'EXEMPT' }] }); assert.equal(totals.groups.length, 2); assert.equal(totals.groups.every(g => g.tax === 0), true);
});
for (const day of ['2026-10-13', '2027-04-01', '2029-04-01']) test(`未施行1%は日付${day}でも確定発行不可`, () => {
  assert.throws(() => validateForIssue({ ...draft, transactionDate: day, lines: [{ ...draft.lines[0], category: 'TEMP_FOOD' }] }, issuer), /準備中/);
});
test('実在日付・数量・金額・宛名・登録番号を検証する', () => {
  assert.equal(draftSchema.safeParse({ ...draft, transactionDate: '2026-02-30' }).success, false);
  assert.equal(draftSchema.safeParse({ ...draft, customerName: ' ' }).success, false);
  assert.equal(draftSchema.safeParse({ ...draft, lines: [{ ...draft.lines[0], quantity: 0 }] }).success, false);
  assert.equal(draftSchema.safeParse({ ...draft, lines: [{ ...draft.lines[0], unitPrice: 1.5 }] }).success, false);
  assert.equal(issuerSchema.safeParse({ ...issuer, registrationNumber: 'T123' }).success, false);
});
test('簡易請求書には利用条件確認が必要', () => {
  assert.throws(() => validateForIssue({ ...draft, format: 'simplified' }, issuer), /利用条件/);
  assert.doesNotThrow(() => validateForIssue({ ...draft, format: 'simplified', simplifiedEligible: true }, issuer));
});
test('現行10%・軽減8%の適用開始前の取引日を拒否する', () => {
  assert.throws(() => validateForIssue({ ...draft, transactionDate: '2019-09-30' }, issuer), /適用期間外/);
});
