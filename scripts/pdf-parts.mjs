// Puts what pdf.js reads while it draws a PDF where the interface is served
// from (public/pdfjs, which is not kept in the repository).
//
//   node scripts/pdf-parts.mjs
//
// Beside its own code, pdf.js fetches files when a document asks for them:
// the decoders of the pictures in scanned documents (JBIG2, JPEG 2000), the
// fonts a PDF may name without carrying them, the character maps of East
// Asian text, and a colour profile. Without them such pages are drawn with
// their pictures or letters missing. Each folder has its licence in it.
// Run before the interface is built or served; `npm run build` and
// `npm run dev` do.
import { cpSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'public', 'pdfjs');
rmSync(target, { recursive: true, force: true });
for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  cpSync(join(root, 'node_modules', 'pdfjs-dist', folder), join(target, folder), { recursive: true });
}
