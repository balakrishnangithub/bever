import { describe, expect, it } from 'vitest';

import { bytesSource, readEntry, storedZip, zipEntries, type ByteSource } from './zipFile';

const text = (value: string) => new TextEncoder().encode(value);
const read = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Deflates as an archive does: with no header around the packed bytes. */
async function deflated(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }).pipeThrough(new CompressionStream('deflate-raw') as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** An archive whose one file is deflated: a stored one with that file's method and sizes put right. */
async function packedZip(name: string, content: Uint8Array): Promise<Uint8Array> {
  const packed = await deflated(content);
  const archive = storedZip([{ name, bytes: packed }]);
  const view = new DataView(archive.buffer);
  const list = archive.length - 22 - (46 + text(name).length);
  // The method, then the unpacked size: in the file's header and in the list.
  view.setUint16(8, 8, true);
  view.setUint32(22, content.length, true);
  view.setUint16(list + 10, 8, true);
  view.setUint32(list + 24, content.length, true);
  return archive;
}

describe('a ZIP archive', () => {
  it('lists its files and gives each one back', async () => {
    const source = bytesSource(
      storedZip([
        { name: 'mimetype', bytes: text('application/epub+zip') },
        { name: 'OEBPS/', bytes: new Uint8Array() },
        { name: 'OEBPS/chapter one.xhtml', bytes: text('<p>First</p>') },
        { name: 'OEBPS/Übersicht.txt', bytes: text('Grüße') },
      ]),
    );
    const entries = await zipEntries(source);
    expect(entries.map((entry) => [entry.name, entry.size, entry.directory])).toEqual([
      ['mimetype', 20, false],
      ['OEBPS/', 0, true],
      ['OEBPS/chapter one.xhtml', 12, false],
      ['OEBPS/Übersicht.txt', 7, false],
    ]);
    expect(read(await readEntry(source, entries[2]!))).toBe('<p>First</p>');
    expect(read(await readEntry(source, entries[3]!))).toBe('Grüße');
  });

  it('unpacks a deflated file', async () => {
    const content = text('The same line, many times over.\n'.repeat(400));
    const archive = await packedZip('notes.txt', content);
    expect(archive.length).toBeLessThan(content.length / 10);
    const source = bytesSource(archive);
    const [entry] = await zipEntries(source);
    expect(entry).toMatchObject({ name: 'notes.txt', size: content.length, method: 8 });
    expect(read(await readEntry(source, entry!))).toBe(read(content));
  });

  it('reads only the parts it needs', async () => {
    const large = new Uint8Array(300_000).fill(7);
    const archive = storedZip([
      { name: 'large.bin', bytes: large },
      { name: 'small.txt', bytes: text('found') },
    ]);
    let asked = 0;
    const source: ByteSource = {
      size: archive.length,
      read: (from, length) => {
        asked += Math.min(length, archive.length - from);
        return Promise.resolve(archive.subarray(from, from + length));
      },
    };
    const entries = await zipEntries(source);
    expect(read(await readEntry(source, entries[1]!))).toBe('found');
    // The end of the archive, where its list is named, and the small file: not the large one.
    expect(asked).toBeLessThan(70_000);
  });

  it('refuses what is not an archive, and a file that is longer than it says', async () => {
    await expect(
      zipEntries(bytesSource(text('%PDF-1.7 and so on, for more than twenty-two bytes'))),
    ).rejects.toThrow('not an archive');
    await expect(zipEntries(bytesSource(new Uint8Array(4)))).rejects.toThrow('not an archive');

    // A file that says it unpacks to ten bytes and unpacks to thousands.
    const archive = await packedZip('bomb.txt', text('0'.repeat(50_000)));
    const view = new DataView(archive.buffer);
    const list = archive.length - 22 - (46 + 'bomb.txt'.length);
    view.setUint32(list + 24, 10, true);
    const source = bytesSource(archive);
    const [entry] = await zipEntries(source);
    await expect(readEntry(source, entry!)).rejects.toThrow('longer than it says');

    // A file that claims more than is ever unpacked is not begun.
    view.setUint32(list + 24, 0xf0000000, true);
    const [huge] = await zipEntries(source);
    await expect(readEntry(source, huge!)).rejects.toThrow('too large');
  });
});
