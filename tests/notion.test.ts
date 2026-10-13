import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NotionRepository, requiredSchemas } from '../server/repository.js';
import { draft, issuer } from './fixtures.js';
function mockNotion() {
  const ids = { receipts: randomUUID(), customers: randomUUID(), issuer: randomUUID(), audit: randomUUID() };
  const pages = new Map<string, any>(), files = new Map<string, Uint8Array>(); const requests: { url: string; init?: RequestInit }[] = [];
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } });
  const transport: typeof fetch = async (input, init) => {
    const url = String(input); requests.push({ url, init }); const endpoint = new URL(url).pathname.replace('/v1/', ''); const method = init?.method ?? 'GET';
    if (url.startsWith('https://secure.notion-static.com/')) return new Response(Buffer.from(files.get(endpoint.replace(/^\//, ''))!));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (endpoint === 'file_uploads') { const id = randomUUID(); return json({ id }); }
    if (endpoint.startsWith('file_uploads/') && endpoint.endsWith('/send')) { const blob = (init?.body as FormData).get('file') as Blob; files.set(endpoint.split('/')[1], new Uint8Array(await blob.arrayBuffer())); return json({ status: 'uploaded' }); }
    if (endpoint.startsWith('data_sources/')) {
      const id = endpoint.split('/')[1];
      if (endpoint.endsWith('/query')) {
        let results = [...pages.values()].filter(p => p.parent.data_source_id === id);
        if (body.filter) results = results.filter(p => p.properties[body.filter.property].rich_text.map((r: any) => r.text.content).join('') === body.filter.rich_text.equals);
        return json({ results, has_more: false });
      }
      const kind = Object.keys(ids).find(k => ids[k as keyof typeof ids] === id) as keyof typeof ids;
      return json({ properties: Object.fromEntries(Object.entries(requiredSchemas[kind]).map(([name, type]) => [name, { type }])) });
    }
    if (endpoint === 'pages' || endpoint.startsWith('pages/')) {
      let p = pages.get(endpoint.split('/')[1]);
      if (method === 'GET') { assert.ok(p); return json(p); }
      if (!p) p = { id: randomUUID(), parent: body.parent, properties: {}, url: 'https://notion.so/test' };
      for (const [key, value] of Object.entries(body.properties) as [string, any][]) {
        p.properties[key] = value.files ? { files: value.files.map((f: any) => ({ type: 'file', name: f.name, file: { url: `https://secure.notion-static.com/${f.file_upload.id}`, expiry_time: new Date(Date.now() + 3600000).toISOString() } })) } : value;
      }
      pages.set(p.id, p); return json(p);
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };
  return { ids, pages, files, requests, repo: new NotionRepository({ ids, token: 'test-token' }, transport, 0) };
}
test('Notion APIのアップロード・添付・再取得・税率別保存を検証', async () => {
  const m = mockNotion();
  const saved = await m.repo.save({ id: '', issuanceId: randomUUID(), version: '', status: '下書き', number: '', draft });
  assert.equal(saved.draft.customerName, draft.customerName);
  assert.equal((await m.repo.find(saved.issuanceId))?.id, saved.id);
  assert.equal(m.pages.get(saved.id).properties['10％消費税額'].number, 100);
  assert.equal(m.pages.get(saved.id).properties['1％消費税額'].number, 0);
  await m.repo.attachPdf(saved.id, new Uint8Array([1, 2, 3]));
  assert.deepEqual(await m.repo.pdf(saved.id), new Uint8Array([1, 2, 3]));
  const apiRequests = m.requests.filter(r => r.url.startsWith('https://api.notion.com'));
  assert.ok(apiRequests.every(r => (r.init?.headers as any)['Notion-Version'] === '2025-09-03'));
  assert.ok(m.requests.filter(r => r.url.startsWith('https://secure.notion-static.com')).every(r => !r.init?.headers));
  await m.repo.saveIssuer(issuer); assert.deepEqual(await m.repo.issuer(), issuer);
  const c = await m.repo.addCustomer({ name: '試験取引先', honorific: '御中', address: '', contact: '', note: '' });
  assert.equal((await m.repo.customers())[0].id, c.id);
  const event = { id: randomUUID(), receiptId: saved.id, type: '下書き作成', summary: '試験', at: new Date().toISOString() };
  await m.repo.audit(event); await m.repo.audit(event); assert.equal([...m.pages.values()].filter(p => p.parent.data_source_id === m.ids.audit).length, 1);
  assert.deepEqual(await m.repo.check(), { mode: 'notion', ok: true });
});
test('設定外DBへのアクセスを拒否し、ファイルをアップロードしない', async () => {
  const m = mockNotion(); const id = randomUUID(); m.pages.set(id, { id, parent: { data_source_id: randomUUID() }, properties: {} });
  await assert.rejects(() => m.repo.get(id), /拒否/);
  await assert.rejects(() => m.repo.attachPdf(id, new Uint8Array([1])), /拒否/);
  assert.equal(m.files.size, 0);
});
test('任意URL添付の取得を拒否する', async () => {
  const m = mockNotion(); const r = await m.repo.save({ id: '', issuanceId: randomUUID(), version: '', status: '下書き', number: '', draft });
  m.pages.get(r.id).properties.PDF原本 = { files: [{ type: 'file', file: { url: 'https://localhost/private' } }] };
  await assert.rejects(() => m.repo.pdf(r.id), /Notion保管/);
  assert.equal(m.requests.some(r => r.url.includes('localhost')), false);
});
