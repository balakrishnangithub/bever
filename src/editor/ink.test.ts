import { describe, expect, it } from 'vitest';

import {
  colorHex,
  colorNumber,
  ellipseStroke,
  freeStroke,
  pressureSpread,
  hitsStroke,
  inkBounds,
  lineStroke,
  movedStroke,
  newInk,
  parseInk,
  penSizeOf,
  pictureFrame,
  recoloredStroke,
  rectangleStroke,
  resizedStroke,
  scaledStroke,
  serializeInk,
  snapToShape,
  STROKE,
  strokeInBox,
  type Sample,
} from './ink';
import { hasInk, readChunks, readInk, writeChunks, writeInk } from './pngChunks';

// A sketch the way Evernote writes one: a pen stroke, a snapped line with
// its outline, and a highlighter stroke, with an attribute of a later
// version on the last.
const SKETCH =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>' +
  '<ink xmlns="http://www.w3.org/2003/InkML" xmlns:enink="http://www.evernote.com/2013/InkNote">' +
  '<context enink:name="1ff6f6a3-3e3d-4514-b7ce-f9c6902a3bc0" enink:version="3" enink:sizeWidth="74200" ' +
  'enink:sizeHeight="80500" enink:backColor="#ffffff" enink:pattern="3" enink:savePattern="false" ' +
  'enink:blankdate="1648396100860"><inkSource xml:id="Evernote-Neutron"><traceFormat>' +
  '<channel name="X" type="decimal"/><channel name="Y" type="decimal"/><channel name="W" type="decimal"/>' +
  '</traceFormat><activeArea width="742.0" height="805.0"/></inkSource></context><traceGroup>' +
  '<trace enink:strokeType="0" enink:color="-16777216" enink:fixWidth="1.5" enink:cmdsPattern="1358954497">' +
  '1000 2000 150 1100 2000 150 1200 2050 180 1300 2100 180 1400 2100 200 1500 2100 200</trace>' +
  '<trace enink:strokeType="5" enink:color="-1423805" enink:fixWidth="1.7" ' +
  'enink:shapePoints="AADIQgAAyEIAAEhDAADIQg==&#10;" enink:cmdsPattern="-1593835520">10000 10000 172 20000 10000 172</trace>' +
  '<trace enink:strokeType="11" enink:color="-335018" enink:fixWidth="24.4" enink:later="kept" ' +
  'enink:cmdsPattern="-1593835520">3000 4000 2439 5000 4000 2439</trace>' +
  '</traceGroup></ink>';

const png = () =>
  writeChunks([
    { type: 'IHDR', data: new Uint8Array(13) },
    { type: 'IDAT', data: Uint8Array.of(1, 2, 3) },
    { type: 'IEND', data: new Uint8Array(0) },
  ]);

const samples = (points: [number, number][]): Sample[] =>
  points.map(([x, y], index) => ({ x, y, time: index * 16, pressure: null }));

describe('reading a sketch', () => {
  it('reads the paper and every stroke', () => {
    const sketch = parseInk(SKETCH);
    expect(sketch).toMatchObject({
      name: '1ff6f6a3-3e3d-4514-b7ce-f9c6902a3bc0',
      width: 742,
      height: 805,
      background: '#ffffff',
      pattern: 3,
      savePattern: false,
    });
    expect(sketch?.strokes.map((stroke) => stroke.type)).toEqual([
      STROKE.pen,
      STROKE.line,
      STROKE.highlighter,
    ]);
    const [pen, line, highlighter] = sketch?.strokes ?? [];
    // Hundredths of a pixel in the file, pixels here.
    expect(pen?.points.slice(0, 6)).toEqual([10, 20, 1.5, 11, 20, 1.5]);
    expect(colorHex(pen?.color ?? 0)).toBe('#000000');
    expect(colorHex(line?.color ?? 0)).toBe('#ea4643');
    expect(line?.shape).toEqual([100, 100, 200, 100]);
    expect(highlighter?.size).toBe(24.4);
    expect(highlighter?.extra).toEqual([['enink:later', 'kept']]);
  });

  it('writes an unchanged sketch back exactly as it was', () => {
    const sketch = parseInk(SKETCH);
    expect(sketch && serializeInk(sketch)).toBe(SKETCH);
  });

  it('reads a sketch without strokes, and one without the newer attributes', () => {
    const empty = parseInk(SKETCH.replace(/<traceGroup>.*<\/traceGroup>/, '<traceGroup/>'));
    expect(empty?.strokes).toEqual([]);
    const old = parseInk(
      SKETCH.replace(/ enink:backColor="[^"]*" enink:pattern="3" enink:savePattern="false"/, ''),
    );
    expect(old).toMatchObject({ background: '#ffffff', pattern: 0, savePattern: false });
    expect(old && serializeInk(old)).not.toContain('enink:pattern');
  });

  it('refuses what is not a sketch', () => {
    expect(parseInk('<ink></ink>')).toBeNull();
    expect(parseInk('not xml')).toBeNull();
  });

  it('keeps a trace it cannot read, without drawing it', () => {
    const odd = SKETCH.replace('3000 4000 2439 5000 4000 2439', '3000 4000');
    const sketch = parseInk(odd);
    expect(sketch?.strokes[2]?.points).toEqual([]);
    expect(sketch && serializeInk(sketch)).toBe(odd);
  });
});

describe('writing a sketch', () => {
  it('rewrites only what was changed', () => {
    const sketch = parseInk(SKETCH);
    if (!sketch) throw new Error('not read');
    const [pen, line, highlighter] = sketch.strokes;
    if (!pen || !line || !highlighter) throw new Error('strokes missing');
    const written = serializeInk({
      ...sketch,
      width: 300,
      height: 120.5,
      background: '#333333',
      pattern: 2,
      savePattern: true,
      strokes: [pen, movedStroke(line, 10, -5), highlighter],
    });
    expect(written).toContain('enink:sizeWidth="30000" enink:sizeHeight="12050"');
    expect(written).toContain('enink:backColor="#333333" enink:pattern="2" enink:savePattern="true"');
    expect(written).toContain('<activeArea width="300.0" height="120.5"/>');
    // The pen stroke and the highlighter are the bytes that were read.
    expect(written).toContain(pen.source);
    expect(written).toContain(highlighter.source);
    const again = parseInk(written);
    expect(again?.strokes[1]).toMatchObject({
      type: STROKE.line,
      points: [110, 95, 1.72, 210, 95, 1.72],
      shape: [110, 95, 210, 95],
      commands: 0xa1000000,
    });
    expect(written).toContain('enink:cmdsPattern="-1593835520">11000 9500 172 21000 9500 172</trace>');
  });

  it('writes a moved stroke with the attributes it does not know', () => {
    const sketch = parseInk(SKETCH);
    const highlighter = sketch?.strokes[2];
    if (!sketch || !highlighter) throw new Error('not read');
    const written = serializeInk({ ...sketch, strokes: [movedStroke(highlighter, 1, 1)] });
    expect(written).toContain(
      '<trace enink:strokeType="11" enink:color="-335018" enink:fixWidth="24.4" enink:later="kept" ' +
        'enink:cmdsPattern="-1593835520">3100 4100 2439 5100 4100 2439</trace>',
    );
  });

  it('starts a new sketch that reads as one', () => {
    const sketch = newInk('a-new-sketch', 1700000000000);
    const stroke = freeStroke(
      samples([
        [0, 0],
        [40, 0],
      ]),
      { color: '#328ff6', size: 1.5 },
      false,
    );
    const read = parseInk(serializeInk({ ...sketch, width: 50, height: 12, strokes: [stroke] }));
    expect(read).toMatchObject({ name: 'a-new-sketch', width: 50, height: 12, pattern: 1 });
    expect(read?.strokes).toHaveLength(1);
    expect(colorHex(read?.strokes[0]?.color ?? 0)).toBe('#328ff6');
  });
});

describe('new strokes', () => {
  it('has two, three, or at least six points, as Evernote’s free strokes do', () => {
    const pen = { color: '#000000', size: 1.5 };
    const count = (points: [number, number][]) => freeStroke(samples(points), pen, false).points.length / 3;
    expect(count([[5, 5]])).toBe(2);
    expect(
      count([
        [0, 0],
        [10, 0],
      ]),
    ).toBe(2);
    expect(
      count([
        [0, 0],
        [10, 0],
        [20, 0],
        [30, 0],
      ]),
    ).toBe(7);
    const long = freeStroke(
      samples(Array.from({ length: 20 }, (_, index) => [index * 5, index * 2])),
      pen,
      false,
    );
    expect(long.points.length / 3).toBe(20);
    expect(long.commands).toBe(0x51000000 + 15);
    expect(long.type).toBe(STROKE.pen);
  });

  it('draws a pen line thicker where it is slow, and a highlighter evenly', () => {
    const path: Sample[] = Array.from({ length: 12 }, (_, index) => ({
      // Slow at first, fast afterwards.
      x: index < 6 ? index * 2 : 10 + (index - 5) * 40,
      y: 0,
      time: index * 16,
      pressure: null,
    }));
    const widths = (highlighter: boolean) =>
      freeStroke(path, { color: '#000000', size: 2 }, highlighter).points.filter(
        (_, index) => index % 3 === 2,
      );
    const pen = widths(false);
    expect(pen[2]).toBeGreaterThan(pen[10] ?? 0);
    expect(Math.min(...pen)).toBeGreaterThanOrEqual(1.8);
    expect(Math.max(...pen)).toBeLessThanOrEqual(3.2);
    expect(new Set(widths(true))).toEqual(new Set([2]));
  });

  it('follows a pen that reports its pressure', () => {
    const path: Sample[] = Array.from({ length: 10 }, (_, index) => ({
      x: index * 10,
      y: 0,
      time: index * 16,
      pressure: index < 5 ? 0.2 : 0.9,
    }));
    const widths = freeStroke(path, { color: '#000000', size: 2 }, false).points.filter(
      (_, index) => index % 3 === 2,
    );
    // A light touch draws a thin line and a firm one a thick line, as far
    // apart as they are in Evernote's own sketches.
    expect(widths[2]).toBeLessThan(2 * 1.2);
    expect(widths[8]).toBeGreaterThan(2 * 2.2);
    expect(widths[8]).toBeGreaterThan((widths[2] ?? 0) * 2);
  });

  it('gives a pen the widths Evernote gives one', () => {
    expect(pressureSpread(0)).toBeCloseTo(0.31, 2);
    expect(pressureSpread(0.45)).toBeCloseTo(1.63, 1);
    expect(pressureSpread(1)).toBeCloseTo(2.61, 2);
    // Readings outside what a pen can report do not leave the range.
    expect(pressureSpread(-1)).toBe(pressureSpread(0));
    expect(pressureSpread(3)).toBe(pressureSpread(1));
  });

  it('makes an ellipse of eight curves, as Evernote does', () => {
    const ellipse = ellipseStroke({ left: 0, top: 0, right: 200, bottom: 100 }, colorNumber('#ea4643'), 1.3);
    expect(ellipse.points.length / 3).toBe(17);
    expect(ellipse.shape).toHaveLength(32);
    expect(ellipse.commands).toBe(0x6e000005);
    // It begins and ends at the right, and goes down first.
    expect(ellipse.points.slice(0, 3)).toEqual([200, 50, 1.3]);
    expect(ellipse.points.slice(-3)).toEqual([200, 50, 1.3]);
    expect(ellipse.points[4]).toBeGreaterThan(50);
    // The second point is the middle of the first curve, a hair outside the ellipse.
    const [x = 0, y = 0] = ellipse.points.slice(3, 5);
    expect(Math.hypot((x - 100) / 100, (y - 50) / 50)).toBeCloseTo(1.0031, 3);
    // The first control point is straight below the start.
    expect(ellipse.shape?.slice(0, 4).map((value) => Math.round(value * 100) / 100)).toEqual([
      200, 50, 200, 70.71,
    ]);
  });

  it('writes a rectangle the way Evernote orders it', () => {
    const rectangle = rectangleStroke({ left: 10, top: 20, right: 110, bottom: 70 }, 0xff000000, 2);
    expect(rectangle.points).toEqual([110, 70, 2, 10, 70, 2, 10, 20, 2, 110, 20, 2, 110, 70, 2]);
    expect(rectangle.shape).toEqual([110, 70, 10, 70, 10, 20, 110, 20]);
    expect(rectangle.commands).toBe(0xa9000002);
  });
});

describe('snapping to a shape', () => {
  const pen = { color: '#000000', size: 1.5 };
  const drawn = (points: [number, number][]) => snapToShape(freeStroke(samples(points), pen, false));
  const around = (corners: [number, number][], steps = 12): [number, number][] => {
    const path: [number, number][] = [];
    corners.forEach(([x, y], index) => {
      const [nx, ny] = corners[(index + 1) % corners.length] ?? [x, y];
      for (let step = 0; step < steps; step += 1) {
        // A hand is never exact.
        const wobble = Math.sin(step * 1.7 + index) * 1.5;
        path.push([x + ((nx - x) * step) / steps + wobble, y + ((ny - y) * step) / steps - wobble]);
      }
    });
    path.push(corners[0] ?? [0, 0]);
    return path;
  };

  it('straightens a nearly straight stroke', () => {
    const line = drawn(Array.from({ length: 30 }, (_, index) => [index * 6, 100 + Math.sin(index) * 1.5]));
    expect(line.type).toBe(STROKE.line);
    expect(line.points.length / 3).toBe(2);
    expect(line.shape).toHaveLength(4);
  });

  it('turns a closed stroke into the shape it fills', () => {
    const rectangle = drawn(
      around([
        [20, 20],
        [220, 20],
        [220, 120],
        [20, 120],
      ]),
    );
    expect(rectangle.type).toBe(STROKE.rectangle);
    const circle = drawn(
      Array.from({ length: 49 }, (_, index) => [
        100 + 80 * Math.cos((index / 48) * Math.PI * 2),
        100 + 60 * Math.sin((index / 48) * Math.PI * 2),
      ]),
    );
    expect(circle.type).toBe(STROKE.ellipse);
    expect(inkBounds([circle])?.right).toBeCloseTo(180, -1);
    const triangle = drawn(
      around([
        [100, 20],
        [200, 180],
        [0, 180],
      ]),
    );
    expect(triangle.type).toBe(STROKE.triangle);
    expect(triangle.points.length / 3).toBe(4);
    expect(triangle.points.slice(0, 2)).toEqual(triangle.points.slice(9, 11));
  });

  it('leaves handwriting alone', () => {
    // An "S": neither straight nor closed.
    const letter = drawn(
      Array.from({ length: 40 }, (_, index) => [50 + 30 * Math.sin(index / 6), index * 4]),
    );
    expect(letter.type).toBe(STROKE.pen);
    // A dot.
    expect(drawn([[5, 5]]).type).toBe(STROKE.pen);
    // A highlighter stroke is never a shape.
    const marker = freeStroke(
      samples([
        [0, 0],
        [200, 0],
      ]),
      { color: '#fae356', size: 24.4 },
      true,
    );
    expect(snapToShape(marker).type).toBe(STROKE.highlighter);
  });
});

describe('finding and moving strokes', () => {
  const line = lineStroke(0, 0, 100, 0, 0xff000000, 4);

  it('takes a stroke by its line, with its width', () => {
    expect(hitsStroke(line, 50, 1.5, 0)).toBe(true);
    expect(hitsStroke(line, 50, 6, 0)).toBe(false);
    expect(hitsStroke(line, 50, 6, 5)).toBe(true);
    expect(hitsStroke(line, 130, 0, 5)).toBe(false);
  });

  it('measures what a saved picture has to show', () => {
    expect(inkBounds([line])).toEqual({ left: -2, top: -2, right: 102, bottom: 2 });
    expect(pictureFrame([line])).toEqual({ left: -7, top: -7, right: 107, bottom: 7 });
    expect(pictureFrame([])).toBeNull();
  });

  it('selects by a box and moves', () => {
    expect(strokeInBox(line, { left: 90, top: -5, right: 120, bottom: 5 })).toBe(true);
    expect(strokeInBox(line, { left: 101, top: -5, right: 120, bottom: 5 })).toBe(false);
    const moved = movedStroke(line, 5, 7);
    expect(moved.points).toEqual([5, 7, 4, 105, 7, 4]);
    expect(moved.shape).toEqual([5, 7, 105, 7]);
    expect(movedStroke(line, 0, 0)).toBe(line);
  });

  it('makes a stroke larger about a point that stays, line and all', () => {
    const doubled = scaledStroke(line, 100, 0, 2);
    expect(doubled.points).toEqual([-100, 0, 8, 100, 0, 8]);
    expect(doubled.shape).toEqual([-100, 0, 100, 0]);
    expect(doubled.size).toBe(8);
    expect(doubled.source).toBeNull();
    // What the selection's outline shows is what the strokes become.
    expect(inkBounds([doubled])).toEqual({ left: -104, top: -4, right: 104, bottom: 4 });
    expect(scaledStroke(line, 0, 0, 1)).toBe(line);
    expect(scaledStroke(line, 0, 0, 0)).toBe(line);
  });

  it('gives a stroke another colour and keeps how opaque it is', () => {
    const marker = { ...line, color: 0x3bffe066 };
    expect(colorHex(recoloredStroke(marker, '#2f9e44').color)).toBe('#2f9e44');
    expect(recoloredStroke(marker, '#2f9e44').color >>> 24).toBe(0x3b);
    expect(recoloredStroke(line, '#000000')).toBe(line);
  });

  it('gives a stroke another pen size and keeps the swell of its line', () => {
    expect(penSizeOf(line)).toBe(4);
    const thick = resizedStroke(line, 8);
    expect(thick.points).toEqual([0, 0, 8, 100, 0, 8]);
    expect(thick.size).toBe(8);
    expect(resizedStroke(line, 4)).toBe(line);

    const drawn = freeStroke(
      [0, 10, 20, 30, 40].map((x) => ({ x, y: 0, pressure: 0.5, time: x })),
      { color: '#000000', size: 2 },
      false,
    );
    const widths = (stroke: typeof drawn) => stroke.points.filter((_, index) => index % 3 === 2);
    const bolder = resizedStroke(drawn, 4);
    expect(penSizeOf(bolder)).toBeCloseTo(4, 1);
    widths(bolder).forEach((width, index) => {
      expect(width / (widths(drawn)[index] ?? 1)).toBeCloseTo(4 / penSizeOf(drawn), 1);
    });
  });
});

describe('a sketch inside a picture', () => {
  it('is added after the picture’s data and read back', async () => {
    const file = await writeInk(png(), { name: 'sketch-1', inkml: SKETCH, width: 742, height: 805 });
    expect(readChunks(file).map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'enIs', 'enIz', 'IEND']);
    expect(hasInk(file)).toBe(true);
    expect(hasInk(png())).toBe(false);
    const header = readChunks(file).find((chunk) => chunk.type === 'enIs');
    expect(JSON.parse(new TextDecoder().decode(header?.data))).toEqual({
      name: 'sketch-1',
      width: 742,
      height: 805,
    });
    expect(await readInk(file)).toEqual({ name: 'sketch-1', inkml: SKETCH });
  });

  it('replaces ink that is already there', async () => {
    const first = await writeInk(png(), { name: 'a', inkml: SKETCH, width: 1, height: 1 });
    const second = await writeInk(first, { name: 'b', inkml: '<ink/>', width: 2, height: 2 });
    expect(readChunks(second).filter((chunk) => chunk.type.startsWith('enI'))).toHaveLength(2);
    expect(await readInk(second)).toEqual({ name: 'b', inkml: '<ink/>' });
  });

  it('reads nothing from a picture without ink, or with ink that is damaged', async () => {
    expect(await readInk(png())).toBeNull();
    const damaged = writeChunks([
      { type: 'IHDR', data: new Uint8Array(13) },
      { type: 'enIz', data: Uint8Array.of(1, 2, 3, 4) },
      { type: 'IEND', data: new Uint8Array(0) },
    ]);
    expect(await readInk(damaged)).toBeNull();
  });
});
