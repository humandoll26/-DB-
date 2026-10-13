import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DemoRepository } from '../server/repository.js';
import { Journal } from '../server/journal.js';
import { ReceiptService } from '../server/service.js';
import type { Draft, Issuer } from '../shared/domain.js';
export const issuer: Issuer = { name: '試験用発行者', address: '試験用住所', registrationNumber: 'T1234567890123', contact: 'test@example.invalid', prefix: 'TEST', defaultCategory: 'STANDARD', taxMode: 'inclusive', rounding: 'floor' };
export const draft: Draft = { customerId: '', customerName: '試験用取引先', honorific: '御中', customerAddress: '', transactionDate: '2026-10-13', issueDate: '2026-10-13', format: 'qualified', simplifiedEligible: false, purpose: '検証費用として', paymentMethod: '銀行振込', note: '', taxMode: 'inclusive', rounding: 'floor', originalId: '', lines: [{ description: '試験用商品', quantity: 1, unitPrice: 1100, category: 'STANDARD' }] };
export async function fixture(generator?: ConstructorParameters<typeof ReceiptService>[2]) {
  const dir = await mkdtemp(path.join(tmpdir(), 'receipt-test-')); const repo = new DemoRepository(dir); const journal = new Journal(dir); const service = new ReceiptService(repo, journal, generator);
  await repo.saveIssuer(issuer);
  return { dir, repo, journal, service, create: () => service.saveDraft(structuredClone(draft), undefined, undefined, randomUUID()), close: async () => { journal.close(); await rm(dir, { recursive: true, force: true }); } };
}
