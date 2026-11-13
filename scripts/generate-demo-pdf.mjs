// Writes the two-page PDF that the browser demonstration shows as an
// attachment. It is public and says nothing but what it is.
//
//   node scripts/generate-demo-pdf.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'public', 'demo-attachments', 'demo-pdf');

const page = (number) =>
  [
    'BT /F2 24 Tf 72 730 Td (Bever local PDF preview) Tj ET',
    `BT /F1 14 Tf 72 690 Td (Page ${number} of 2) Tj ET`,
    'BT /F1 14 Tf 72 650 Td (This public sample is rendered entirely on your device.) Tj ET',
  ].join('\n');

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [5 0 R 7 0 R] /Count 2 >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ...[1, 2].flatMap((number) => {
    const content = page(number);
    return [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${4 + number * 2} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ];
  }),
  '<< /Title (Bever local PDF preview) >>',
];

let pdf = '%PDF-1.4\n';
const offsets = objects.map((body, index) => {
  const offset = pdf.length;
  pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  return offset;
});
const xref = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, pdf, 'latin1');
console.log(target);
