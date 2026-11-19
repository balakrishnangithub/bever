import { describe, expect, it } from 'vitest';

import { isPng, originalFor, readAnnotations, readChunks, writeAnnotations, writeChunks } from './pngChunks';
import {
  arrowOutline,
  bitmapsOf,
  boundsOf,
  hits,
  isWorthKeeping,
  markAt,
  marksOf,
  colorOf,
  moved,
  newDocument,
  recolored,
  resized,
  parseDocument,
  shapeMark,
  stampMark,
  strokeMark,
  textMark,
  textOf,
  toolScale,
  toolSizes,
  weightOf,
  withMarks,
  withText,
  type SkObject,
} from './skitch';

const bytes = (...values: number[]) => Uint8Array.from(values);
const ascii = (text: string) => Uint8Array.from(text, (letter) => letter.charCodeAt(0));

/** A file with the structure of a PNG; its picture data is not a picture. */
const png = () =>
  writeChunks([
    { type: 'IHDR', data: bytes(0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0) },
    { type: 'IDAT', data: bytes(1, 2, 3, 4, 5) },
    { type: 'IEND', data: bytes() },
  ]);

/** The marks of one of Evernote's own files, with invented text and places. */
const evernote = {
  type: 'Document',
  metadata: { version: '1.1', userAgentHistory: ['Skitch-JS/0.15.760'] },
  frame: { x: 0, y: 0, width: 351, height: 266.613 },
  deviceScale: 1,
  contentScaleFactor: 1,
  coordinateSystem: 1,
  children: [
    {
      type: 'Layer',
      layerId: '__background__',
      children: [
        {
          type: 'Bitmap',
          guid: '1a642354-b7d3-4082-b97b-1cf9fd6f33ee',
          uri: 'skitch+uuid:///1a642354-b7d3-4082-b97b-1cf9fd6f33ee.png',
          frame: { x: 0, y: 0, width: 351, height: 226 },
          contentMode: 0,
        },
      ],
    },
    {
      type: 'Layer',
      layerId: '__annotation__',
      children: [
        {
          type: 'Vector',
          guid: 'd0db5ea5',
          path: 'M 174.354 215.397 C 177.348 193.021 176.675 157.649 174.56 120.5',
          lineWidth: 16,
          strokeColor: { red: 255, green: 0, blue: 0, alpha: 0.4 },
        },
        {
          type: 'Vector',
          guid: '0639444f',
          path: 'M 0 -1.5 L 25.295 -9.937 L 45.17 0 L 25.295 9.937 L 27.102 4.517 Z',
          lineWidth: 2,
          fillColor: { red: 252, green: 12, blue: 89, alpha: 1 },
          extension: {
            type: 'Arrow',
            startPoint: { x: 130.2, y: 234.6 },
            endPoint: { x: 171.8, y: 217 },
            toolArrowSize: 8,
          },
        },
      ],
    },
    {
      type: 'Layer',
      layerId: '__text__',
      children: [
        {
          type: 'Text',
          guid: '271b1049',
          textStyle: 'bubbleText',
          text: 'Out of domain',
          origin: { x: 29.42, y: 223.89 },
          font: { name: 'Helvetica,Arial', size: 24 },
          strokeColor: { red: 255, green: 255, blue: 255, alpha: 1 },
          fillColor: { red: 255, green: 0, blue: 0, alpha: 1 },
          lineWidth: 8,
          alignment: 'left',
          direction: 'leftToRight',
        },
      ],
    },
  ],
};

describe('annotation data inside a picture file', () => {
  it('reads and writes the chunks of a PNG', () => {
    const file = png();
    expect(isPng(file)).toBe(true);
    expect(readChunks(file).map((chunk) => [chunk.type, chunk.data.length])).toEqual([
      ['IHDR', 13],
      ['IDAT', 5],
      ['IEND', 0],
    ]);
    expect(writeChunks(readChunks(file))).toEqual(file);
    // The checksum of an empty IEND chunk is a well-known constant.
    expect([...file.subarray(-4)]).toEqual([0xae, 0x42, 0x60, 0x82]);
    expect(readChunks(ascii('not a picture'))).toEqual([]);
    expect(readAnnotations(file)).toBeNull();
  });

  it('keeps the original and the marks inside the file, before its end', () => {
    const original = bytes(9, 8, 7, 6);
    const file = writeAnnotations(png(), {
      manifest: evernote,
      originals: [{ guid: '1a642354-b7d3-4082-b97b-1cf9fd6f33ee', bytes: original }],
    });
    expect(readChunks(file).map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'skRf', 'skMf', 'IEND']);
    const read = readAnnotations(file);
    expect(read?.manifest).toEqual(evernote);
    expect(read?.originals).toEqual([{ guid: '1a642354-b7d3-4082-b97b-1cf9fd6f33ee', bytes: original }]);
    // Saving again replaces the data; it is not added a second time.
    const again = writeAnnotations(file, {
      manifest: { type: 'Document' },
      originals: read?.originals ?? [],
    });
    expect(readChunks(again).filter((chunk) => chunk.type.startsWith('sk'))).toHaveLength(2);
  });

  it('finds an original by name, and by place when a phone named it otherwise', () => {
    const originals = [
      { guid: 'aaaaaaaa-0000-0000-0000-000000000000', bytes: bytes(1) },
      { guid: 'bbbbbbbb-0000-0000-0000-000000000000', bytes: bytes(2) },
    ];
    expect(originalFor(originals, 'BBBBBBBB-0000-0000-0000-000000000000', 0)).toEqual(bytes(2));
    expect(originalFor(originals, 'unknown', 1)).toEqual(bytes(2));
    expect(originalFor(originals, 'unknown', 5)).toEqual(bytes(1));
    expect(originalFor([], 'unknown', 0)).toBeNull();
  });
});

describe('the annotation document', () => {
  const document = parseDocument(evernote);
  if (!document) throw new Error('the sample document must parse');
  const [highlight, arrow, label] = marksOf(document) as [SkObject, SkObject, SkObject];

  it('gives the original pictures and the marks in drawing order', () => {
    expect(bitmapsOf(document)).toEqual([
      { guid: '1a642354-b7d3-4082-b97b-1cf9fd6f33ee', frame: { x: 0, y: 0, width: 351, height: 226 } },
    ]);
    expect(marksOf(document).map((mark) => mark.type)).toEqual(['Vector', 'Vector', 'Text']);
    expect(parseDocument({ type: 'Document', frame: { width: 0, height: 0 }, children: [] })).toBeNull();
    expect(parseDocument('nonsense')).toBeNull();
  });

  it('finds marks under the pointer: a stroke by its line, an arrow by its ends, text by its area', () => {
    expect(hits(highlight, { x: 176, y: 160 }, 2)).toBe(true);
    expect(hits(highlight, { x: 120, y: 160 }, 2)).toBe(false);
    expect(hits(arrow, { x: 150, y: 226 }, 2)).toBe(true);
    expect(hits(arrow, { x: 150, y: 190 }, 2)).toBe(false);
    expect(hits(label, { x: 60, y: 235 }, 0)).toBe(true);
    expect(hits(label, { x: 60, y: 200 }, 0)).toBe(false);
    expect(markAt(marksOf(document), { x: 60, y: 235 }, 2)).toBe(2);
    expect(markAt(marksOf(document), { x: 5, y: 5 }, 2)).toBe(-1);
  });

  it('moves every kind of mark by changing whatever places it', () => {
    expect(moved(label, 10, -5).origin).toEqual({ x: 39.42, y: 218.89 });
    expect(moved(highlight, 1, 2).path).toBe(
      'M 175.354 217.397 C 178.348 195.021 177.675 159.649 175.56 122.5',
    );
    // An arrow's shape lies at the origin; only its end points move.
    const shifted = moved(arrow, 100, 50);
    expect(shifted.path).toBe(arrow.path);
    expect(shifted.extension).toMatchObject({
      startPoint: { x: 230.2, y: 284.6 },
      endPoint: { x: 271.8, y: 267 },
    });
    // What this module does not understand is carried along untouched.
    expect(shifted.extension).toMatchObject({ type: 'Arrow', toolArrowSize: 8 });
    expect(moved(label, 0, 0)).toMatchObject({
      textStyle: 'bubbleText',
      font: { name: 'Helvetica,Arial', size: 24 },
    });
  });

  it('puts changed marks back into their layers and leaves the rest of the document alone', () => {
    const next = withMarks(document, [withText(label, 'Reworded'), arrow]);
    expect(next.children.map((layer) => [layer.layerId, layer.children.length])).toEqual([
      ['__background__', 1],
      ['__annotation__', 1],
      ['__text__', 1],
    ]);
    expect(textOf(marksOf(next)[1] as SkObject)).toBe('Reworded');
    expect(next.metadata).toEqual(evernote.metadata);
    expect(next.frame).toEqual(evernote.frame);
    expect(marksOf(withMarks(document, []))).toEqual([]);
  });

  it('undoes the escapes some versions of Evernote put on text, and nothing else', () => {
    const text = (value: string) => textOf({ type: 'Text', text: value });
    expect(text('(c%252525E2%25252588%25252598b)(x)')).toBe('(c∘b)(x)');
    expect(text('intersects%25252520at%25252520(0,%252525200)')).toBe('intersects at (0, 0)');
    expect(text('50% of 100%')).toBe('50% of 100%');
    expect(text('%41 and %7E stay')).toBe('%41 and %7E stay');
    expect(text('naïve ∘ plain')).toBe('naïve ∘ plain');
  });
});

describe('marks made here, written the way Evernote writes them', () => {
  const pen = { color: '#e8262d', width: 8 };

  it('writes strokes as paths, a highlighter wide and translucent', () => {
    const points = [
      { x: 10, y: 10 },
      { x: 20.4567, y: 15 },
    ];
    expect(strokeMark(points, pen, false, 'a')).toMatchObject({
      type: 'Vector',
      path: 'M 10 10 L 20.457 15',
      lineWidth: 8,
      strokeColor: { red: 232, green: 38, blue: 45, alpha: 1 },
    });
    expect(strokeMark(points, pen, true, 'b')).toMatchObject({ lineWidth: 16, strokeColor: { alpha: 0.4 } });
    // A tap is a dot, which needs somewhere to go.
    expect(strokeMark([{ x: 5, y: 5 }], pen, false, 'c').path).toBe('M 5 5 L 5.01 5');
  });

  it('writes lines, arrows, rectangles and ellipses with their geometry', () => {
    const from = { x: 100, y: 100 };
    const to = { x: 200, y: 160 };
    expect(shapeMark('line', from, to, pen, 'a')).toMatchObject({
      path: 'M 100 100 L 200 160',
      extension: { type: 'Line', startPoint: from, endPoint: to },
    });
    const arrow = shapeMark('arrow', from, to, pen, 'b');
    expect(arrow.extension).toMatchObject({
      type: 'Arrow',
      startPoint: from,
      endPoint: to,
      toolArrowSize: 8,
    });
    // The same proportions as an arrow Evernote drew at this size and length.
    expect(shapeMark('arrow', { x: 221, y: 296 }, { x: 159, y: 271 }, pen, 'c').path).toBe(
      'M 0 -1.5 L 43.641 -11.605 L 66.851 0 L 43.641 11.605 L 45.751 5.275 Z',
    );
    // That path has its notch on one side only. What is drawn, as Evernote
    // draws it, is the same arrow with the notch on both sides.
    expect(arrowOutline('M 0 -1.5 L 43.641 -11.605 L 66.851 0 L 43.641 11.605 L 45.751 5.275 Z')).toBe(
      'M 0 -1.5 L 45.751 -5.275 L 43.641 -11.605 L 66.851 0 L 43.641 11.605 L 45.751 5.275 L 0 1.5 Z',
    );
    // An arrow whose line does not lie on the axis exactly is mirrored about its own line.
    expect(
      arrowOutline('M 0 -3.012 L 64.188 -20.731 L 102.626 -1.512 L 64.188 17.707 L 67.682 7.224 Z'),
    ).toBe(
      'M 0 -3.012 L 67.682 -10.248 L 64.188 -20.731 L 102.626 -1.512 L 64.188 17.707 L 67.682 7.224 L 0 -0.012 Z',
    );
    // A path of another form is left as it is.
    expect(arrowOutline('M 0 0 C 1 1 2 2 3 3 Z')).toBe('M 0 0 C 1 1 2 2 3 3 Z');
    expect(shapeMark('rectangle', to, from, pen, 'd')).toMatchObject({
      path: 'M 100 100 L 200 100 L 200 160 L 100 160 L 100 100',
      extension: { type: 'Polygon', extension: { type: 'Rectangle' } },
    });
    expect(shapeMark('ellipse', from, to, pen, 'e').extension).toEqual({
      type: 'Ellipse',
      center: { x: 150, y: 130 },
      xradius: 50,
      yradius: 30,
    });
    // Only the commands Evernote's own files use.
    for (const kind of ['rectangle', 'rounded', 'ellipse', 'line', 'arrow'] as const) {
      expect(String(shapeMark(kind, from, to, pen, kind).path)).toMatch(/^[MLCZ0-9 .-]+$/);
    }
  });

  it('writes text with an edge that shows on any picture, and stamps by name', () => {
    expect(textMark('Note', { x: 5, y: 6 }, 24, '#e8262d', 'a')).toMatchObject({
      type: 'Text',
      textStyle: 'bubbleText',
      text: 'Note',
      origin: { x: 5, y: 6 },
      font: { name: 'Helvetica,Arial', size: 24 },
      fillColor: { red: 232, green: 38, blue: 45, alpha: 1 },
      strokeColor: { red: 255, green: 255, blue: 255, alpha: 1 },
      lineWidth: 8,
    });
    expect(textMark('Note', { x: 0, y: 0 }, 24, '#ffffff', 'b').strokeColor).toMatchObject({
      red: 0,
      green: 0,
    });
    expect(stampMark('rejected', { x: 200, y: 100 }, 100, 'c')).toMatchObject({
      type: 'Stamp',
      stampName: 'com.evernote.skitch.rejected',
      frame: { x: 150, y: 50, width: 100, height: 100 },
    });
  });

  it('can find, move, and measure what it wrote', () => {
    const box = shapeMark('rectangle', { x: 100, y: 100 }, { x: 200, y: 160 }, pen, 'a');
    expect(boundsOf(box)).toEqual({ x: 96, y: 96, width: 108, height: 68 });
    expect(hits(box, { x: 150, y: 130 }, 0)).toBe(true);
    expect(boundsOf(moved(box, 10, 10))).toEqual({ x: 106, y: 106, width: 108, height: 68 });
    const stamp = stampMark('approved', { x: 200, y: 100 }, 100, 'b');
    expect(hits(stamp, { x: 205, y: 95 }, 0)).toBe(true);
    expect(hits(stamp, { x: 160, y: 60 }, 0)).toBe(false);
    expect(boundsOf(moved(stamp, -50, 0)).x).toBe(125);
  });

  it('makes a mark that is there as large as the tools now draw', () => {
    const unit = 2;
    const pen = { color: '#e8262d', width: toolSizes(5, unit).pen };
    const larger = toolSizes(9, unit);
    const smaller = toolSizes(2, unit);

    // A line is thicker and runs where it ran.
    const stroke = strokeMark(
      [
        { x: 10, y: 10 },
        { x: 60, y: 40 },
      ],
      pen,
      false,
      'a',
    );
    expect(weightOf(stroke, unit)).toBe(5);
    expect(resized(stroke, larger)).toEqual({ ...stroke, lineWidth: 28.8 });
    expect(weightOf(resized(stroke, larger), unit)).toBe(9);
    // A highlighter stays twice as wide as a pen, and as see-through.
    const marker = strokeMark(
      [
        { x: 10, y: 10 },
        { x: 60, y: 40 },
      ],
      pen,
      true,
      'b',
    );
    expect(weightOf(marker, unit)).toBe(5);
    expect(resized(marker, smaller)).toEqual({ ...marker, lineWidth: 12.8 });
    // A rectangle keeps its corners.
    const box = shapeMark('rectangle', { x: 10, y: 10 }, { x: 110, y: 60 }, pen, 'c');
    expect(resized(box, larger)).toEqual({ ...box, lineWidth: 28.8 });

    // An arrow keeps its ends and gets the head and shaft of a thicker one.
    const arrow = shapeMark('arrow', { x: 20, y: 20 }, { x: 220, y: 120 }, pen, 'd');
    const thick = resized(arrow, larger);
    expect(thick).toEqual({
      ...shapeMark('arrow', { x: 20, y: 20 }, { x: 220, y: 120 }, { ...pen, width: larger.pen }, 'd'),
    });
    expect(thick.path).not.toBe(arrow.path);
    expect(weightOf(thick, unit)).toBe(9);
    expect(boundsOf(thick)).toEqual(boundsOf(arrow));

    // A text's letters are higher from the same corner, and say the same.
    const text = textMark('Here', { x: 30, y: 40 }, toolSizes(5, unit).text, '#e8262d', 'e');
    expect(weightOf(text, unit)).toBe(5);
    const tall = resized(text, larger);
    expect(tall).toEqual({ ...text, font: { name: 'Helvetica,Arial', size: 72 }, lineWidth: 24 });
    expect(boundsOf(tall).height).toBeGreaterThan(boundsOf(text).height);
    expect({ x: boundsOf(tall).x, y: boundsOf(tall).y }).toEqual({ x: 30, y: 40 });

    // A stamp grows about its middle.
    const stamp = stampMark('approved', { x: 100, y: 100 }, toolSizes(5, unit).stamp, 'f');
    expect(weightOf(stamp, unit)).toBe(5);
    const wide = resized(stamp, larger);
    expect(wide.frame).toEqual({ x: -48, y: -48, width: 296, height: 296 });
    expect(weightOf(wide, unit)).toBe(9);

    // A mark from elsewhere, of a size the slider does not have, is read as the nearest it has.
    expect(weightOf({ type: 'Vector', path: 'M 0 0 L 9 9', lineWidth: 400 }, unit)).toBe(10);
    expect(weightOf({ type: 'Text', text: 'x', font: { size: 4 } }, unit)).toBe(1);
  });

  it('gives a mark that is there another colour', () => {
    const pen = { color: '#e8262d', width: 8 };
    const stroke = strokeMark(
      [
        { x: 10, y: 10 },
        { x: 60, y: 40 },
      ],
      pen,
      false,
      'a',
    );
    expect(colorOf(stroke)).toBe('#e8262d');
    expect(recolored(stroke, '#1c7ed6')).toEqual({
      ...stroke,
      strokeColor: { red: 28, green: 126, blue: 214, alpha: 1 },
    });
    // A highlighter stays see-through.
    const marker = strokeMark(
      [
        { x: 10, y: 10 },
        { x: 60, y: 40 },
      ],
      pen,
      true,
      'b',
    );
    expect(recolored(marker, '#1c7ed6').strokeColor).toEqual({ red: 28, green: 126, blue: 214, alpha: 0.4 });
    // An arrow is filled, not outlined.
    const arrow = shapeMark('arrow', { x: 20, y: 20 }, { x: 220, y: 120 }, pen, 'c');
    expect(colorOf(arrow)).toBe('#e8262d');
    const blue = recolored(arrow, '#1c7ed6');
    expect(blue.fillColor).toEqual({ red: 28, green: 126, blue: 214, alpha: 1 });
    expect(blue.strokeColor).toBeUndefined();
    // Light letters get a dark edge, as a text written in that colour has.
    const text = textMark('Here', { x: 30, y: 40 }, 24, '#e8262d', 'd');
    expect(recolored(text, '#ffffff')).toEqual({ ...textMark('Here', { x: 30, y: 40 }, 24, '#ffffff', 'd') });
    // A stamp's colour says what it is.
    const stamp = stampMark('approved', { x: 100, y: 100 }, 100, 'e');
    expect(colorOf(stamp)).toBeNull();
    expect(recolored(stamp, '#1c7ed6')).toBe(stamp);
  });

  it('does not keep a shape with no size or an empty text', () => {
    const at = { x: 10, y: 10 };
    expect(isWorthKeeping(shapeMark('rectangle', at, { x: 11, y: 11 }, pen, 'a'))).toBe(false);
    expect(isWorthKeeping(shapeMark('arrow', at, { x: 11, y: 10 }, pen, 'b'))).toBe(false);
    expect(isWorthKeeping(shapeMark('ellipse', at, { x: 60, y: 40 }, pen, 'c'))).toBe(true);
    expect(isWorthKeeping(textMark('  ', at, 20, '#000000', 'd'))).toBe(false);
    expect(isWorthKeeping(strokeMark([at], pen, false, 'e'))).toBe(true);
  });

  it('starts an empty document for a picture without marks', () => {
    const document = newDocument(1400, 700, 'abc');
    expect(parseDocument(JSON.parse(JSON.stringify(document)))).not.toBeNull();
    expect(bitmapsOf(document)).toEqual([{ guid: 'abc', frame: { x: 0, y: 0, width: 1400, height: 700 } }]);
    expect(marksOf(document)).toEqual([]);
    // Tools draw larger on a large picture, as they do in Evernote.
    expect(toolScale(document.frame)).toBe(2);
    expect(toolScale({ x: 0, y: 0, width: 300, height: 200 })).toBe(1);
  });
});
