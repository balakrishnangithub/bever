/**
 * Reads a ZIP archive a part at a time: its list of files from the end, and
 * one file when it is asked for. An EPUB book is such an archive, and may be
 * a hundred megabytes of pictures of which a chapter needs two.
 *
 * The archive comes from an imported file or another device, so nothing it
 * says about itself is trusted: sizes are checked against what is there,
 * and a file is unpacked no further than it says it is long.
 */

/** Something whose bytes can be asked for by place. */
export interface ByteSource {
  size: number;
  read(from: number, length: number): Promise<Uint8Array>;
}

export interface ZipEntry {
  /** With `/` between folders, as the archive names it. */
  name: string;
  /** Unpacked. */
  size: number;
  packedSize: number;
  /** 0 is stored as it is, 8 is deflate; nothing else is read here. */
  method: number;
  /** Where the file's own header begins. */
  offset: number;
  directory: boolean;
}

/** Most bytes of one file that are unpacked: a file that claims more is refused. */
export const LARGEST_FILE = 96 * 1024 * 1024;
/** Most files listed: an archive with more is cut short there. */
const MOST_FILES = 20_000;

export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: (from, length) => Promise.resolve(bytes.subarray(from, Math.min(bytes.length, from + length))),
  };
}

/**
 * The file at an address, read by ranges where the address answers them
 * (an attachment does), and whole into memory where it does not.
 */
export async function urlSource(url: string): Promise<ByteSource> {
  const whole = async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error('The file could not be read.');
    return bytesSource(new Uint8Array(await response.arrayBuffer()));
  };
  let first: Response;
  try {
    first = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  } catch {
    return whole();
  }
  const total = Number(/\/(\d+)\s*$/.exec(first.headers.get('Content-Range') ?? '')?.[1]);
  if (first.status !== 206 || !Number.isFinite(total)) {
    if (first.status === 200) return bytesSource(new Uint8Array(await first.arrayBuffer()));
    return whole();
  }
  return {
    size: total,
    read: async (from, length) => {
      const end = Math.min(total, from + length);
      const bytes = new Uint8Array(Math.max(0, end - from));
      let filled = 0;
      // An answer may be shorter than what was asked for; the rest is asked for again.
      while (filled < bytes.length) {
        const response = await fetch(url, { headers: { Range: `bytes=${from + filled}-${end - 1}` } });
        if (response.status !== 206) throw new Error('The file could not be read.');
        const part = new Uint8Array(await response.arrayBuffer());
        if (!part.length) throw new Error('The file ended before it should have.');
        bytes.set(part.subarray(0, bytes.length - filled), filled);
        filled += part.length;
      }
      return bytes;
    },
  };
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function nameOf(bytes: Uint8Array, utf8: boolean): string {
  if (!utf8) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** The files of an archive, in the order its list has them. */
export async function zipEntries(source: ByteSource): Promise<ZipEntry[]> {
  const unreadable = () => new Error('This is not an archive that can be read here.');
  // The list is named at the very end, before a comment of up to 65,535 bytes.
  const tailLength = Math.min(source.size, 65_535 + 22);
  const tail = await source.read(source.size - tailLength, tailLength);
  const tailView = view(tail);
  let end = -1;
  for (let at = tail.length - 22; at >= 0; at -= 1) {
    if (tailView.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw unreadable();
  const count = tailView.getUint16(end + 10, true);
  const listLength = tailView.getUint32(end + 12, true);
  const listOffset = tailView.getUint32(end + 16, true);
  // Archives of more than four gigabytes say so with these values, and keep
  // the true ones elsewhere. None is expected among attachments.
  if (count === 0xffff || listOffset === 0xffffffff || listOffset + listLength > source.size) {
    throw unreadable();
  }
  const list = await source.read(listOffset, listLength);
  const listView = view(list);
  const entries: ZipEntry[] = [];
  let at = 0;
  while (at + 46 <= list.length && entries.length < MOST_FILES) {
    if (listView.getUint32(at, true) !== 0x02014b50) break;
    const flags = listView.getUint16(at + 8, true);
    const nameLength = listView.getUint16(at + 28, true);
    const extraLength = listView.getUint16(at + 30, true);
    const commentLength = listView.getUint16(at + 32, true);
    if (at + 46 + nameLength > list.length) break;
    const name = nameOf(list.subarray(at + 46, at + 46 + nameLength), (flags & 0x800) !== 0).replaceAll(
      '\\',
      '/',
    );
    entries.push({
      name,
      size: listView.getUint32(at + 24, true),
      packedSize: listView.getUint32(at + 20, true),
      method: listView.getUint16(at + 10, true),
      offset: listView.getUint32(at + 42, true),
      directory: name.endsWith('/'),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Unpacks deflated bytes, and stops if they come to more than `most`. */
async function inflate(packed: Uint8Array, most: number): Promise<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(packed);
      controller.close();
    },
  }).pipeThrough(new DecompressionStream('deflate-raw') as ReadableWritablePair<Uint8Array, Uint8Array>);
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > most) {
      await reader.cancel();
      throw new Error('A file in the archive is longer than it says.');
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let filled = 0;
  for (const part of parts) {
    bytes.set(part, filled);
    filled += part.length;
  }
  return bytes;
}

/** One file of the archive, unpacked. */
export async function readEntry(source: ByteSource, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.size > LARGEST_FILE || entry.packedSize > LARGEST_FILE) {
    throw new Error('A file in the archive is too large to show.');
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error('A file in the archive is packed in a way that cannot be read here.');
  }
  const header = await source.read(entry.offset, 30);
  if (header.length < 30 || view(header).getUint32(0, true) !== 0x04034b50) {
    throw new Error('The archive is damaged.');
  }
  const start = entry.offset + 30 + view(header).getUint16(26, true) + view(header).getUint16(28, true);
  if (start + entry.packedSize > source.size) throw new Error('The archive is damaged.');
  const packed = await source.read(start, entry.packedSize);
  return entry.method === 0 ? packed : inflate(packed, entry.size);
}

/**
 * An archive of files stored as they are, for the demonstration and the
 * tests: nothing is packed, so it needs no packer.
 */
export function storedZip(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const table = new Uint32Array(256).map((_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let value = 0xffffffff;
    for (const byte of bytes) value = (table[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  };
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const list: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const sum = crc(file.bytes);
    const local = new Uint8Array(30 + name.length);
    const localView = view(local);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x800, true);
    localView.setUint32(14, sum, true);
    localView.setUint32(18, file.bytes.length, true);
    localView.setUint32(22, file.bytes.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    const listed = new Uint8Array(46 + name.length);
    const listedView = view(listed);
    listedView.setUint32(0, 0x02014b50, true);
    listedView.setUint16(4, 20, true);
    listedView.setUint16(6, 20, true);
    listedView.setUint16(8, 0x800, true);
    listedView.setUint32(16, sum, true);
    listedView.setUint32(20, file.bytes.length, true);
    listedView.setUint32(24, file.bytes.length, true);
    listedView.setUint16(28, name.length, true);
    listedView.setUint32(42, offset, true);
    listed.set(name, 46);
    parts.push(local, file.bytes);
    list.push(listed);
    offset += local.length + file.bytes.length;
  }
  const listLength = list.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = view(end);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, listLength, true);
  endView.setUint32(16, offset, true);
  const all = [...parts, ...list, end];
  const bytes = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let filled = 0;
  for (const part of all) {
    bytes.set(part, filled);
    filled += part.length;
  }
  return bytes;
}
