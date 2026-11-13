import type { FindTerm } from '../editor/recognition';

const OPERATORS = new Set([
  'any',
  'intitle',
  'tag',
  'notebook',
  'stack',
  'created',
  'updated',
  'resource',
  'todo',
  'encryption',
  'contains',
  'source',
  'sourceurl',
]);

/**
 * The words of a library search that a note's content can show: its plain
 * terms and quoted phrases. Operators such as `tag:` or `created:` choose
 * notes by something else, and an excluded term (`-word`) is not in the note.
 *
 * It reads a search as the library does; see `tokenize` in `search.rs`.
 */
export function searchTerms(query: string): FindTerm[] {
  const tokens: { raw: string; quoted: boolean }[] = [];
  let current = '';
  let quoted = false;
  let wasQuoted = false;
  let escaped = false;
  for (const character of query) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
      wasQuoted = true;
    } else if (/\s/.test(character) && !quoted) {
      if (current || wasQuoted) tokens.push({ raw: current, quoted: wasQuoted });
      current = '';
      wasQuoted = false;
    } else {
      current += character;
    }
  }
  if (current) tokens.push({ raw: current, quoted: wasQuoted });

  const terms: FindTerm[] = [];
  for (const token of tokens) {
    if (token.raw.startsWith('-') && token.raw.length > 1) continue;
    const colon = token.raw.indexOf(':');
    if (colon >= 0 && OPERATORS.has(token.raw.slice(0, colon).toLowerCase())) continue;
    const text = token.raw.replace(/\*+$/, '');
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    if (!terms.some((term) => term.text.toLowerCase() === text.toLowerCase())) {
      terms.push({ text, mode: token.quoted ? 'words' : 'prefix' });
    }
  }
  return terms;
}
