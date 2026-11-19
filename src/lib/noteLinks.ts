import { api } from './api';

/**
 * Links to notes that say nothing but an address.
 *
 * A link to another note usually has words for its text: the title the
 * note had when the link was made. Evernote also makes links whose text is
 * the link's own address (`evernote:///view/…`), and shows such a link by
 * the title the note has now, which it looks up each time. The note itself
 * goes on saying the address.
 *
 * Here it is the same. The page given to the editor has the title where
 * the address was, and each such link remembers what it said
 * (`withLinkTitles`); the page that is stored has the address again, unless
 * the text of the link was changed by hand (`withLinkAddresses`). So a note
 * is not changed by being shown, and what is exported is what was imported.
 */

const NOTE = 'bever://note/';
/** What a link remembers of itself while it is shown by a title. */
export const ADDRESS_ATTRIBUTE = 'data-note-address';
export const TITLE_ATTRIBUTE = 'data-note-title';

/** A link to a note of this library whose text is text only: its attributes, the note, the text. */
const PLAIN_LINK = /<a\b([^>]*?\bhref\s*=\s*"bever:\/\/note\/([^"]+)"[^>]*)>([^<]*)<\/a>/gi;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
const decoded = (text: string) =>
  text.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name: string) => ENTITIES[name] ?? '');
const escaped = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Whether a text is nothing but the address of a note: Evernote's, or this library's. */
export const isNoteAddress = (text: string) =>
  /^(evernote:\/\/\/view\/|https?:\/\/(www\.)?evernote\.com\/(shard|l)\/|bever:\/\/note\/)\S+$/i.test(
    text.trim(),
  );

/** The titles learnt so far, by the id of the note. */
const titles = new Map<string, string>();

/** The notes that links of this page lead to while saying only an address. */
export function addressedNotes(html: string): string[] {
  if (!html.includes(NOTE)) return [];
  const ids = new Set<string>();
  for (const match of html.matchAll(PLAIN_LINK)) {
    if (isNoteAddress(decoded(match[3] ?? ''))) ids.add(decoded(match[2] ?? ''));
  }
  return [...ids];
}

/**
 * Looks up the titles that the links of a page are to be shown by. Asked
 * again for every page, so that a note renamed since is shown by its new
 * name; a title that cannot be had leaves the link saying its address.
 */
export async function learnLinkTitles(html: string): Promise<void> {
  const ids = addressedNotes(html);
  if (!ids.length) return;
  try {
    const found = await api.noteTitles(ids);
    for (const id of ids) {
      const title = found[id];
      if (title === undefined) titles.delete(id);
      else titles.set(id, title.trim() || 'Untitled');
    }
  } catch {
    // The links say what they said.
  }
}

/** The page as it is shown: links that say only an address say the title of their note. */
export function withLinkTitles(html: string): string {
  if (!html.includes(NOTE)) return html;
  return html.replace(PLAIN_LINK, (whole, attributes: string, id: string, text: string) => {
    const title = titles.get(decoded(id));
    if (title === undefined || !isNoteAddress(decoded(text))) return whole;
    // What it said, and what it was given to say: by the two, a link that
    // was not touched is known from one whose text was changed.
    return `<a${attributes} ${ADDRESS_ATTRIBUTE}="${escaped(decoded(text))}" ${TITLE_ATTRIBUTE}="${escaped(title)}">${escaped(title)}</a>`;
  });
}

/**
 * The page as it is stored, made from the elements the editor wrote: a link
 * that still says the title it was given says its address again. One whose
 * text was changed keeps the text it has. Neither keeps the marks.
 */
export function withLinkAddresses(page: ParentNode): void {
  for (const link of page.querySelectorAll(`a[${ADDRESS_ATTRIBUTE}]`)) {
    const address = link.getAttribute(ADDRESS_ATTRIBUTE);
    const title = link.getAttribute(TITLE_ATTRIBUTE);
    link.removeAttribute(ADDRESS_ATTRIBUTE);
    link.removeAttribute(TITLE_ATTRIBUTE);
    if (!address || link.textContent !== title) continue;
    const texts: Text[] = [];
    const walker = link.ownerDocument.createTreeWalker(link, 4 /* NodeFilter.SHOW_TEXT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
    // In one piece it is the text that was put there; in several, part of
    // it was given a look of its own, and it is the writer's.
    if (texts.length === 1 && texts[0]) texts[0].data = address;
  }
}

/** For tests: what is known is forgotten. */
export function forgetLinkTitles(): void {
  titles.clear();
}
