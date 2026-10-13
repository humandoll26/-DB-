import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Event } from './repository.js';
import type { Snapshot } from '../shared/domain.js';
import type { Receipt } from '../shared/domain.js';
import { digest, pdfDigest } from './repository.js';
export type Job = { receipt_id: string; number: string; snapshot: string | null; pdf: Uint8Array | null; state: string; snapshot_hash: string | null; pdf_hash: string | null };
export class Journal {
  private db: DatabaseSync;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dir, 'operations.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS counters (prefix TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (receipt_id TEXT PRIMARY KEY, number TEXT UNIQUE NOT NULL, snapshot TEXT, pdf BLOB, state TEXT NOT NULL, snapshot_hash TEXT, pdf_hash TEXT);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, event TEXT NOT NULL);
    `);
  }
  get(id: string) { return this.db.prepare('SELECT * FROM jobs WHERE receipt_id=?').get(id) as Job | undefined; }
  reserve(id: string, prefix: string, remoteMax: number, build: (number: string) => Snapshot) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.get(id)) throw new Error('発行処理はすでに開始しています');
      const row = this.db.prepare('SELECT value FROM counters WHERE prefix=?').get(prefix) as { value: number } | undefined;
      const seq = Math.max(row?.value ?? 0, remoteMax) + 1;
      const number = `${prefix}-${String(seq).padStart(4, '0')}`;
      this.db.prepare('INSERT INTO counters VALUES (?,?) ON CONFLICT(prefix) DO UPDATE SET value=excluded.value').run(prefix, seq);
      this.db.prepare('INSERT INTO jobs (receipt_id,number,snapshot,state) VALUES (?,?,?,?)').run(id, number, JSON.stringify(build(number)), 'pending');
      this.db.exec('COMMIT'); return this.get(id)!;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  setPdf(id: string, pdf: Uint8Array) { this.db.prepare('UPDATE jobs SET pdf=? WHERE receipt_id=? AND state=?').run(pdf, id, 'pending'); }
  finish(id: string, event: Event) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const job = this.get(id)!; if (!job.snapshot || !job.pdf) throw new Error('発行ジャーナルが不完全です'); this.enqueue(event); this.db.prepare('UPDATE jobs SET state=?, snapshot_hash=?, pdf_hash=?, snapshot=NULL,pdf=NULL WHERE receipt_id=?').run('done', digest(JSON.parse(job.snapshot)), pdfDigest(job.pdf), id); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  verify(r: Receipt) { const job = this.get(r.id); if (job?.state === 'done' && (job.number !== r.number || job.snapshot_hash !== digest(r.snapshot) || job.pdf_hash !== r.pdfHash)) throw new Error('確定後の変更を検出しました。台帳と原本を確認してください'); }
  enqueue(e: Event) { this.db.prepare('INSERT OR IGNORE INTO outbox VALUES (?,?)').run(e.id, JSON.stringify(e)); }
  pendingEvents() { return (this.db.prepare('SELECT event FROM outbox').all() as { event: string }[]).map(v => JSON.parse(v.event) as Event); }
  acknowledge(id: string) { this.db.prepare('DELETE FROM outbox WHERE id=?').run(id); }
  pendingJobs() { return this.db.prepare("SELECT receipt_id,number FROM jobs WHERE state='pending'").all(); }
  close() { if (this.db.isOpen) this.db.close(); }
}
// メモリ上の排他を複数プロセスで誤用しないため、同じ永続ディレクトリで二重起動を拒否する。
export function acquireInstance(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 }); const file = path.join(dir, 'instance.lock');
  try { const fd = openSync(file, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const pid = Number(readFileSync(file, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('instance.lockを確認してください');
    try { process.kill(pid, 0); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ESRCH') { unlinkSync(file); return acquireInstance(dir); } throw err; }
    throw new Error('同じDATA_DIRで別のアプリが実行中です');
  }
  return () => { try { if (readFileSync(file, 'utf8') === String(process.pid)) unlinkSync(file); } catch {} };
}
