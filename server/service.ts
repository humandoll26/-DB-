import { randomUUID } from 'node:crypto';
import { calculate, validateForIssue, type Draft, type Receipt, type Snapshot, type Issuer } from '../shared/domain.js';
import { digest, pdfDigest, type Repository, type Event } from './repository.js';
import { Journal } from './journal.js';
import { generatePdf } from './pdf.js';
import { taxPolicyVersion } from '../shared/tax-policy.js';
export class ReceiptService {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly repo: Repository, readonly journal: Journal, private pdfGenerator = generatePdf) {}
  serial<T>(action: () => Promise<T>): Promise<T> { const run = this.tail.then(action); this.tail = run.catch(() => {}); return run; }
  private event(r: Receipt, type: string, summary: string, id: string = randomUUID()): Event { return { id, receiptId: r.id, type, summary, at: new Date().toISOString() }; }
  async flush() { for (const e of this.journal.pendingEvents()) { try { await this.repo.audit(e); this.journal.acknowledge(e.id); } catch { break; } } }
  async saveDraft(draft: Draft, id: string | undefined, version: string | undefined, issuanceId: string) {
    return this.serial(async () => {
      let existing = id ? await this.repo.get(id) : await this.repo.find(issuanceId);
      if (existing && !id) {
        if (existing.status === '下書き' && digest(existing.draft) === digest(draft)) return existing;
        throw new Error('この作成IDは使用済みです。履歴を確認してください');
      }
      if (existing && (existing.status !== '下書き' || this.journal.get(existing.id))) throw new Error('発行処理開始後の書類は編集できません');
      if (existing && version !== existing.version) throw new Error('下書きが変更されています。再読み込みしてください');
      if (draft.originalId && (await this.repo.get(draft.originalId)).status !== '取消') throw new Error('訂正元は取消済み書類を指定してください');
      const saved = await this.repo.save({ ...(existing ?? {}), id: existing?.id ?? '', version: '', issuanceId: existing?.issuanceId ?? issuanceId, number: '', status: '下書き', draft });
      this.journal.enqueue(this.event(saved, existing ? '下書き更新' : '下書き作成', existing ? '下書きを更新' : '下書きを作成')); await this.flush(); return saved;
    });
  }
  async preview(id: string) {
    const r = await this.repo.get(id);
    if (['発行済み', '取消'].includes(r.status)) throw new Error('この書類は確定済みです');
    const job = this.journal.get(id);
    if (job?.snapshot) {
      const snapshot = JSON.parse(job.snapshot) as Snapshot;
      if (digest(r.draft) !== digest(snapshot.draft)) throw new Error('発行開始後に下書きが変更されています');
      return { receipt: r, issuer: snapshot.issuer, issuerVersion: digest(snapshot.issuer), totals: snapshot.totals, resuming: true };
    }
    const issuer = await this.repo.issuer();
    if (!issuer) throw new Error('発行者設定を保存してください');
    validateForIssue(r.draft, issuer);
    return { receipt: r, issuer, issuerVersion: digest(issuer), totals: calculate(r.draft) };
  }
  async issue(id: string, version: string, issuerVersion: string) {
    return this.serial(async () => {
      let receipt = await this.repo.get(id); let job = this.journal.get(id);
      if (receipt.status === '取消') throw new Error('取消書類は再発行できません。新しい下書きを作成してください');
      if (job?.state === 'done') { if (receipt.status !== '発行済み') throw new Error('確定後に台帳が変更されています'); this.journal.verify(receipt); return receipt; }
      if (!job) {
        if (receipt.status !== '下書き' || receipt.version !== version) throw new Error('下書きが変更されています。再確認してください');
        const issuer = await this.repo.issuer(); if (!issuer) throw new Error('発行者設定を保存してください');
        if (digest(issuer) !== issuerVersion) throw new Error('発行者設定が変更されています。再確認してください');
        validateForIssue(receipt.draft, issuer);
        const prefix = `${issuer.prefix ? issuer.prefix + '-' : ''}${receipt.draft.issueDate.slice(0, 7).replace('-', '')}`;
        const records = await this.repo.list();
        const remoteMax = records.reduce((max, r) => r.number.startsWith(prefix + '-') && /^\d+$/.test(r.number.slice(prefix.length + 1)) ? Math.max(max, Number(r.number.slice(prefix.length + 1))) : max, 0);
        job = this.journal.reserve(id, prefix, remoteMax, number => ({ draft: receipt.draft, issuer, number, issuedAt: new Date().toISOString(), totals: calculate(receipt.draft), templateVersion: 'notion-receipt-v1', taxPolicyVersion }));
      }
      const snapshot = JSON.parse(job.snapshot!) as Snapshot;
      // 再試行時は最新の設定で再計算せず、最初の確定スナップショットを使用する。
      if (digest(receipt.draft) !== digest(snapshot.draft)) throw new Error('発行処理開始後に下書きが変更されています。管理者の確認が必要です');
      if (receipt.status === '発行済み') {
        const bytes = await this.repo.pdf(id);
        if (receipt.pdfHash !== pdfDigest(bytes) || digest(receipt.snapshot) !== digest(snapshot)) throw new Error('発行原本との不整合が検出されました');
        this.journal.finish(id, this.event(receipt, receipt.draft.originalId ? '訂正発行' : '発行', `${job.number}を発行`, `issue:${receipt.issuanceId}`)); await this.flush(); return receipt;
      }
      try {
        receipt = await this.repo.save({ ...receipt, status: '発行処理中', number: job.number, snapshot });
        if (!job.pdf) { this.journal.setPdf(id, await this.pdfGenerator(snapshot, receipt.issuanceId)); job = this.journal.get(id)!; }
        const bytes = job.pdf!; const hash = pdfDigest(bytes);
        await this.repo.attachPdf(id, bytes);
        // 保存されたバイト列を読み戻してから発行済みにする。
        if (pdfDigest(await this.repo.pdf(id)) !== hash) throw new Error('PDF保存の確認に失敗しました');
        receipt = await this.repo.save({ ...receipt, status: '発行済み', pdfHash: hash });
        this.journal.finish(id, this.event(receipt, receipt.draft.originalId ? '訂正発行' : '発行', `${job.number}を発行`, `issue:${receipt.issuanceId}`)); await this.flush(); return receipt;
      } catch (e) {
        // 成功応答が失われた可能性があるため、失敗扱いで上書きしない。ジャーナルから再開する。
        this.journal.enqueue(this.event(receipt, '発行失敗', '発行処理が中断。原本・台帳を照合して同じ発行IDで再試行', `failure:${receipt.issuanceId}:${randomUUID()}`));
        await this.flush(); throw e;
      }
    });
  }
  async cancel(id: string, reason: string, version: string) {
    return this.serial(async () => {
      const r = await this.repo.get(id); if (r.status !== '発行済み' || r.version !== version) throw new Error('最新の発行済み書類を指定してください');
      this.journal.verify(r);
      const saved = await this.repo.save({ ...r, status: '取消', cancelReason: reason });
      this.journal.enqueue(this.event(saved, '取消', reason, `cancel:${r.issuanceId}`)); await this.flush(); return saved;
    });
  }
  async download(id: string) {
    return this.serial(async () => {
      const r = await this.repo.get(id); if (!['発行済み', '取消'].includes(r.status)) throw new Error('確定済み原本のみ取得できます');
      this.journal.verify(r);
      const bytes = await this.repo.pdf(id); if (!r.pdfHash || pdfDigest(bytes) !== r.pdfHash) throw new Error('PDF原本ハッシュが一致しません');
      this.journal.enqueue(this.event(r, '原本ダウンロード', '保存済み原本を取得')); await this.flush(); return { bytes, number: r.number };
    });
  }
}
