import { readFile } from 'node:fs/promises';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { Snapshot } from '../shared/domain.js';
import { taxCategories, yen } from '../shared/domain.js';
export async function generatePdf(snapshot: Snapshot, issuanceId: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create(); doc.registerFontkit(fontkit);
  const bytes = await readFile(new URL('../assets/fonts/NotoSansJP.ttf', import.meta.url));
  const font = await doc.embedFont(bytes, { subset: true });
  doc.setTitle(`領収書 ${snapshot.number}`); doc.setAuthor(snapshot.issuer.name); doc.setCreationDate(new Date(snapshot.issuedAt));
  const ink = rgb(0.12, 0.2, 0.17); let page = doc.addPage([595.28, 841.89]); let y = 788; let index = 1;
  const newPage = () => { page = doc.addPage([595.28, 841.89]); index++; y = 788; };
  const line = (text: string, size = 11, inset = 0) => {
    const max = 499 - inset; let current = '';
    const draw = () => { if (y < 65) newPage(); page.drawText(current || ' ', { x: 48 + inset, y, size, font, color: ink }); y -= size + 8; current = ''; };
    for (const c of text) {
      if (c === '\n') { draw(); continue; }
      if (font.widthOfTextAtSize(current + c, size) > max && current) draw(); current += c;
    }
    draw();
  };
  line(snapshot.draft.format === 'qualified' ? '領収書｜適格請求書' : '領収書｜適格簡易請求書', 23);
  line(`発行番号 ${snapshot.number}`); line(`取引日 ${snapshot.draft.transactionDate}　発行日 ${snapshot.draft.issueDate}`); y -= 12;
  line(`${snapshot.draft.customerName}${snapshot.draft.honorific === 'なし' ? '' : ` ${snapshot.draft.honorific}`}`, 17);
  if (snapshot.draft.customerAddress) line(snapshot.draft.customerAddress);
  y -= 10; line(`領収金額　${yen(snapshot.totals.total)}`, 24); line(`但し　${snapshot.draft.purpose}`); line('上記正に領収いたしました。'); y -= 12;
  line('取引明細', 15);
  snapshot.draft.lines.forEach((l, i) => {
    const reduced = ['REDUCED_FOOD', 'REDUCED_NEWS'].includes(l.category) ? ' ※' : '';
    line(`${i + 1}. ${l.description}${reduced}`, 11);
    line(`${l.quantity} × ${yen(l.unitPrice)} ＝ ${yen(l.quantity * l.unitPrice)}　${taxCategories[l.category].label}`, 10, 12);
  });
  line(`金額入力：${snapshot.draft.taxMode === 'inclusive' ? '税込' : '税抜'}　端数処理：${{ floor: '切り捨て', round: '四捨五入', ceil: '切り上げ' }[snapshot.draft.rounding]}`, 10);
  if (snapshot.draft.lines.some(l => ['REDUCED_FOOD', 'REDUCED_NEWS'].includes(l.category))) line('※ 軽減税率対象', 10);
  y -= 12; line('税率別集計', 15);
  for (const g of snapshot.totals.groups) {
    const label = g.rate ? `${g.rate}％対象` : taxCategories[g.categories[0]].label;
    line(`${label}　税込 ${yen(g.gross)}　税抜 ${yen(g.net)}　消費税 ${yen(g.tax)}`, 11);
  }
  line(`支払方法　${snapshot.draft.paymentMethod}`); y -= 12;
  line(`発行者　${snapshot.issuer.name}`, 14); line(`登録番号　${snapshot.issuer.registrationNumber}`);
  if (snapshot.issuer.address) line(snapshot.issuer.address);
  if (snapshot.issuer.contact) line(snapshot.issuer.contact);
  if (snapshot.draft.note) { y -= 10; line(`備考　${snapshot.draft.note}`); }
  doc.getPages().forEach((p, i) => { p.drawText(`${snapshot.number}  |  ${i + 1}/${index}`, { x: 48, y: 33, size: 8, font, color: ink }); });
  // UUIDは文字幅が長いためPDFメタデータに保存する。
  doc.setSubject(`issuanceId=${issuanceId}; template=${snapshot.templateVersion}`);
  const pdf = await doc.save(); if (pdf.length > 5 * 1024 * 1024) throw new Error('PDFが5MiBを超えています'); return pdf;
}
