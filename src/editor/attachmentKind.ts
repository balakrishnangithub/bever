/**
 * What an attachment is, as far as showing it goes: a picture to draw in
 * the note, or something that can be read in a preview.
 *
 * An attachment says what it is twice, by its type and by the ending of its
 * name, and the two do not always agree: a script is "text/plain", or
 * "application/octet-stream", or a type someone made up; a picture saved
 * from the web is an unknown file with a picture's name. A type that says
 * something is believed; one that says nothing leaves it to the name.
 */

export type PreviewKind = 'pdf' | 'book' | 'markdown' | 'table' | 'text' | 'archive';

/** Types that say no more than "a file". */
const SAYS_NOTHING = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/x-download',
]);

const PICTURE_ENDINGS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg']);
const ARCHIVE_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-compressed',
]);
const MARKDOWN_ENDINGS = new Set(['md', 'markdown', 'mdown', 'mkd']);
const TABLE_ENDINGS = new Set(['csv', 'tsv']);
/** Files that are text whatever their type says: notes, source code, settings, records. */
const TEXT_ENDINGS = new Set(
  (
    'txt text log py pyw js mjs cjs ts tsx jsx json jsonl xml html htm xhtml css scss less c h cc cpp cxx hpp cs ' +
    'java kt kts scala go rs rb php pl pm lua r m mm swift dart sh bash zsh fish bat cmd ps1 sql yml yaml toml ' +
    'ini cfg conf properties env gradle cmake mk tex bib srt vtt diff patch pem crt asc gitignore dockerfile ' +
    'makefile readme license ino v vhd asm s hs ml clj ex exs erl jl nim ipynb rst adoc org'
  ).split(' '),
);
const TEXT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/x-sh',
  'application/x-python',
  'application/x-httpd-php',
  'application/sql',
  'application/x-yaml',
  'application/toml',
  'application/x-tex',
]);

/** The ending of a file's name, in small letters; a name with no dot is its own ending. */
export function endingOf(name: string): string {
  const base = name.trim().toLowerCase().split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1) : base.replace(/^\./, '');
}

/** Whether an attachment is drawn in the note as a picture. */
export function isPicture(mime: string, name: string): boolean {
  const type = mime.trim().toLowerCase();
  if (type.startsWith('image/')) return true;
  return SAYS_NOTHING.has(type) && PICTURE_ENDINGS.has(endingOf(name));
}

/** The preview an attachment can be read in, if there is one for it. */
export function previewKind(mime: string, name: string): PreviewKind | null {
  const type = mime.trim().toLowerCase().split(';')[0]?.trim() ?? '';
  const ending = endingOf(name);
  if (type === 'application/pdf' || ending === 'pdf') return 'pdf';
  if (type === 'application/epub+zip' || ending === 'epub') return 'book';
  if (type === 'text/markdown' || type === 'text/x-markdown' || MARKDOWN_ENDINGS.has(ending))
    return 'markdown';
  if (type === 'text/csv' || type === 'text/tab-separated-values' || TABLE_ENDINGS.has(ending))
    return 'table';
  if (ARCHIVE_TYPES.has(type) || ending === 'zip') return 'archive';
  // Pictures, sound and film are shown where they stand in the note.
  if (/^(image|audio|video)\//.test(type)) return null;
  if (type.startsWith('text/') || TEXT_TYPES.has(type) || TEXT_ENDINGS.has(ending)) return 'text';
  return null;
}

/** What the button that opens a preview says. */
export const PREVIEW_LABELS: Record<PreviewKind, string> = {
  pdf: 'Preview PDF',
  book: 'Read book',
  markdown: 'Preview',
  table: 'Preview table',
  text: 'Preview text',
  archive: 'List contents',
};

/** Rows of a table of text: values divided by commas, tabs or semicolons, as spreadsheets write them. */
export function parseTable(text: string, mostRows: number): { rows: string[][]; more: boolean } {
  const body = text.replace(/^\uFEFF/, '');
  // The divider is the one the first line has most of, outside quotes.
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  const unquoted = firstLine.replace(/"[^"]*"/g, '');
  const divider =
    [',', '\t', ';']
      .map((mark) => [mark, unquoted.split(mark).length] as const)
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  let more = false;
  const endRow = () => {
    row.push(value);
    value = '';
    // An empty line is no row.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  for (let at = 0; at < body.length; at += 1) {
    const character = body[at];
    if (rows.length >= mostRows) {
      more = true;
      break;
    }
    if (quoted) {
      if (character === '"' && body[at + 1] === '"') {
        value += '"';
        at += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"' && value === '') {
      quoted = true;
    } else if (character === divider) {
      row.push(value);
      value = '';
    } else if (character === '\n') {
      endRow();
    } else if (character !== '\r') {
      value += character;
    }
  }
  if (!more && (value !== '' || row.length)) endRow();
  return { rows, more };
}

/**
 * The text of a file whose bytes these are. Nearly every text is UTF-8; one
 * that is not is read as Windows wrote text before it, which shows every
 * byte as some letter. A file that says it is UTF-16 at its start is that.
 */
export function textOfBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    // Read as a text that goes on: one cut off in the middle of a letter is still UTF-8.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
