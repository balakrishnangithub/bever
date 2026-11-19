import { describe, expect, it } from 'vitest';

import { chapterOfAddress, chapterPage, openBook, resolvePath, type BookFiles } from './epub';

const text = (value: string) => new TextEncoder().encode(value);

function filesOf(files: Record<string, string>): BookFiles {
  return {
    has: (path) => path in files,
    read: (path) => Promise.resolve(text(files[path] ?? '')),
  };
}

const CONTAINER =
  '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
  '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';

const page = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>t</title><link rel="stylesheet" href="style.css"/><script>window.ran = true</script></head><body>${body}</body></html>`;

/** A book in the newer form: its table of contents is one of its pages. */
const BOOK: Record<string, string> = {
  mimetype: 'application/epub+zip',
  'META-INF/container.xml': CONTAINER,
  'OEBPS/content.opf':
    '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">' +
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>  Rivers of\n the North </dc:title></metadata>' +
    '<manifest>' +
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
    '<item id="one" href="text/one.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="two" href="text/two%20more.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="gone" href="text/gone.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="map" href="images/map.png" media-type="image/png"/>' +
    '</manifest>' +
    '<spine><itemref idref="one"/><itemref idref="gone"/><itemref idref="two"/></spine></package>',
  'OEBPS/nav.xhtml': page(
    '<nav epub:type="toc"><ol><li><a href="text/one.xhtml">The source</a></li>' +
      '<li><a href="text/one.xhtml#falls">The falls</a></li></ol></nav>',
  ),
  'OEBPS/text/one.xhtml': page(
    '<h1 class="title" id="top">The source</h1><p style="position:fixed;color:red">Water<br/>rises.</p>' +
      '<p><img src="../images/map.png" alt="Map"/><img src="https://example.com/track.png"/><img src="../../outside.png"/></p>' +
      '<p><a href="two%20more.xhtml#start">On</a> <a href="https://example.com/">Web</a> <a href="#top">Up</a></p>' +
      '<iframe src="https://example.com/"></iframe><script>window.ran = true</script>',
  ),
  'OEBPS/text/two more.xhtml': page(
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">' +
      '<image width="10" height="10" xlink:href="../images/map.png"/></svg><p>The mouth.</p>',
  ),
  'OEBPS/images/map.png': 'not really a picture',
};

const shown = (content: DocumentFragment) => {
  const holder = document.createElement('div');
  holder.appendChild(content);
  return holder.innerHTML;
};

describe('an EPUB book', () => {
  it('names what a path in it points to, and nothing outside it', () => {
    expect(resolvePath('OEBPS/text/one.xhtml', '../images/map.png')).toBe('OEBPS/images/map.png');
    expect(resolvePath('OEBPS/text/one.xhtml', 'two%20more.xhtml#start')).toBe('OEBPS/text/two more.xhtml');
    expect(resolvePath('content.opf', 'text/one.xhtml')).toBe('text/one.xhtml');
    expect(resolvePath('OEBPS/content.opf', '/cover.png')).toBe('cover.png');
    expect(resolvePath('OEBPS/text/one.xhtml', '../../../etc/passwd')).toBeNull();
    expect(resolvePath('OEBPS/text/one.xhtml', 'https://example.com/a.png')).toBeNull();
    expect(resolvePath('OEBPS/text/one.xhtml', '//example.com/a.png')).toBeNull();
    expect(resolvePath('OEBPS/text/one.xhtml', '#top')).toBeNull();
  });

  it('has its chapters in reading order, called what its contents call them', async () => {
    const book = await openBook(filesOf(BOOK));
    expect(book.title).toBe('Rivers of the North');
    // The chapter whose page is not in the archive is passed over; the one
    // the contents do not name is the one before it going on.
    expect(book.chapters).toEqual([
      { path: 'OEBPS/text/one.xhtml', title: 'The source' },
      { path: 'OEBPS/text/two more.xhtml', title: 'The source (2)' },
    ]);
    // With no name before it, a chapter is numbered.
    const unnamed = { ...BOOK, 'OEBPS/nav.xhtml': page('<nav epub:type="toc"><ol></ol></nav>') };
    expect((await openBook(filesOf(unnamed))).chapters.map((chapter) => chapter.title)).toEqual([
      'Part 1',
      'Part 2',
    ]);
  });

  it('reads the older table of contents too', async () => {
    const older = {
      ...BOOK,
      'OEBPS/content.opf': BOOK['OEBPS/content.opf']!.replace(
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
        '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
      ).replace('version="3.0"', 'version="2.0"'),
      'OEBPS/toc.ncx':
        '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>' +
        '<navPoint id="a"><navLabel><text>Springs</text></navLabel><content src="text/one.xhtml"/></navPoint>' +
        '<navPoint id="b"><navLabel><text>The sea</text></navLabel><content src="text/two%20more.xhtml#start"/></navPoint>' +
        '</navMap></ncx>',
    };
    expect((await openBook(filesOf(older))).chapters.map((chapter) => chapter.title)).toEqual([
      'Springs',
      'The sea',
    ]);
  });

  it('shows a chapter with the pictures it names in the book, and nothing it could do harm with', async () => {
    const files = filesOf(BOOK);
    const book = await openBook(files);
    const first = await chapterPage(files, book, 0);
    const html = shown(first.content);
    // Its own picture, by an address made here; none from the web or from outside the book.
    const pictures = [...html.matchAll(/<img[^>]*>/g)].map((match) => match[0]);
    expect(pictures).toHaveLength(1);
    expect(pictures[0]).toMatch(
      /^<img alt="Map" src="blob:[^"]+" referrerpolicy="no-referrer" loading="lazy">$/,
    );
    // No script, no frame, no style that would lay it over the application.
    expect(html).not.toMatch(/script|iframe|fixed|window\.ran/);
    expect(html).toContain('<p style="color:red">Water<br>rises.</p>');
    // A link to another chapter goes there; one to the web stays; one within the page has no address.
    expect(html).toContain(
      '<a href="#chapter-1" rel="noopener noreferrer">On</a> <a href="https://example.com/" rel="noopener noreferrer">Web</a> <a rel="noopener noreferrer">Up</a>',
    );
    expect(chapterOfAddress('#chapter-1')).toBe(1);
    expect(chapterOfAddress('https://example.com/#chapter-1')).toBeNull();
    first.release();

    // A drawing that holds one picture, as a cover does, is shown as that picture.
    const second = await chapterPage(files, book, 1);
    expect(shown(second.content)).toMatch(
      /^<img src="blob:[^"]+" referrerpolicy="no-referrer" loading="lazy"><p>The mouth\.<\/p>$/,
    );
    second.release();
  });

  it('says so when the archive is not a book', async () => {
    await expect(openBook(filesOf({ 'readme.txt': 'hello' }))).rejects.toThrow('could not be read');
    await expect(
      openBook(
        filesOf({ 'META-INF/container.xml': CONTAINER, 'OEBPS/content.opf': '<package><spine/></package>' }),
      ),
    ).rejects.toThrow('could not be read');
  });
});
