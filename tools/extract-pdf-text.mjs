// Extracts the text layer of a PDF (one-off helper for generate-tables.mjs).
// Usage: node tools/extract-pdf-text.mjs input.pdf output.txt   (needs `npm i pdfjs-dist` somewhere resolvable)
import fs from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
const [,, input, output] = process.argv;
const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(input)), useSystemFonts: true }).promise;
let out = '';
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  let line = '', lastY = null;
  for (const it of tc.items) {
    const y = Math.round(it.transform[5]);
    if (lastY !== null && Math.abs(y - lastY) > 2) { out += line + '\n'; line = ''; }
    line += it.str + ' '; lastY = y;
  }
  out += line + `\n=====PAGE ${p}=====\n`;
}
fs.writeFileSync(output, out);
console.log('pages', doc.numPages, 'chars', out.length);
