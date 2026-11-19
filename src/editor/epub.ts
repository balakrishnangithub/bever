/**
 * Reads an EPUB book: which chapters it has, in which order, what they are
 * called, and the pages of one of them with its pictures.
 *
 * A book is an archive of web pages with a list that puts them in order.
 * Nothing in it is trusted: its pages are shown through the sanitizer that
 * clippings go through, its style sheets and scripts are left where they
 * are, and it names nothing that is not inside the archive.
 */
import { sanitizeNode } from './clipSanitizer';

/** The files of a book, by their path in the archive. */
export interface BookFiles {
  has(path: string): boolean;
  read(path: string): Promise<Uint8Array>;
}

export interface Chapter {
  /** Its page's path in the archive. */
  path: string;
  title: string;
}

export interface Book {
  title: string;
  chapters: Chapter[];
}

/** Most pictures of one chapter that are shown: a picture book's chapter may name hundreds. */
const MOST_PICTURES = 400;

const PICTURES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  // As a picture a drawing runs nothing, whatever is written in it.
  svg: 'image/svg+xml',
};

const decode = (bytes: Uint8Array) => new TextDecoder('utf-8').decode(bytes);
const parseXml = (text: string) => new DOMParser().parseFromString(text, 'application/xml');
/** Elements by their name, whatever namespace a book writes them in. */
const all = (root: Document | Element, name: string) => [...root.getElementsByTagNameNS('*', name)];
const failed = (document: Document) => document.getElementsByTagName('parsererror').length > 0;

/**
 * The path in the archive that `address` names when it stands in the file
 * at `from`; null when it names something outside the book.
 */
export function resolvePath(from: string, address: string): string | null {
  const bare = address.split('#')[0]?.split('?')[0] ?? '';
  if (!bare || /^[a-z][a-z0-9+.-]*:/i.test(bare) || bare.startsWith('//')) return null;
  let path: string;
  try {
    path = decodeURIComponent(bare);
  } catch {
    path = bare;
  }
  const parts = path.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

/** What the chapters are called: by the book's table of contents, as far as it has one. */
async function chapterTitles(
  files: BookFiles,
  manifest: { path: string; type: string; properties: string }[],
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const name = (path: string | null, title: string | null | undefined) => {
    const text = title?.replace(/\s+/g, ' ').trim();
    if (path && text && !titles.has(path)) titles.set(path, text);
  };
  try {
    const navigation = manifest.find((item) => item.properties.split(/\s+/).includes('nav'));
    if (navigation && files.has(navigation.path)) {
      const page = parseXml(decode(await files.read(navigation.path)));
      const lists = all(page, 'nav');
      const list = lists.find((nav) => /toc/.test(nav.getAttribute('epub:type') ?? '')) ?? lists[0];
      for (const link of list ? all(list, 'a') : []) {
        name(resolvePath(navigation.path, link.getAttribute('href') ?? ''), link.textContent);
      }
    }
    const older = manifest.find((item) => item.type === 'application/x-dtbncx+xml');
    if (!titles.size && older && files.has(older.path)) {
      const list = parseXml(decode(await files.read(older.path)));
      for (const point of all(list, 'navPoint')) {
        const source = all(point, 'content')[0]?.getAttribute('src') ?? '';
        name(resolvePath(older.path, source), all(point, 'text')[0]?.textContent);
      }
    }
  } catch {
    // A table of contents that cannot be read leaves the chapters numbered.
  }
  return titles;
}

/** The book's title and its chapters, in reading order. */
export async function openBook(files: BookFiles): Promise<Book> {
  const unreadable = () => new Error('This book could not be read: it is not put together as an EPUB is.');
  if (!files.has('META-INF/container.xml')) throw unreadable();
  const container = parseXml(decode(await files.read('META-INF/container.xml')));
  const packagePath = all(container, 'rootfile')[0]?.getAttribute('full-path');
  if (!packagePath || !files.has(packagePath)) throw unreadable();
  const description = parseXml(decode(await files.read(packagePath)));
  if (failed(description)) throw unreadable();

  const manifest = all(description, 'item').map((item) => ({
    id: item.getAttribute('id') ?? '',
    path: resolvePath(packagePath, item.getAttribute('href') ?? '') ?? '',
    type: (item.getAttribute('media-type') ?? '').toLowerCase(),
    properties: item.getAttribute('properties') ?? '',
  }));
  const byId = new Map(manifest.map((item) => [item.id, item]));
  const titles = await chapterTitles(files, manifest);
  const chapters: Chapter[] = [];
  // A chapter is often cut into several files, of which the table of
  // contents names the first: the others are that chapter going on.
  let named = '';
  let parts = 1;
  for (const reference of all(description, 'itemref')) {
    const item = byId.get(reference.getAttribute('idref') ?? '');
    if (!item?.path || !files.has(item.path)) continue;
    const own = titles.get(item.path);
    if (own) {
      named = own;
      parts = 1;
    } else {
      parts += 1;
    }
    const title = own ?? (named ? `${named} (${parts})` : `Part ${chapters.length + 1}`);
    chapters.push({ path: item.path, title });
  }
  if (!chapters.length) throw unreadable();
  const title = all(description, 'title')[0]?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  return { title, chapters };
}

export interface ChapterPage {
  content: DocumentFragment;
  /** Gives the chapter's pictures back; call it when the chapter is no longer shown. */
  release: () => void;
}

/** A link in a chapter that goes to another chapter of the book is given this address. */
export const chapterAddress = (index: number) => `#chapter-${index}`;
export const chapterOfAddress = (address: string): number | null => {
  const match = /^#chapter-(\d+)$/.exec(address);
  return match ? Number(match[1]) : null;
};

/** The page of one chapter, safe to show, with the pictures it names in the book. */
export async function chapterPage(files: BookFiles, book: Book, index: number): Promise<ChapterPage> {
  const chapter = book.chapters[index];
  if (!chapter) throw new Error('The book has no such chapter.');
  const text = decode(await files.read(chapter.path));
  // A chapter is XML, where an element may close itself as none may in
  // HTML; read as HTML only when it is not the XML it should be.
  let page = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  if (failed(page)) page = new DOMParser().parseFromString(text, 'text/html');
  const body = all(page, 'body')[0] ?? page.documentElement;

  // A cover is often a drawing with one picture in it; the picture is shown.
  for (const drawing of all(body, 'svg')) {
    const pictures = all(drawing, 'image');
    const source = pictures[0]?.getAttribute('xlink:href') ?? pictures[0]?.getAttribute('href');
    if (pictures.length !== 1 || !source) continue;
    const picture = page.createElementNS('http://www.w3.org/1999/xhtml', 'img');
    picture.setAttribute('src', source);
    drawing.replaceWith(picture);
  }

  const urls = new Map<string, string>();
  const made: string[] = [];
  for (const picture of all(body, 'img').slice(0, MOST_PICTURES)) {
    const source = picture.getAttribute('src')?.trim() ?? '';
    const path = resolvePath(chapter.path, source);
    const type = PICTURES[path?.split('.').pop()?.toLowerCase() ?? ''];
    if (!path || !type || urls.has(source) || !files.has(path)) continue;
    try {
      const url = URL.createObjectURL(new Blob([(await files.read(path)) as BlobPart], { type }));
      urls.set(source, url);
      made.push(url);
    } catch {
      // A picture that cannot be read is left out; the text is still there.
    }
  }

  const places = new Map(book.chapters.map((item, place) => [item.path, place]));
  const { content } = sanitizeNode(body, {
    resource: () => null,
    allowRemote: false,
    image: (source) => urls.get(source) ?? null,
    link: (address) => {
      const place = places.get(resolvePath(chapter.path, address) ?? '');
      return place === undefined ? null : chapterAddress(place);
    },
  });
  return { content, release: () => made.forEach((url) => URL.revokeObjectURL(url)) };
}
