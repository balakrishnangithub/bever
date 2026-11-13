/**
 * The strokes of a sketch drawn in Evernote.
 *
 * Evernote stores a sketch as InkML with attributes of its own (`enink:`).
 * A sketch has no page: its strokes lie on an unbounded canvas, and the
 * picture that is saved shows the part of it that the strokes cover.
 *
 * ```xml
 * <ink xmlns="http://www.w3.org/2003/InkML" xmlns:enink="…">
 *   <context enink:name="…" enink:version="3"
 *            enink:sizeWidth="74200" enink:sizeHeight="80500"
 *            enink:backColor="#ffffff" enink:pattern="3" enink:savePattern="false" …>
 *     <inkSource …><traceFormat>X, Y, W</traceFormat><activeArea width="742.0" height="805.0"/></inkSource>
 *   </context>
 *   <traceGroup>
 *     <trace enink:strokeType="0" enink:color="-16777216" enink:fixWidth="1.5"
 *            enink:cmdsPattern="1358954501">8640 14340 224 8653 14433 224 …</trace>
 *   </traceGroup>
 * </ink>
 * ```
 *
 * Each point of a trace is three whole numbers: x, y, and the width of the
 * stroke there, in hundredths of a pixel. A colour is alpha, red, green,
 * and blue in one signed number. A stroke that was snapped to a shape also
 * carries the shape's outline (`enink:shapePoints`, 32-bit floats in pixels,
 * base64).
 *
 * This module reads that into strokes, draws them, makes new ones, and
 * writes the InkML again. A stroke that was not changed is written exactly
 * as it was read; so is everything around the strokes.
 */

/** What drew a stroke, as Evernote numbers it. */
export const STROKE = {
  pen: 0,
  triangle: 2,
  rectangle: 3,
  line: 5,
  ellipse: 7,
  highlighter: 11,
} as const;

export interface InkStroke {
  /** One of {@link STROKE}; other numbers are kept and drawn as a pen's. */
  type: number;
  /** Alpha, red, green, blue: 0xAARRGGBB. */
  color: number;
  /** The size of the pen that drew it, in pixels. */
  size: number;
  /** x, y, and width for each point, in pixels. */
  points: number[];
  /** The outline of a snapped shape, x and y in pixels; null for a free stroke. */
  shape: number[] | null;
  /** How the points form a path, as Evernote notes it. */
  commands: number;
  /** Attributes this module does not know, written back with the stroke. */
  extra: [string, string][];
  /** The trace as it was read; null once the stroke is new or was changed. */
  source: string | null;
}

export interface InkDocument {
  /** The sketch's own identifier. */
  name: string;
  /** The saved picture's size, in pixels. */
  width: number;
  height: number;
  /** The paper's colour, `#rrggbb`. */
  background: string;
  /** The paper's pattern; see {@link PATTERNS}. */
  pattern: number;
  /** Whether the pattern is part of the saved picture. */
  savePattern: boolean;
  strokes: InkStroke[];
  /** Everything before the first stroke and after the last, as read. */
  head: string;
  tail: string;
}

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Pen {
  /** `#rrggbb`. */
  color: string;
  /** In pixels. */
  size: number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** A place the pointer was, in the sketch's pixels. */
export interface Sample {
  x: number;
  y: number;
  /** Milliseconds; only differences matter. */
  time: number;
  /** 0 to 1 from a pen that reports it, otherwise null. */
  pressure: number | null;
}

// The pens Evernote offers, read from sketches it saved.
export const PEN_COLORS = [
  '#000000',
  '#b7b7ba',
  '#e5e5e5',
  '#5b1a7b',
  '#328ff6',
  '#74ddfb',
  '#7ae571',
  '#fae356',
  '#f5b041',
  '#ea4643',
];
export const PEN_SIZES = [1, 1.5, 2.4, 3.9, 5.4, 6.3, 8.96];
export const HIGHLIGHTER_SIZES = [7.3, 14.6, 24.4, 34.1, 43.9];
/** How strongly a highlighter covers what is under it. */
export const HIGHLIGHTER_ALPHA = 59 / 255;

/** The papers Evernote offers: white, dark, and six tints. */
export const BACKGROUNDS = [
  '#ffffff',
  '#333333',
  '#ffef9e',
  '#b7f7d1',
  '#adebf4',
  '#cbc9ff',
  '#fec1cf',
  '#ffd1b0',
];

export type PatternKind = 'none' | 'dots' | 'lines' | 'grid';

/**
 * The paper's patterns by the number Evernote stores. 0 to 3 are read from
 * pictures saved with their pattern; the wide ones are taken to follow in
 * the same order, which no saved picture confirms.
 */
export const PATTERNS: Record<number, { kind: PatternKind; spacing: number; label: string }> = {
  0: { kind: 'none', spacing: 0, label: 'None' },
  1: { kind: 'dots', spacing: 32, label: 'Dots' },
  2: { kind: 'grid', spacing: 32, label: 'Grid' },
  3: { kind: 'lines', spacing: 32, label: 'Lines' },
  4: { kind: 'dots', spacing: 64, label: 'Wide dots' },
  5: { kind: 'grid', spacing: 64, label: 'Wide grid' },
  6: { kind: 'lines', spacing: 64, label: 'Wide lines' },
};

// --- Reading --------------------------------------------------------------

const ATTRIBUTE = /([\w:.-]+)="([^"]*)"/g;

function attributesOf(tag: string): [string, string][] {
  return [...tag.matchAll(ATTRIBUTE)].map((match) => [match[1] ?? '', match[2] ?? '']);
}

const KNOWN = ['enink:strokeType', 'enink:color', 'enink:fixWidth', 'enink:shapePoints', 'enink:cmdsPattern'];

function floatsFrom(base64: string): number[] | null {
  try {
    const binary = atob(base64.replace(/&#(?:10|13|xA|xD);|\s/gi, ''));
    if (binary.length % 8 !== 0) return null;
    const view = new DataView(Uint8Array.from(binary, (letter) => letter.charCodeAt(0)).buffer);
    return Array.from({ length: binary.length / 4 }, (_, index) => view.getFloat32(index * 4, true));
  } catch {
    return null;
  }
}

function floatsTo(values: number[]): string {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  let binary = '';
  for (let index = 0; index < view.byteLength; index += 1)
    binary += String.fromCharCode(view.getUint8(index));
  return btoa(binary);
}

function strokeFrom(source: string, tag: string, body: string): InkStroke {
  const attributes = attributesOf(tag);
  const value = (name: string) => attributes.find(([key]) => key === name)?.[1];
  const numbers = body.trim()
    ? body
        .trim()
        .split(/[\s,]+/)
        .map(Number)
    : [];
  const readable = numbers.length % 3 === 0 && numbers.every(Number.isFinite);
  const shape = value('enink:shapePoints');
  return {
    type: Number(value('enink:strokeType') ?? 0) || 0,
    color: (Number(value('enink:color') ?? -16777216) || 0) >>> 0,
    size: Number(value('enink:fixWidth') ?? 1) || 1,
    // A trace that cannot be read is kept as it is, and not drawn.
    points: readable ? numbers.map((number) => number / 100) : [],
    shape: shape ? floatsFrom(shape) : null,
    commands: (Number(value('enink:cmdsPattern') ?? 0) || 0) >>> 0,
    extra: attributes.filter(([key]) => !KNOWN.includes(key)),
    source,
  };
}

/** The sketch in `xml`, or null when it is not InkML as Evernote writes it. */
export function parseInk(xml: string): InkDocument | null {
  const open = xml.indexOf('<traceGroup');
  const openEnd = open < 0 ? -1 : xml.indexOf('>', open);
  if (openEnd < 0) return null;
  let head: string;
  let tail: string;
  let body: string;
  if (xml[openEnd - 1] === '/') {
    // A sketch with no strokes at all.
    head = `${xml.slice(0, openEnd - 1).trimEnd()}>`;
    body = '';
    tail = `</traceGroup>${xml.slice(openEnd + 1)}`;
  } else {
    const close = xml.lastIndexOf('</traceGroup>');
    if (close < openEnd) return null;
    head = xml.slice(0, openEnd + 1);
    body = xml.slice(openEnd + 1, close);
    tail = xml.slice(close);
  }
  const context = /<context\b[^>]*>/.exec(head)?.[0];
  if (!context) return null;
  const attributes = attributesOf(context);
  const value = (name: string) => attributes.find(([key]) => key === name)?.[1];
  const strokes: InkStroke[] = [];
  for (const match of body.matchAll(/<trace\b([^>]*)>([^<]*)<\/trace>/g)) {
    strokes.push(strokeFrom(match[0], match[1] ?? '', match[2] ?? ''));
  }
  const background = value('enink:backColor') ?? '';
  return {
    name: value('enink:name') ?? '',
    width: (Number(value('enink:sizeWidth')) || 0) / 100,
    height: (Number(value('enink:sizeHeight')) || 0) / 100,
    background: /^#[0-9a-f]{6}$/i.test(background) ? background.toLowerCase() : '#ffffff',
    pattern: Number(value('enink:pattern') ?? 0) || 0,
    savePattern: value('enink:savePattern') === 'true',
    strokes,
    head,
    tail,
  };
}

// --- Writing --------------------------------------------------------------

/** A number the way Evernote writes a size: always with a decimal point. */
const decimal = (value: number) => (Number.isInteger(value) ? value.toFixed(1) : String(value));

function traceOf(stroke: InkStroke): string {
  if (stroke.source !== null) return stroke.source;
  const attributes: [string, string][] = [
    ['enink:strokeType', String(stroke.type)],
    ['enink:color', String(stroke.color | 0)],
    ['enink:fixWidth', decimal(stroke.size)],
    ...(stroke.shape
      ? ([['enink:shapePoints', `${floatsTo(stroke.shape)}&#10;`]] as [string, string][])
      : []),
    ...stroke.extra,
    ['enink:cmdsPattern', String(stroke.commands | 0)],
  ];
  const tag = attributes.map(([name, value]) => `${name}="${value}"`).join(' ');
  return `<trace ${tag}>${stroke.points.map((value) => Math.round(value * 100)).join(' ')}</trace>`;
}

/** `tag` with `name` set to `value`: changed where it is, or added at the end. */
function withAttribute(tag: string, name: string, value: string): string {
  const pattern = new RegExp(`(\\s${name.replace(/[.:]/g, '\\$&')}=")[^"]*(")`);
  if (pattern.test(tag)) return tag.replace(pattern, `$1${value}$2`);
  return tag.replace(/\s*(\/?)>$/, ` ${name}="${value}"$1>`);
}

/** The sketch as InkML. Only what differs from what was read is rewritten. */
export function serializeInk(document: InkDocument): string {
  const before = parseInk(`${document.head}${document.tail}`);
  let head = document.head;
  const context = /<context\b[^>]*>/.exec(head)?.[0];
  if (context && before) {
    let tag = context;
    if (before.width !== document.width || before.height !== document.height) {
      tag = withAttribute(tag, 'enink:sizeWidth', String(Math.round(document.width * 100)));
      tag = withAttribute(tag, 'enink:sizeHeight', String(Math.round(document.height * 100)));
      head = head.replace(/<activeArea\b[^>]*>/, (area) =>
        withAttribute(
          withAttribute(area, 'width', decimal(document.width)),
          'height',
          decimal(document.height),
        ),
      );
    }
    if (before.background !== document.background) {
      tag = withAttribute(tag, 'enink:backColor', document.background);
    }
    if (before.pattern !== document.pattern) {
      tag = withAttribute(tag, 'enink:pattern', String(document.pattern));
    }
    if (before.savePattern !== document.savePattern) {
      tag = withAttribute(tag, 'enink:savePattern', String(document.savePattern));
    }
    head = head.replace(context, tag);
  }
  return `${head}${document.strokes.map(traceOf).join('')}${document.tail}`;
}

/** An empty sketch, as Evernote writes one. */
export function newInk(name: string, now: number): InkDocument {
  const head =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>' +
    '<ink xmlns="http://www.w3.org/2003/InkML" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xsi:schemaLocation="http://www.w3.org/TR/2011/REC-InkML-20110920/inkml.xsd" ' +
    'xmlns:enink="http://www.evernote.com/2013/InkNote">' +
    `<context enink:name="${name}" enink:version="3" enink:sizeWidth="0" enink:sizeHeight="0" ` +
    `enink:backColor="#ffffff" enink:pattern="1" enink:savePattern="false" enink:blankdate="${now}">` +
    '<inkSource xml:id="Evernote-Neutron"><traceFormat><channel name="X" type="decimal"/>' +
    '<channel name="Y" type="decimal"/><channel name="W" type="decimal"/></traceFormat>' +
    '<activeArea width="0.0" height="0.0"/></inkSource></context><traceGroup>';
  return {
    name,
    width: 0,
    height: 0,
    background: '#ffffff',
    pattern: 1,
    savePattern: false,
    strokes: [],
    head,
    tail: '</traceGroup></ink>',
  };
}

// --- Measuring ------------------------------------------------------------

/** The part of the canvas `stroke` covers, with its width. */
export function strokeBounds(stroke: InkStroke): Bounds | null {
  const { points } = stroke;
  if (!points.length) return null;
  const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (let index = 0; index + 2 < points.length; index += 3) {
    const half = (points[index + 2] ?? 0) / 2;
    bounds.left = Math.min(bounds.left, (points[index] ?? 0) - half);
    bounds.right = Math.max(bounds.right, (points[index] ?? 0) + half);
    bounds.top = Math.min(bounds.top, (points[index + 1] ?? 0) - half);
    bounds.bottom = Math.max(bounds.bottom, (points[index + 1] ?? 0) + half);
  }
  return bounds;
}

/** The part of the canvas all of `strokes` cover, or null when there are none. */
export function inkBounds(strokes: InkStroke[]): Bounds | null {
  let all: Bounds | null = null;
  for (const stroke of strokes) {
    const bounds = strokeBounds(stroke);
    if (!bounds) continue;
    all = all
      ? {
          left: Math.min(all.left, bounds.left),
          top: Math.min(all.top, bounds.top),
          right: Math.max(all.right, bounds.right),
          bottom: Math.max(all.bottom, bounds.bottom),
        }
      : bounds;
  }
  return all;
}

/** Room left around the strokes in a saved picture, in pixels. */
export const PICTURE_MARGIN = 5;

/** The part of the canvas a saved picture of `strokes` shows, in whole pixels. */
export function pictureFrame(strokes: InkStroke[]): Bounds | null {
  const bounds = inkBounds(strokes);
  if (!bounds) return null;
  return {
    left: Math.floor(bounds.left - PICTURE_MARGIN),
    top: Math.floor(bounds.top - PICTURE_MARGIN),
    right: Math.ceil(bounds.right + PICTURE_MARGIN),
    bottom: Math.ceil(bounds.bottom + PICTURE_MARGIN),
  };
}

function distanceToSegment(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const along = length ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
  return Math.hypot(x - ax - dx * along, y - ay - dy * along);
}

/** Whether (`x`, `y`) is on `stroke`, give or take `reach` pixels. */
export function hitsStroke(stroke: InkStroke, x: number, y: number, reach: number): boolean {
  const { points } = stroke;
  const bounds = strokeBounds(stroke);
  if (
    !bounds ||
    x < bounds.left - reach ||
    x > bounds.right + reach ||
    y < bounds.top - reach ||
    y > bounds.bottom + reach
  ) {
    return false;
  }
  if (points.length === 3) {
    return Math.hypot(x - (points[0] ?? 0), y - (points[1] ?? 0)) <= (points[2] ?? 0) / 2 + reach;
  }
  for (let index = 0; index + 5 < points.length; index += 3) {
    const half = Math.max(points[index + 2] ?? 0, points[index + 5] ?? 0) / 2;
    const distance = distanceToSegment(
      x,
      y,
      points[index] ?? 0,
      points[index + 1] ?? 0,
      points[index + 3] ?? 0,
      points[index + 4] ?? 0,
    );
    if (distance <= half + reach) return true;
  }
  return false;
}

/** Whether any part of `stroke` lies inside `box`. */
export function strokeInBox(stroke: InkStroke, box: Bounds): boolean {
  const { points } = stroke;
  for (let index = 0; index + 2 < points.length; index += 3) {
    const x = points[index] ?? 0;
    const y = points[index + 1] ?? 0;
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return true;
  }
  return false;
}

/** `stroke` moved by `dx`, `dy`. */
export function movedStroke(stroke: InkStroke, dx: number, dy: number): InkStroke {
  if (!dx && !dy) return stroke;
  return {
    ...stroke,
    points: stroke.points.map((value, index) =>
      index % 3 === 0 ? value + dx : index % 3 === 1 ? value + dy : value,
    ),
    shape: stroke.shape?.map((value, index) => (index % 2 === 0 ? value + dx : value + dy)) ?? null,
    source: null,
  };
}

/** The width of `stroke`'s line, averaged over its points. */
function meanWidth(stroke: InkStroke): number {
  const { points } = stroke;
  let sum = 0;
  let count = 0;
  for (let index = 2; index < points.length; index += 3) {
    sum += points[index] ?? 0;
    count += 1;
  }
  return count ? sum / count : stroke.size;
}

/** How much wider than its pen's size a pen's line is on average; see {@link freeStroke}. */
const PEN_SPREAD = 1.3;

/**
 * The size of the pen `stroke` looks drawn with. It is taken from the line
 * itself: older sketches give every stroke the size 10, whatever its line.
 */
export function penSizeOf(stroke: InkStroke): number {
  return meanWidth(stroke) / (stroke.type === STROKE.pen ? PEN_SPREAD : 1);
}

/** `stroke` in another colour, `#rrggbb`; how opaque it is stays. */
export function recoloredStroke(stroke: InkStroke, color: string): InkStroke {
  const next = ((stroke.color & 0xff000000) | Number.parseInt(color.slice(1), 16)) >>> 0;
  return next === stroke.color ? stroke : { ...stroke, color: next, source: null };
}

/**
 * `stroke` as if it had been drawn with a pen of `size`: its line becomes
 * thinner or thicker everywhere alike, and keeps its swelling and thinning.
 */
export function resizedStroke(stroke: InkStroke, size: number): InkStroke {
  const before = penSizeOf(stroke);
  if (!(before > 0) || !(size > 0)) return stroke;
  const factor = size / before;
  if (Math.abs(factor - 1) < 0.001 && stroke.size === size) return stroke;
  return {
    ...stroke,
    size,
    points: stroke.points.map((value, index) => (index % 3 === 2 ? round2(value * factor) : value)),
    source: null,
  };
}

/**
 * `stroke` made `factor` times as large about the point (`x`, `y`),
 * which stays where it is. The line grows and shrinks with the stroke, as
 * something drawn does when it is enlarged.
 */
export function scaledStroke(stroke: InkStroke, x: number, y: number, factor: number): InkStroke {
  if (!(factor > 0) || factor === 1) return stroke;
  return {
    ...stroke,
    size: Math.round(stroke.size * factor * 100) / 100,
    points: stroke.points.map((value, index) =>
      index % 3 === 0
        ? round2(x + (value - x) * factor)
        : index % 3 === 1
          ? round2(y + (value - y) * factor)
          : round2(value * factor),
    ),
    shape:
      stroke.shape?.map((value, index) =>
        index % 2 === 0 ? x + (value - x) * factor : y + (value - y) * factor,
      ) ?? null,
    source: null,
  };
}

// --- New strokes ----------------------------------------------------------

/** `#rrggbb` as an opaque colour number. */
export const colorNumber = (hex: string) => (0xff000000 | Number.parseInt(hex.slice(1), 16)) >>> 0;

/** A colour number as `#rrggbb`. */
export const colorHex = (color: number) => `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;

/**
 * How Evernote notes the path of a stroke with `count` points. The high
 * byte names the kind of path and the rest counts its repeated part. These
 * are the forms its own sketches use: two points, three points, and a free
 * stroke of six or more; four or five points never occur in a free stroke.
 */
function commandsFor(count: number): number {
  if (count <= 2) return 0xa1000000;
  if (count === 3) return 0xa9000000;
  return (0x51000000 | (count - 5)) >>> 0;
}

/**
 * How wide a pen's line is, as a multiple of the pen's size, where the pen
 * is pressed this hard (0 to 1). The figures are those of sketches drawn in
 * Evernote: a line there is about a third of the pen's size where the pen
 * barely touches, about 1.6 times it under a writing hand, and about 2.6
 * times it pressed hard.
 */
export function pressureSpread(pressure: number): number {
  return 0.31 + 2.3 * Math.min(1, Math.max(0, pressure)) ** 0.7;
}

/**
 * A stroke through `samples`, drawn with `pen`. A pen's line is thicker
 * where it moved slowly or was pressed harder; a highlighter's is even.
 */
export function freeStroke(samples: Sample[], pen: Pen, highlighter: boolean): InkStroke {
  // Points on top of each other add nothing.
  let path = samples.filter((sample, index) => {
    const before = samples[index - 1];
    return !before || Math.hypot(sample.x - before.x, sample.y - before.y) >= 0.4;
  });
  const first = path[0] ?? { x: 0, y: 0, time: 0, pressure: null };
  if (path.length < 2) path = [first, first];
  // A free stroke has two, three, or at least six points.
  while (path.length === 4 || path.length === 5) {
    const denser: Sample[] = [];
    path.forEach((sample, index) => {
      const next = path[index + 1];
      denser.push(sample);
      if (next) {
        denser.push({
          x: (sample.x + next.x) / 2,
          y: (sample.y + next.y) / 2,
          time: (sample.time + next.time) / 2,
          pressure:
            sample.pressure === null || next.pressure === null ? null : (sample.pressure + next.pressure) / 2,
        });
      }
    });
    path = denser;
  }
  // The hand's small jitter is smoothed away; the ends stay where they are.
  const smooth = path.map((sample, index) => {
    const before = path[index - 1];
    const after = path[index + 1];
    if (!before || !after) return sample;
    return {
      ...sample,
      x: (before.x + 2 * sample.x + after.x) / 4,
      y: (before.y + 2 * sample.y + after.y) / 4,
    };
  });
  let factor = 1;
  const widths = smooth.map((sample, index) => {
    if (highlighter) return pen.size;
    const before = smooth[index - 1];
    let target = PEN_SPREAD;
    // Pressure is what the hand meant, and is followed more closely than
    // the speed that stands in for it where there is none.
    let follow = 0.35;
    if (sample.pressure !== null && sample.pressure > 0) {
      target = pressureSpread(sample.pressure);
      follow = 0.6;
    } else if (before) {
      const elapsed = Math.max(1, sample.time - before.time);
      const speed = Math.hypot(sample.x - before.x, sample.y - before.y) / elapsed;
      target = Math.max(0.9, Math.min(1.6, 1.6 - speed * 0.45));
    }
    factor = index === 0 ? target : factor + (target - factor) * follow;
    return pen.size * factor;
  });
  // As in Evernote's strokes, the first two pairs and the last pair of
  // points share a width.
  if (!highlighter && widths.length >= 6) {
    widths[1] = widths[0] ?? pen.size;
    widths[3] = widths[2] ?? pen.size;
    widths[widths.length - 1] = widths[widths.length - 2] ?? pen.size;
  }
  return {
    type: highlighter ? STROKE.highlighter : STROKE.pen,
    color: colorNumber(pen.color),
    size: pen.size,
    points: smooth.flatMap((sample, index) => [
      round2(sample.x),
      round2(sample.y),
      round2(widths[index] ?? pen.size),
    ]),
    shape: null,
    commands: commandsFor(smooth.length),
    extra: [],
    source: null,
  };
}

function shapeStroke(
  type: number,
  corners: number[],
  shape: number[] | null,
  commands: number,
  color: number,
  width: number,
): InkStroke {
  const points: number[] = [];
  for (let index = 0; index + 1 < corners.length; index += 2) {
    points.push(round2(corners[index] ?? 0), round2(corners[index + 1] ?? 0), round2(width));
  }
  return {
    type,
    color,
    size: Math.round(width * 10) / 10,
    points,
    shape,
    commands,
    extra: [],
    source: null,
  };
}

/** A straight line from (`ax`, `ay`) to (`bx`, `by`). */
export function lineStroke(ax: number, ay: number, bx: number, by: number, color: number, width: number) {
  const corners = [ax, ay, bx, by];
  return shapeStroke(STROKE.line, corners, corners, 0xa1000000, color, width);
}

/** A rectangle with sides along the axes, begun at its lower right as Evernote's are. */
export function rectangleStroke(box: Bounds, color: number, width: number) {
  const outline = [box.right, box.bottom, box.left, box.bottom, box.left, box.top, box.right, box.top];
  return shapeStroke(
    STROKE.rectangle,
    [...outline, box.right, box.bottom],
    outline,
    0xa9000002,
    color,
    width,
  );
}

/** A triangle through three corners, x and y in turn. */
export function triangleStroke(corners: number[], color: number, width: number) {
  const closed = [...corners.slice(0, 6), corners[0] ?? 0, corners[1] ?? 0];
  return shapeStroke(STROKE.triangle, closed, null, 0xa9000001, color, width);
}

/**
 * An ellipse inside `box`. Evernote makes it of eight curves, each with two
 * ends on the ellipse and one control point outside it; the stroke's points
 * are the ends and the middle of each curve, and the shape is the ends and
 * the control points.
 */
export function ellipseStroke(box: Bounds, color: number, width: number) {
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  const rx = (box.right - box.left) / 2;
  const ry = (box.bottom - box.top) / 2;
  const step = Math.PI / 4;
  const reach = 1 / Math.cos(step / 2);
  const shape: number[] = [];
  const points: number[] = [];
  for (let index = 0; index < 8; index += 1) {
    const from = [cx + rx * Math.cos(index * step), cy + ry * Math.sin(index * step)];
    const to = [cx + rx * Math.cos((index + 1) * step), cy + ry * Math.sin((index + 1) * step)];
    const control = [
      cx + rx * reach * Math.cos((index + 0.5) * step),
      cy + ry * reach * Math.sin((index + 0.5) * step),
    ];
    shape.push(from[0] ?? 0, from[1] ?? 0, control[0] ?? 0, control[1] ?? 0);
    points.push(
      from[0] ?? 0,
      from[1] ?? 0,
      ((from[0] ?? 0) + 2 * (control[0] ?? 0) + (to[0] ?? 0)) / 4,
      ((from[1] ?? 0) + 2 * (control[1] ?? 0) + (to[1] ?? 0)) / 4,
    );
  }
  points.push(cx + rx, cy);
  return shapeStroke(STROKE.ellipse, points, shape, 0x6e000005, color, width);
}

/** Twice the area inside a closed path of x and y in turn; its sign tells the direction. */
function doubleArea(path: number[]): number {
  let sum = 0;
  for (let index = 0; index + 1 < path.length; index += 2) {
    const next = (index + 2) % path.length;
    sum += (path[index] ?? 0) * (path[next + 1] ?? 0) - (path[next] ?? 0) * (path[index + 1] ?? 0);
  }
  return sum;
}

/** The three points of `path` that span the largest triangle. */
function widestTriangle(path: number[]): number[] {
  // A few dozen points say as much as all of them.
  const stride = Math.max(1, Math.ceil(path.length / 2 / 48));
  const picked: number[] = [];
  for (let index = 0; index + 1 < path.length; index += 2 * stride) {
    picked.push(path[index] ?? 0, path[index + 1] ?? 0);
  }
  let best = picked.slice(0, 6);
  let most = -1;
  const count = picked.length / 2;
  for (let a = 0; a < count; a += 1) {
    for (let b = a + 1; b < count; b += 1) {
      for (let c = b + 1; c < count; c += 1) {
        const corners = [
          picked[a * 2] ?? 0,
          picked[a * 2 + 1] ?? 0,
          picked[b * 2] ?? 0,
          picked[b * 2 + 1] ?? 0,
          picked[c * 2] ?? 0,
          picked[c * 2 + 1] ?? 0,
        ];
        const area = Math.abs(doubleArea(corners));
        if (area > most) {
          most = area;
          best = corners;
        }
      }
    }
  }
  return best;
}

/**
 * The shape a free stroke was meant to be: a straight line, or, when the
 * stroke comes back to where it began, a rectangle, an ellipse, or a
 * triangle, whichever fills its bounding box most alike. A stroke that
 * looks like none of them is returned as it is.
 */
export function snapToShape(stroke: InkStroke): InkStroke {
  const { points } = stroke;
  const count = points.length / 3;
  if (stroke.type !== STROKE.pen || count < 2) return stroke;
  const path: number[] = [];
  let width = 0;
  for (let index = 0; index + 2 < points.length; index += 3) {
    path.push(points[index] ?? 0, points[index + 1] ?? 0);
    width += (points[index + 2] ?? 0) / count;
  }
  const [ax = 0, ay = 0] = path;
  const bx = path[path.length - 2] ?? 0;
  const by = path[path.length - 1] ?? 0;
  const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  let length = 0;
  let stray = 0;
  for (let index = 0; index + 1 < path.length; index += 2) {
    const x = path[index] ?? 0;
    const y = path[index + 1] ?? 0;
    box.left = Math.min(box.left, x);
    box.right = Math.max(box.right, x);
    box.top = Math.min(box.top, y);
    box.bottom = Math.max(box.bottom, y);
    if (index) length += Math.hypot(x - (path[index - 2] ?? 0), y - (path[index - 1] ?? 0));
    stray = Math.max(stray, distanceToSegment(x, y, ax, ay, bx, by));
  }
  const chord = Math.hypot(bx - ax, by - ay);
  const diagonal = Math.hypot(box.right - box.left, box.bottom - box.top);
  if (diagonal < 12) return stroke;
  if (chord >= 12 && stray <= Math.max(3, chord * 0.06) && length <= chord * 1.2) {
    return lineStroke(ax, ay, bx, by, stroke.color, width);
  }
  // Closed: the end is near the beginning, and the stroke went around once.
  if (chord > diagonal * 0.25 || length < diagonal * 1.6 || length > diagonal * 4.5) return stroke;
  const filled = Math.abs(doubleArea(path)) / 2 / ((box.right - box.left) * (box.bottom - box.top) || 1);
  // A rectangle fills its box, an ellipse 0.79 of it, a triangle half; a
  // hand rounds corners, so each limit lies midway between two shapes.
  if (filled >= 0.87) return rectangleStroke(box, stroke.color, width);
  if (filled >= 0.64) return ellipseStroke(box, stroke.color, width);
  if (filled >= 0.38) return triangleStroke(widestTriangle(path), stroke.color, width);
  return stroke;
}

// --- Drawing --------------------------------------------------------------

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function css(color: number, alpha = 1): string {
  const opacity = (((color >>> 24) & 255) / 255) * alpha;
  return `rgba(${(color >>> 16) & 255}, ${(color >>> 8) & 255}, ${color & 255}, ${opacity})`;
}

/** Draws `stroke` in the canvas's own coordinates. */
export function drawStroke(context: Context, stroke: InkStroke): void {
  const { points } = stroke;
  const count = Math.floor(points.length / 3);
  if (!count) return;
  const x = (index: number) => points[index * 3] ?? 0;
  const y = (index: number) => points[index * 3 + 1] ?? 0;
  const width = (index: number) => points[index * 3 + 2] ?? 0;
  context.save();
  const highlighter = stroke.type === STROKE.highlighter;
  // A highlighter's tip is flat: its line ends where the stroke does.
  context.lineCap = highlighter ? 'butt' : 'round';
  context.lineJoin = 'round';
  context.strokeStyle = css(stroke.color, highlighter ? HIGHLIGHTER_ALPHA : 1);
  context.fillStyle = context.strokeStyle;
  let widest = 0;
  let even = true;
  for (let index = 0; index < count; index += 1) {
    widest = Math.max(widest, width(index));
    if (width(index) !== width(0)) even = false;
  }
  if (count === 1) {
    context.beginPath();
    context.arc(x(0), y(0), widest / 2, 0, Math.PI * 2);
    context.fill();
  } else if (stroke.type === STROKE.ellipse && count % 2 === 1) {
    // Ends and middles of curves: the control point follows from the three.
    context.lineWidth = widest;
    context.beginPath();
    context.moveTo(x(0), y(0));
    for (let index = 0; index + 2 < count; index += 2) {
      context.quadraticCurveTo(
        2 * x(index + 1) - (x(index) + x(index + 2)) / 2,
        2 * y(index + 1) - (y(index) + y(index + 2)) / 2,
        x(index + 2),
        y(index + 2),
      );
    }
    context.stroke();
  } else if (even || highlighter) {
    // One path, so that a highlighter does not darken where it crosses itself.
    context.lineWidth = widest;
    context.beginPath();
    context.moveTo(x(0), y(0));
    for (let index = 1; index < count; index += 1) context.lineTo(x(index), y(index));
    context.stroke();
  } else {
    for (let index = 0; index + 1 < count; index += 1) {
      context.lineWidth = (width(index) + width(index + 1)) / 2;
      context.beginPath();
      context.moveTo(x(index), y(index));
      context.lineTo(x(index + 1), y(index + 1));
      context.stroke();
    }
  }
  context.restore();
}

/** Whether a paper of this colour is dark, so that marks on it must be light. */
export function isDark(background: string): boolean {
  const value = Number.parseInt(background.slice(1), 16);
  return ((value >> 16) & 255) * 0.299 + ((value >> 8) & 255) * 0.587 + (value & 255) * 0.114 < 110;
}

/**
 * Draws the paper's pattern over `area` of the canvas. `thin` is the size
 * of one screen pixel in the canvas's units, so that lines stay fine at any
 * zoom.
 */
export function drawPattern(
  context: Context,
  pattern: number,
  background: string,
  area: Bounds,
  thin = 1,
): void {
  const { kind, spacing } = PATTERNS[pattern] ?? PATTERNS[0] ?? { kind: 'none', spacing: 0 };
  if (kind === 'none' || !spacing) return;
  // Not worth drawing once the marks would run together.
  if (spacing / thin < 6) return;
  context.save();
  context.fillStyle = isDark(background) ? 'rgba(255, 255, 255, 0.07)' : 'rgba(0, 0, 0, 0.15)';
  const firstX = Math.floor(area.left / spacing) * spacing;
  const firstY = Math.floor(area.top / spacing) * spacing;
  const line = Math.max(1, thin);
  if (kind === 'dots') {
    const dot = Math.max(2, thin * 2);
    for (let y = firstY; y <= area.bottom; y += spacing) {
      for (let x = firstX; x <= area.right; x += spacing)
        context.fillRect(x - dot / 2, y - dot / 2, dot, dot);
    }
  } else {
    for (let y = firstY; y <= area.bottom; y += spacing) {
      context.fillRect(area.left, y - line / 2, area.right - area.left, line);
    }
    if (kind === 'grid') {
      for (let x = firstX; x <= area.right; x += spacing) {
        context.fillRect(x - line / 2, area.top, line, area.bottom - area.top);
      }
    }
  }
  context.restore();
}
