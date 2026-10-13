import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { Journal } from '../server/journal.js';
import { ReceiptService } from '../server/service.js';
import { digest } from '../server/repository.js';
import { draft, fixture, issuer } from './fixtures.js';
const fakePdf = async () => new Uint8Array(Buffer.from('%PDF-test-original'));
test('同じ作成IDの再試行で下書きを重複作成しない', async () => {
  const f = await fixture(fakePdf); try { const id = randomUUID(); const a = await f.service.saveDraft(draft, undefined, undefined, id); const b = await f.service.saveDraft(draft, undefined, undefined, id); assert.equal(a.id, b.id); assert.equal((await f.repo.list()).length, 1); } finally { await f.close(); }
});
test('同時確定・再試行は同じ番号と原本を返す', async () => {
  let generated = 0; const f = await fixture(async () => { generated++; return fakePdf(); });
  try {
    const r = await f.create(); const results = await Promise.all([1, 2, 3].map(() => f.service.issue(r.id, r.version, digest(issuer))));
    assert.equal(new Set(results.map(r => r.number)).size, 1); assert.equal(generated, 1); assert.equal(f.journal.get(r.id)?.snapshot, null); assert.equal(f.journal.get(r.id)?.pdf, null);
    await assert.rejects(() => f.service.saveDraft(draft, r.id, results[0].version, r.issuanceId), /編集できません/);
    assert.deepEqual((await f.service.download(r.id)).bytes, await fakePdf());
  } finally { await f.close(); }
});
test('別書類の同時発行でも採番が重複しない', async () => {
  const f = await fixture(fakePdf); try { const a = await f.create(), b = await f.create(); const results = await Promise.all([a, b].map(r => f.service.issue(r.id, r.version, digest(issuer)))); assert.deepEqual(results.map(r => r.number), ['TEST-202610-0001', 'TEST-202610-0002']); } finally { await f.close(); }
});
test('下書きの古い版と確認後の発行者変更を拒否する', async () => {
  const f = await fixture(fakePdf); try { const r = await f.create(); await f.service.saveDraft({ ...draft, purpose: '変更済み' }, r.id, r.version, r.issuanceId); await assert.rejects(() => f.service.issue(r.id, r.version, digest(issuer)), /変更/); const latest = await f.repo.get(r.id); await f.repo.saveIssuer({ ...issuer, name: '別の発行者' }); await assert.rejects(() => f.service.issue(r.id, latest.version, digest(issuer)), /発行者設定が変更/); } finally { await f.close(); }
});
test('PDF添付失敗・プロセス再起動後も同じ原本で復旧する', async () => {
  let generated = 0; const f = await fixture(async () => { generated++; return fakePdf(); });
  let reopened: Journal | undefined;
  try {
    const r = await f.create(); const attach = f.repo.attachPdf.bind(f.repo); let fail = true;
    f.repo.attachPdf = async (id, pdf) => { if (fail) { fail = false; throw new Error('通信失敗'); } return attach(id, pdf); };
    await assert.rejects(() => f.service.issue(r.id, r.version, digest(issuer)), /通信失敗/);
    const firstNumber = f.journal.get(r.id)?.number; f.journal.close(); reopened = new Journal(f.dir);
    const service = new ReceiptService(f.repo, reopened, fakePdf);
    await f.repo.saveIssuer({ ...issuer, name: '設定変更後' });
    const result = await service.issue(r.id, r.version, digest(issuer)); assert.equal(result.number, firstNumber); assert.equal(result.snapshot?.issuer.name, issuer.name); assert.equal(generated, 1); assert.equal(result.status, '発行済み');
  } finally { reopened?.close(); await f.close(); }
});
test('最終保存の応答喪失を成功と照合し、再発行しない', async () => {
  const f = await fixture(fakePdf); try {
    const r = await f.create(); const save = f.repo.save.bind(f.repo); let lost = true;
    f.repo.save = async r => { const saved = await save(r); if (r.status === '発行済み' && lost) { lost = false; throw new Error('応答喪失'); } return saved; };
    await assert.rejects(() => f.service.issue(r.id, r.version, digest(issuer)), /応答喪失/);
    const result = await f.service.issue(r.id, r.version, digest(issuer)); assert.equal(result.status, '発行済み'); assert.equal(f.journal.get(r.id)?.state, 'done');
  } finally { await f.close(); }
});
test('操作履歴同期の失敗は発行を取り消さず、再試行で同期する', async () => {
  const f = await fixture(fakePdf); try { const r = await f.create(); const audit = f.repo.audit.bind(f.repo); f.repo.audit = async () => { throw new Error('Notion停止'); }; const result = await f.service.issue(r.id, r.version, digest(issuer)); assert.equal(result.status, '発行済み'); assert.equal(f.journal.pendingEvents().length, 1); f.repo.audit = audit; await f.service.flush(); assert.equal(f.journal.pendingEvents().length, 0); } finally { await f.close(); }
});
test('取消は原本を保持し、訂正は別の番号で発行する', async () => {
  const f = await fixture(fakePdf); try { const r = await f.create(); const issued = await f.service.issue(r.id, r.version, digest(issuer)); const cancelled = await f.service.cancel(r.id, '宛名訂正', issued.version); assert.equal(cancelled.status, '取消'); assert.deepEqual((await f.service.download(r.id)).bytes, await fakePdf()); await assert.rejects(() => f.service.issue(r.id, cancelled.version, digest(issuer)), /取消/); const corrected = await f.service.saveDraft({ ...draft, originalId: r.id, customerName: '訂正した宛名' }, undefined, undefined, randomUUID()); const final = await f.service.issue(corrected.id, corrected.version, digest(issuer)); assert.notEqual(final.number, issued.number); assert.equal(final.draft.originalId, r.id); } finally { await f.close(); }
});
test('保存原本の改変を検出する', async () => {
  const f = await fixture(fakePdf); try { const r = await f.create(); await f.service.issue(r.id, r.version, digest(issuer)); await writeFile(path.join(f.dir, `${r.id}.pdf`), 'modified'); await assert.rejects(() => f.service.download(r.id), /ハッシュ/); } finally { await f.close(); }
});
test('PDFと台帳を同時に改変しても確定時の照合ハッシュで拒否する', async () => {
  const f = await fixture(fakePdf); try {
    const r = await f.create(); const issued = await f.service.issue(r.id, r.version, digest(issuer));
    const changed = { ...issued, snapshot: { ...issued.snapshot!, issuer: { ...issuer, name: '直接編集された名称' } } };
    await f.repo.save(changed); await assert.rejects(() => f.service.download(r.id), /確定後の変更/);
  } finally { await f.close(); }
});
test('日本語フォントを埋め込み、長文・50明細は複数ページで出力する', async () => {
  const f = await fixture(); try {
    const r = await f.service.saveDraft({ ...draft, lines: Array.from({ length: 50 }, (_, i) => ({ ...draft.lines[0], description: `${i + 1} 日本語の長い品名`.repeat(5) })), note: '長い備考\n'.repeat(60) }, undefined, undefined, randomUUID());
    const issued = await f.service.issue(r.id, r.version, digest(issuer)); const bytes = (await f.service.download(r.id)).bytes;
    const pdf = await PDFDocument.load(bytes); assert.ok(pdf.getPageCount() > 1); assert.ok(bytes.length < 5 * 1024 * 1024); assert.equal(pdf.getTitle(), `領収書 ${issued.number}`); assert.ok(Buffer.from(bytes).includes(Buffer.from('%PDF')));
  } finally { await f.close(); }
});
