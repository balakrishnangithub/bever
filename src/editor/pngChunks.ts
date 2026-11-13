/**
 * What Evernote keeps inside a picture besides the picture: the annotations
 * of an annotated picture, described first, and the strokes of a sketch,
 * described further down.
 *
 * Evernote's annotation tool (Skitch) saves a picture as an ordinary PNG of
 * the finished result and adds two kinds of chunk that other programs skip:
 *
 * - `skRf`: an original, unmarked picture, behind a 16-byte identifier;
 * - `skMf`: a JSON document that places those originals and lists every
 *   mark drawn on them.
 *
 * With both, the marks can be changed later. This module only takes such a
 * file apart and puts one together; `skitch.ts` understands the document.
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface PngChunk {
  type: string;
  data: Uint8Array;
  /** The checksum the chunk was read with; a chunk made here has none yet. */
  crc?: number;
}

export function isPng(bytes: Uint8Array): boolean {
  return SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/** The chunks of a PNG, in order. Stops quietly at a damaged chunk. */
export function readChunks(bytes: Uint8Array): PngChunk[] {
  if (!isPng(bytes)) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let offset = SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (offset + 12 + length > bytes.length) break;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    chunks.push({
      type,
      data: bytes.subarray(offset + 8, offset + 8 + length),
      crc: view.getUint32(offset + 8 + length),
    });
    offset += 12 + length;
  }
  return chunks;
}

/** The width and height a PNG says it has. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const header = readChunks(bytes).find((chunk) => chunk.type === 'IHDR')?.data;
  if (!header || header.length < 8) return null;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  return { width: view.getUint32(0), height: view.getUint32(4) };
}

let crcTable: Uint32Array | null = null;

function crc32(parts: Uint8Array[]): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[index] = value >>> 0;
    }
  }
  const table = crcTable;
  let crc = 0xffffffff;
  for (const part of parts) {
    // By index: stepping through megabytes with an iterator is several
    // times slower.
    for (let index = 0; index < part.length; index += 1) {
      crc = (table[(crc ^ (part[index] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A PNG made of `chunks`. A chunk that was read keeps the checksum it came
 * with, so that a picture's own data, which is most of the file, is not
 * gone through again; a chunk made here gets its checksum now.
 */
export function writeChunks(chunks: PngChunk[]): Uint8Array {
  const size = SIGNATURE.length + chunks.reduce((sum, chunk) => sum + 12 + chunk.data.length, 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set(SIGNATURE);
  let offset = SIGNATURE.length;
  for (const chunk of chunks) {
    const type = Uint8Array.from(chunk.type, (letter) => letter.charCodeAt(0));
    view.setUint32(offset, chunk.data.length);
    bytes.set(type, offset + 4);
    bytes.set(chunk.data, offset + 8);
    view.setUint32(offset + 8 + chunk.data.length, chunk.crc ?? crc32([type, chunk.data]));
    offset += 12 + chunk.data.length;
  }
  return bytes;
}

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** `1a642354-b7d3-…` as the 16 bytes that stand in front of an original. */
function identifierBytes(guid: string): Uint8Array {
  const digits = guid.replace(/[^0-9a-f]/gi, '').padEnd(32, '0');
  return Uint8Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16),
  );
}

function identifierText(bytes: Uint8Array): string {
  const digits = hex(bytes);
  return [
    digits.slice(0, 8),
    digits.slice(8, 12),
    digits.slice(12, 16),
    digits.slice(16, 20),
    digits.slice(20),
  ].join('-');
}

export interface EmbeddedOriginal {
  /** The identifier stored in front of it, as `1a642354-b7d3-…`. */
  guid: string;
  bytes: Uint8Array;
}

/**
 * The original the document's `index`-th picture, named `guid`, refers to.
 * Files saved on a phone store an identifier that the document does not
 * name anywhere, so a picture that is not found by name is taken by place.
 */
export function originalFor(originals: EmbeddedOriginal[], guid: string, index: number): Uint8Array | null {
  const named = originals.find((original) => original.guid === guid.toLowerCase());
  return (named ?? originals[index] ?? originals[0])?.bytes ?? null;
}

export interface EmbeddedAnnotations {
  /** The annotation document, as Evernote wrote it. */
  manifest: unknown;
  /** The unmarked pictures, in the order they are stored. */
  originals: EmbeddedOriginal[];
}

/** The annotation data inside a picture, or null when it carries none. */
export function readAnnotations(bytes: Uint8Array): EmbeddedAnnotations | null {
  const chunks = readChunks(bytes);
  const manifest = chunks.find((chunk) => chunk.type === 'skMf');
  if (!manifest) return null;
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder().decode(manifest.data));
  } catch {
    return null;
  }
  const originals: EmbeddedOriginal[] = [];
  for (const chunk of chunks) {
    if (chunk.type === 'skRf' && chunk.data.length > 16) {
      originals.push({ guid: identifierText(chunk.data.subarray(0, 16)), bytes: chunk.data.subarray(16) });
    }
  }
  return { manifest: document, originals };
}

/**
 * `picture`, a PNG of the finished result, with the annotation data added
 * the way Evernote adds it: after the picture's own data and before the
 * end, where a program that does not know the chunks passes over them.
 */
export function writeAnnotations(picture: Uint8Array, annotations: EmbeddedAnnotations): Uint8Array {
  const chunks = readChunks(picture).filter((chunk) => chunk.type !== 'skRf' && chunk.type !== 'skMf');
  const end = chunks.findIndex((chunk) => chunk.type === 'IEND');
  if (end < 0) throw new Error('The picture is not a complete PNG.');
  const added: PngChunk[] = [];
  for (const original of annotations.originals) {
    const data = new Uint8Array(16 + original.bytes.length);
    data.set(identifierBytes(original.guid));
    data.set(original.bytes, 16);
    added.push({ type: 'skRf', data });
  }
  added.push({ type: 'skMf', data: new TextEncoder().encode(JSON.stringify(annotations.manifest)) });
  return writeChunks([...chunks.slice(0, end), ...added, ...chunks.slice(end, end + 1)]);
}

// --- Sketches -------------------------------------------------------------
//
// A sketch drawn in Evernote is also a PNG of the finished result. Its ink
// is in two more chunks:
//
// - `enIs`: a short JSON text with the sketch's name and the picture's size;
// - `enIz`: the strokes, as InkML compressed with gzip.
//
// `ink.ts` understands the InkML.

export interface EmbeddedInk {
  /** The sketch's own identifier, the same in both chunks. */
  name: string;
  /** The strokes, as InkML. */
  inkml: string;
}

/** Whether the picture is a sketch whose strokes can be read. */
export function hasInk(bytes: Uint8Array): boolean {
  return readChunks(bytes).some((chunk) => chunk.type === 'enIz');
}

/** Passes `bytes` through a compression stream and collects what comes out. */
async function through(bytes: Uint8Array, stream: GenericTransformStream): Promise<Uint8Array> {
  const writer = (stream.writable as WritableStream<Uint8Array>).getWriter();
  // Written without waiting: the reader below is what lets the data move.
  const written = writer.write(bytes).then(() => writer.close());
  // Data that cannot be read fails here and at the reader; the reader's
  // failure is the one that is reported.
  written.catch(() => undefined);
  const reader = (stream.readable as ReadableStream<Uint8Array>).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
  }
  await written;
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** The ink inside a picture, or null when it has none that can be read. */
export async function readInk(bytes: Uint8Array): Promise<EmbeddedInk | null> {
  const chunks = readChunks(bytes);
  const strokes = chunks.find((chunk) => chunk.type === 'enIz');
  if (!strokes) return null;
  let name = '';
  const header = chunks.find((chunk) => chunk.type === 'enIs');
  if (header) {
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(header.data));
      const found = (parsed as { name?: unknown } | null)?.name;
      if (typeof found === 'string') name = found;
    } catch {
      // The strokes name the sketch as well.
    }
  }
  try {
    const inkml = new TextDecoder().decode(await through(strokes.data, new DecompressionStream('gzip')));
    return { name, inkml };
  } catch {
    return null;
  }
}

/**
 * `picture`, a PNG of the finished sketch, with its ink added the way
 * Evernote adds it: after the picture's own data and before the end.
 */
export async function writeInk(
  picture: Uint8Array,
  ink: EmbeddedInk & { width: number; height: number },
): Promise<Uint8Array> {
  const chunks = readChunks(picture).filter((chunk) => chunk.type !== 'enIs' && chunk.type !== 'enIz');
  const end = chunks.findIndex((chunk) => chunk.type === 'IEND');
  if (end < 0) throw new Error('The picture is not a complete PNG.');
  const encoder = new TextEncoder();
  const header = JSON.stringify({ name: ink.name, width: ink.width, height: ink.height });
  const added: PngChunk[] = [
    { type: 'enIs', data: encoder.encode(header) },
    { type: 'enIz', data: await through(encoder.encode(ink.inkml), new CompressionStream('gzip')) },
  ];
  return writeChunks([...chunks.slice(0, end), ...added, ...chunks.slice(end, end + 1)]);
}
