/**
 * Evernote's annotation document (see `pngChunks.ts` for where it lives).
 *
 * A document has a frame, the size of the finished picture, and three
 * layers: the original picture, the drawn marks, and the text. Marks are
 * kept exactly as Evernote wrote them, with every field this module does
 * not use, so a picture that is changed here can still be changed there.
 * Coordinates are pixels of the document's frame.
 */

export interface SkPoint {
  x: number;
  y: number;
}

export interface SkFrame extends SkPoint {
  width: number;
  height: number;
}

export interface SkColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

/** A mark, or the original picture, as written in the document. */
export interface SkObject {
  type: string;
  guid?: string;
  [field: string]: unknown;
}

export interface SkLayer {
  type: 'Layer';
  layerId: string;
  children: SkObject[];
  [field: string]: unknown;
}

export interface SkDocument {
  type: 'Document';
  frame: SkFrame;
  children: SkLayer[];
  [field: string]: unknown;
}

export type ShapeKind = 'rectangle' | 'rounded' | 'ellipse' | 'line' | 'arrow';
export type StampKind = 'approved' | 'question' | 'rejected' | 'exclaim' | 'perfect';

export const STAMPS: Record<StampKind, { label: string; color: string }> = {
  approved: { label: 'Approved', color: '#1faa3f' },
  question: { label: 'Question', color: '#2b7de9' },
  rejected: { label: 'Rejected', color: '#e8262d' },
  exclaim: { label: 'Important', color: '#f08c00' },
  perfect: { label: 'Liked', color: '#e64980' },
};

export const SHAPES: Record<ShapeKind, string> = {
  rectangle: 'Square',
  rounded: 'Rounded',
  ellipse: 'Circle',
  line: 'Line',
  arrow: 'Arrow',
};

const BACKGROUND = '__background__';
const DRAWN = '__annotation__';
const TEXT = '__text__';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const number = (value: unknown, fallback = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const point = (value: unknown): SkPoint =>
  isRecord(value) ? { x: number(value.x), y: number(value.y) } : { x: 0, y: 0 };
const frame = (value: unknown): SkFrame =>
  isRecord(value)
    ? { x: number(value.x), y: number(value.y), width: number(value.width), height: number(value.height) }
    : { x: 0, y: 0, width: 0, height: 0 };
const color = (value: unknown): SkColor | null =>
  isRecord(value)
    ? {
        red: number(value.red),
        green: number(value.green),
        blue: number(value.blue),
        alpha: number(value.alpha, 1),
      }
    : null;
const css = (value: SkColor) => `rgba(${value.red}, ${value.green}, ${value.blue}, ${value.alpha})`;
const extension = (mark: SkObject) => (isRecord(mark.extension) ? mark.extension : null);
const round = (value: number) => Math.round(value * 1000) / 1000;

/** Reads a document, or returns null when it is not one this module can draw. */
export function parseDocument(value: unknown): SkDocument | null {
  if (!isRecord(value) || value.type !== 'Document' || !Array.isArray(value.children)) return null;
  const size = frame(value.frame);
  if (size.width < 1 || size.height < 1) return null;
  const layers = value.children.filter(
    (layer): layer is SkLayer =>
      isRecord(layer) && typeof layer.layerId === 'string' && Array.isArray(layer.children),
  );
  if (!layers.some((layer) => layer.layerId === BACKGROUND)) return null;
  return { ...value, type: 'Document', frame: size, children: layers };
}

/** A document for a picture that has no marks yet. */
export function newDocument(width: number, height: number, guid: string): SkDocument {
  const size = { x: 0, y: 0, width, height };
  return {
    type: 'Document',
    metadata: { version: '1.1', userAgentHistory: ['Bever'] },
    frame: size,
    deviceScale: 1,
    contentScaleFactor: round(toolScale(size)),
    coordinateSystem: 1,
    children: [
      {
        type: 'Layer',
        layerId: BACKGROUND,
        children: [
          {
            type: 'Bitmap',
            guid,
            uri: `skitch+uuid:///${guid}.png`,
            frame: size,
            contentMode: 0,
            style: shadow(false),
          },
        ],
      },
      { type: 'Layer', layerId: DRAWN, children: [] },
      { type: 'Layer', layerId: TEXT, children: [] },
    ],
  };
}

/** How much larger than on a small picture the tools draw on this one. */
export function toolScale(size: SkFrame): number {
  return Math.max(1, Math.max(size.width, size.height) / 700);
}

/** The marks of a document, in the order they are drawn. */
export function marksOf(document: SkDocument): SkObject[] {
  return document.children.filter((layer) => layer.layerId !== BACKGROUND).flatMap((layer) => layer.children);
}

/** The original pictures of a document and where they lie in its frame. */
export function bitmapsOf(document: SkDocument): { guid: string; frame: SkFrame }[] {
  return document.children
    .filter((layer) => layer.layerId === BACKGROUND)
    .flatMap((layer) => layer.children)
    .filter((child) => child.type === 'Bitmap')
    .map((child) => ({ guid: str(child.guid), frame: frame(child.frame) }));
}

/** `document` with `marks` in place of the ones it has. */
export function withMarks(document: SkDocument, marks: SkObject[]): SkDocument {
  const text = marks.filter((mark) => mark.type === 'Text');
  const drawn = marks.filter((mark) => mark.type !== 'Text');
  const children = document.children.filter((layer) => layer.layerId === BACKGROUND);
  const layer = (layerId: string, kept: SkObject[]): SkLayer => ({
    ...(document.children.find((existing) => existing.layerId === layerId) ?? { type: 'Layer', layerId }),
    type: 'Layer',
    layerId,
    children: kept,
  });
  return { ...document, children: [...children, layer(DRAWN, drawn), layer(TEXT, text)] };
}

function shadow(dropped: boolean) {
  return {
    shadowColor: { red: 0, green: 0, blue: 0, alpha: 0.35 },
    shadowOpacity: 0.35,
    shadowOffset: { width: 0, height: dropped ? 3 : 0 },
    shadowRadius: dropped ? 4 : 0,
  };
}

function applyShadow(context: CanvasRenderingContext2D, mark: SkObject) {
  const style = isRecord(mark.style) ? mark.style : null;
  const radius = number(style?.shadowRadius);
  const offset = isRecord(style?.shadowOffset) ? style.shadowOffset : null;
  if (!style || (radius <= 0 && number(offset?.height) === 0 && number(offset?.width) === 0)) return;
  context.shadowColor = `rgba(0, 0, 0, ${number(style.shadowOpacity, 0.35)})`;
  context.shadowBlur = radius;
  context.shadowOffsetX = number(offset?.width);
  context.shadowOffsetY = number(offset?.height);
}

// --- Text ---------------------------------------------------------------

/**
 * The text of a text mark. Some versions of Evernote store characters
 * outside ASCII as percent escapes, escaped again with every save
 * (`%252525E2%25252588%25252598` for one character); others store them as
 * they are. Only such escapes are undone, so "50%" and "%41" stay as typed.
 */
export function textOf(mark: SkObject): string {
  let text = str(mark.text);
  // An escaped escape, or an escaped byte no ASCII character has, shows that
  // the text was escaped; then all of it is undone, however often it was done.
  if (!/%(25)+[0-9a-f]{2}|%[89a-f][0-9a-f]/i.test(text)) return text;
  for (let pass = 0; pass < 8 && /%[0-9a-f]{2}/i.test(text); pass += 1) {
    try {
      const decoded = decodeURIComponent(text);
      if (decoded === text) break;
      text = decoded;
    } catch {
      break;
    }
  }
  return text;
}

const lines = (text: string) => text.split('\n');
const LINE_HEIGHT = 1.18;

function textFont(mark: SkObject): { size: number; font: string } {
  const font = isRecord(mark.font) ? mark.font : {};
  const size = Math.max(4, number(font.size, 16));
  const weight = mark.textStyle === 'bubbleText' || mark.textStyle === undefined ? 700 : 400;
  return { size, font: `${weight} ${size}px Helvetica, Arial, sans-serif` };
}

/** Measures text; the editor passes the canvas, tests an estimate. */
export type Measure = (text: string, font: string) => number;

const estimate: Measure = (text, font) =>
  text.length * (Number.parseFloat(/(\d+(\.\d+)?)px/.exec(font)?.[1] ?? '16') * 0.56);

function textBox(mark: SkObject, measure: Measure): SkFrame {
  const { size, font } = textFont(mark);
  const rows = lines(textOf(mark));
  const origin = point(mark.origin);
  return {
    x: origin.x,
    y: origin.y,
    width: Math.max(size * 0.5, ...rows.map((row) => measure(row, font))),
    height: rows.length * size * LINE_HEIGHT,
  };
}

function drawText(context: CanvasRenderingContext2D, mark: SkObject) {
  const { size, font } = textFont(mark);
  const origin = point(mark.origin);
  const outline = color(mark.strokeColor);
  const fill = color(mark.fillColor) ?? { red: 0, green: 0, blue: 0, alpha: 1 };
  const width = number(mark.lineWidth);
  context.font = font;
  context.textBaseline = 'alphabetic';
  context.lineJoin = 'round';
  lines(textOf(mark)).forEach((row, index) => {
    // The first line's top is the origin; a line's letters sit this far below.
    // Measured against the pictures Evernote itself drew from such marks.
    const y = origin.y + index * size * LINE_HEIGHT + size * 1.02 + 2;
    if (outline && width > 0) {
      context.save();
      applyShadow(context, mark);
      context.strokeStyle = css(outline);
      context.lineWidth = width;
      context.strokeText(row, origin.x, y);
      context.restore();
    }
    context.fillStyle = css(fill);
    context.fillText(row, origin.x, y);
  });
}

// --- Stamps -------------------------------------------------------------

function stampKind(mark: SkObject): StampKind {
  const name = str(mark.stampName).split('.').pop() ?? '';
  return name in STAMPS ? (name as StampKind) : 'approved';
}

function drawStamp(context: CanvasRenderingContext2D, mark: SkObject, label: SkObject | undefined) {
  const box = frame(mark.frame);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const radius = box.width * 0.215;
  const kind = stampKind(mark);
  const tail = typeof mark.tailAngleInDegrees === 'number' ? (mark.tailAngleInDegrees * Math.PI) / 180 : null;
  context.save();
  applyShadow(context, { ...mark, style: shadow(true) });
  if (label) {
    // The label is a dark tab that leaves the badge on the side away from the tail.
    const { size, font } = textFont(label);
    context.font = font;
    const text = textOf(label);
    const width = context.measureText(text).width + size * 1.5;
    const height = radius * 1.45;
    const away = tail !== null && Math.cos(tail) > 0 ? -1 : 1;
    const left = away > 0 ? x : x - radius - width;
    context.fillStyle = 'rgba(20, 20, 20, 0.92)';
    context.beginPath();
    context.roundRect(left, y - height / 2, radius + width, height, height / 2);
    context.fill();
    context.shadowColor = 'transparent';
    context.fillStyle = css(color(label.fillColor) ?? { red: 255, green: 255, blue: 255, alpha: 1 });
    context.textBaseline = 'middle';
    context.fillText(text, away > 0 ? x + radius + size * 0.6 : left + size * 0.7, y + size * 0.05);
  }
  context.fillStyle = STAMPS[kind].color;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  if (tail !== null) {
    const reach = box.width / 2;
    context.moveTo(x + Math.cos(tail) * reach, y - Math.sin(tail) * reach);
    context.lineTo(x + Math.cos(tail + 1.15) * radius, y - Math.sin(tail + 1.15) * radius);
    context.lineTo(x + Math.cos(tail - 1.15) * radius, y - Math.sin(tail - 1.15) * radius);
    context.closePath();
  }
  context.fill();
  context.restore();

  context.save();
  context.strokeStyle = '#ffffff';
  context.fillStyle = '#ffffff';
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = radius * 0.13;
  context.beginPath();
  context.arc(x, y, radius * 0.8, 0, Math.PI * 2);
  context.stroke();
  context.lineWidth = radius * 0.22;
  const glyph = radius * 0.4;
  context.beginPath();
  if (kind === 'approved') {
    context.moveTo(x - glyph, y + glyph * 0.05);
    context.lineTo(x - glyph * 0.25, y + glyph * 0.8);
    context.lineTo(x + glyph, y - glyph * 0.7);
    context.stroke();
  } else if (kind === 'rejected') {
    context.moveTo(x - glyph * 0.8, y - glyph * 0.8);
    context.lineTo(x + glyph * 0.8, y + glyph * 0.8);
    context.moveTo(x + glyph * 0.8, y - glyph * 0.8);
    context.lineTo(x - glyph * 0.8, y + glyph * 0.8);
    context.stroke();
  } else if (kind === 'perfect') {
    const top = y - glyph * 0.4;
    context.moveTo(x, y + glyph);
    context.bezierCurveTo(x - glyph * 2, top + glyph * 0.2, x - glyph, top - glyph * 1.1, x, top);
    context.bezierCurveTo(x + glyph, top - glyph * 1.1, x + glyph * 2, top + glyph * 0.2, x, y + glyph);
    context.fill();
  } else {
    context.font = `700 ${radius * 1.15}px Helvetica, Arial, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(kind === 'question' ? '?' : '!', x, y + radius * 0.06);
  }
  context.restore();
}

// --- Vectors ------------------------------------------------------------

/** The numbers of a path, as the corner points it passes through. */
function pathPoints(path: string): SkPoint[] {
  const points: SkPoint[] = [];
  for (const [, command, rest] of path.matchAll(/([MLCQZmlcqz])([^MLCQZmlcqz]*)/g)) {
    const values = (rest ?? '').match(/-?\d*\.?\d+(?:e-?\d+)?/gi)?.map(Number) ?? [];
    // Only the last pair of a curve is on the path; the others pull it.
    const step = command === 'C' ? 6 : command === 'Q' ? 4 : 2;
    for (let index = step - 2; index + 1 < values.length; index += step) {
      points.push({ x: values[index] ?? 0, y: values[index + 1] ?? 0 });
    }
  }
  return points;
}

function shiftPath(path: string, dx: number, dy: number): string {
  return path.replace(/([MLCQ])([^MLCQZmlcqz]*)/g, (_, command: string, rest: string) => {
    const values = rest.match(/-?\d*\.?\d+(?:e-?\d+)?/gi)?.map(Number) ?? [];
    return `${command} ${values.map((value, index) => round(value + (index % 2 === 0 ? dx : dy))).join(' ')} `;
  });
}

function arrowEnds(mark: SkObject): { start: SkPoint; end: SkPoint } | null {
  const shape = extension(mark);
  return shape?.type === 'Arrow' ? { start: point(shape.startPoint), end: point(shape.endPoint) } : null;
}

/**
 * The outline Evernote draws for an arrow, from the path it stores for it.
 *
 * The stored path has five points: the tail, the upper barb, the tip, the
 * lower barb, and a notch where the shaft meets the head, below the middle
 * only. Drawn as it stands it is lopsided: the shaft runs straight into
 * the upper barb. Evernote does not draw it so. Its own pictures show the
 * same arrow with the notch on both sides, a thin tail widening into a
 * shaft with a barbed head, which is the stored path mirrored about the
 * arrow's line. (Compared on pictures with a single arrow, the mirrored
 * outline covers what Evernote drew far better than the stored one, in
 * every one of them.) A path of another form is drawn as it is.
 */
export function arrowOutline(path: string): string {
  if (!/^\s*M[^MLZ]+(L[^MLZ]+){4}Z\s*$/i.test(path)) return path;
  const numbers = (path.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/gi) ?? []).map(Number);
  if (numbers.length !== 10 || !numbers.every(Number.isFinite)) return path;
  const [tailX = 0, tailY = 0, barbX = 0, barbY = 0, tipX = 0, tipY = 0, , , notchX = 0, notchY = 0] =
    numbers;
  const tail = Math.abs(tailY - tipY);
  const barb = Math.abs(barbY - tipY);
  const notch = Math.abs(notchY - tipY);
  const points = [
    [tailX, tipY - tail],
    [notchX, tipY - notch],
    [barbX, tipY - barb],
    [tipX, tipY],
    [barbX, tipY + barb],
    [notchX, tipY + notch],
    [tailX, tipY + tail],
  ];
  return `${points.map(([x = 0, y = 0], index) => `${index ? 'L' : 'M'} ${round(x)} ${round(y)}`).join(' ')} Z`;
}

function drawVector(context: CanvasRenderingContext2D, mark: SkObject) {
  const arrow = arrowEnds(mark);
  const path = new Path2D(arrow ? arrowOutline(str(mark.path)) : str(mark.path));
  const stroke = color(mark.strokeColor);
  const fill = color(mark.fillColor);
  context.save();
  applyShadow(context, mark);
  if (arrow) {
    // An arrow is written lying along the x axis from the origin.
    context.translate(arrow.start.x, arrow.start.y);
    context.rotate(Math.atan2(arrow.end.y - arrow.start.y, arrow.end.x - arrow.start.x));
  }
  context.lineCap = 'round';
  context.lineJoin = 'round';
  if (fill) {
    context.fillStyle = css(fill);
    context.fill(path);
  }
  if (stroke && number(mark.lineWidth) > 0) {
    context.strokeStyle = css(stroke);
    context.lineWidth = number(mark.lineWidth);
    context.stroke(path);
  }
  context.restore();
}

// --- Drawing ------------------------------------------------------------

/**
 * Draws the marks of a document. The canvas is expected to map the
 * document's frame onto itself already, with the originals drawn.
 */
export function drawMarks(context: CanvasRenderingContext2D, marks: SkObject[]) {
  const labels = new Map(
    marks
      .filter((mark) => typeof mark.labelParent === 'string')
      .map((mark) => [String(mark.labelParent), mark]),
  );
  for (const mark of marks) {
    if (mark.type === 'Vector') drawVector(context, mark);
    else if (mark.type === 'Stamp') drawStamp(context, mark, labels.get(String(mark.guid)));
    // A stamp's label is drawn with its stamp.
    else if (mark.type === 'Text' && typeof mark.labelParent !== 'string') drawText(context, mark);
  }
}

// --- Finding and moving -------------------------------------------------

function distanceToSegment(at: SkPoint, from: SkPoint, to: SkPoint): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = dx * dx + dy * dy;
  const along =
    length === 0 ? 0 : Math.max(0, Math.min(1, ((at.x - from.x) * dx + (at.y - from.y) * dy) / length));
  return Math.hypot(at.x - (from.x + along * dx), at.y - (from.y + along * dy));
}

const inside = (at: SkPoint, box: SkFrame, slack: number) =>
  at.x >= box.x - slack &&
  at.x <= box.x + box.width + slack &&
  at.y >= box.y - slack &&
  at.y <= box.y + box.height + slack;

/** The rectangle a mark covers. */
export function boundsOf(mark: SkObject, measure: Measure = estimate): SkFrame {
  if (mark.type === 'Text') return textBox(mark, measure);
  if (mark.type === 'Stamp') {
    const box = frame(mark.frame);
    // The badge is the middle of its frame; the rest is room for a tail.
    return {
      x: box.x + box.width * 0.25,
      y: box.y + box.height * 0.25,
      width: box.width / 2,
      height: box.height / 2,
    };
  }
  const arrow = arrowEnds(mark);
  const points = arrow ? [arrow.start, arrow.end] : pathPoints(str(mark.path));
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = points.map((item) => item.x);
  const ys = points.map((item) => item.y);
  const reach = number(mark.lineWidth) / 2;
  const left = Math.min(...xs) - reach;
  const top = Math.min(...ys) - reach;
  return { x: left, y: top, width: Math.max(...xs) + reach - left, height: Math.max(...ys) + reach - top };
}

/** Whether `at` is on `mark`, give or take `slack` pixels. */
export function hits(mark: SkObject, at: SkPoint, slack: number, measure: Measure = estimate): boolean {
  if (mark.type !== 'Vector') return inside(at, boundsOf(mark, measure), slack);
  const shape = extension(mark);
  // A closed shape is taken by its area, so that it is easy to pick up.
  if (shape?.type === 'Polygon' || shape?.type === 'Ellipse') return inside(at, boundsOf(mark), slack);
  const arrow = arrowEnds(mark);
  const points = arrow ? [arrow.start, arrow.end] : pathPoints(str(mark.path));
  const reach = Math.max(number(mark.lineWidth), arrow ? number(shape?.toolArrowSize) * 1.5 : 0) / 2 + slack;
  const [first] = points;
  if (points.length === 1 && first) return Math.hypot(at.x - first.x, at.y - first.y) <= reach;
  return points.some((from, index) => {
    const to = points[index + 1];
    return to !== undefined && distanceToSegment(at, from, to) <= reach;
  });
}

/** The topmost mark under `at`, as its place in `marks`, or -1. */
export function markAt(marks: SkObject[], at: SkPoint, slack: number, measure: Measure = estimate): number {
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    const mark = marks[index];
    // A stamp's label follows its stamp and is not picked up by itself.
    if (mark && typeof mark.labelParent !== 'string' && hits(mark, at, slack, measure)) return index;
  }
  return -1;
}

const shifted = (value: unknown, dx: number, dy: number) => {
  const at = point(value);
  return { ...(isRecord(value) ? value : {}), x: round(at.x + dx), y: round(at.y + dy) };
};

/** `mark` moved by `dx`, `dy`, with every field that places it changed alike. */
export function moved(mark: SkObject, dx: number, dy: number): SkObject {
  if (mark.type === 'Text') return { ...mark, origin: shifted(mark.origin, dx, dy) };
  if (mark.type === 'Stamp') return { ...mark, frame: shifted(mark.frame, dx, dy) };
  const shape = extension(mark);
  const next: SkObject = { ...mark };
  // An arrow's path lies at the origin; its end points place it.
  if (shape?.type !== 'Arrow') next.path = shiftPath(str(mark.path), dx, dy).trim();
  if (shape) {
    const placed: Record<string, unknown> = { ...shape };
    for (const key of ['startPoint', 'endPoint', 'center']) {
      if (isRecord(shape[key])) placed[key] = shifted(shape[key], dx, dy);
    }
    if (Array.isArray(shape.vertices))
      placed.vertices = shape.vertices.map((vertex) => shifted(vertex, dx, dy));
    next.extension = placed;
  }
  return next;
}

/** `mark` with another text; other marks are returned as they are. */
export function withText(mark: SkObject, text: string): SkObject {
  return mark.type === 'Text' ? { ...mark, text } : mark;
}

// --- New marks ----------------------------------------------------------

const rgb = (hex: string, alpha = 1): SkColor => ({
  red: Number.parseInt(hex.slice(1, 3), 16),
  green: Number.parseInt(hex.slice(3, 5), 16),
  blue: Number.parseInt(hex.slice(5, 7), 16),
  alpha,
});

const pair = (at: SkPoint) => `${round(at.x)} ${round(at.y)}`;

export interface Pen {
  /** `#rrggbb` */
  color: string;
  /** Line width in pixels of the picture. */
  width: number;
}

/** A freehand stroke; a highlighter is the same, wide and translucent. */
export function strokeMark(points: SkPoint[], pen: Pen, highlighter: boolean, guid: string): SkObject {
  const [first, ...rest] = points;
  const path = first
    ? `M ${pair(first)} ${rest.length ? rest.map((at) => `L ${pair(at)}`).join(' ') : `L ${pair({ x: first.x + 0.01, y: first.y })}`}`
    : '';
  return {
    type: 'Vector',
    guid,
    style: shadow(false),
    path,
    lineWidth: round(highlighter ? pen.width * 2 : pen.width),
    strokeColor: rgb(pen.color, highlighter ? 0.4 : 1),
  };
}

/** Four curves that make an ellipse, as Evernote writes one. */
function ellipsePath(center: SkPoint, rx: number, ry: number): string {
  const k = 0.5522847498;
  const { x, y } = center;
  return [
    `M ${pair({ x: x - rx, y })}`,
    `C ${pair({ x: x - rx, y: y - ry * k })} ${pair({ x: x - rx * k, y: y - ry })} ${pair({ x, y: y - ry })}`,
    `C ${pair({ x: x + rx * k, y: y - ry })} ${pair({ x: x + rx, y: y - ry * k })} ${pair({ x: x + rx, y })}`,
    `C ${pair({ x: x + rx, y: y + ry * k })} ${pair({ x: x + rx * k, y: y + ry })} ${pair({ x, y: y + ry })}`,
    `C ${pair({ x: x - rx * k, y: y + ry })} ${pair({ x: x - rx, y: y + ry * k })} ${pair({ x: x - rx, y })}`,
    'Z',
  ].join(' ');
}

export function shapeMark(kind: ShapeKind, from: SkPoint, to: SkPoint, pen: Pen, guid: string): SkObject {
  const base = { type: 'Vector', guid, lineWidth: round(pen.width) };
  const left = Math.min(from.x, to.x);
  const top = Math.min(from.y, to.y);
  const right = Math.max(from.x, to.x);
  const bottom = Math.max(from.y, to.y);
  if (kind === 'line') {
    return {
      ...base,
      style: shadow(false),
      path: `M ${pair(from)} L ${pair(to)}`,
      strokeColor: rgb(pen.color),
      extension: { type: 'Line', startPoint: from, endPoint: to },
    };
  }
  if (kind === 'arrow') {
    // The shape Evernote draws: a thin tail that widens into a barbed head.
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const half = Math.min(length * 0.22, pen.width * 0.77 + 5.445);
    const neck = length - half * 2;
    return {
      ...base,
      lineWidth: 2,
      style: shadow(true),
      path: `M 0 -1.5 L ${round(neck)} ${round(-half)} L ${round(length)} 0 L ${round(neck)} ${round(half)} L ${round(neck + (half * 2) / 11)} ${round((half * 5) / 11)} Z`,
      fillColor: rgb(pen.color),
      extension: { type: 'Arrow', startPoint: from, endPoint: to, toolArrowSize: round(pen.width) },
    };
  }
  if (kind === 'ellipse') {
    const center = { x: (left + right) / 2, y: (top + bottom) / 2 };
    const rx = (right - left) / 2;
    const ry = (bottom - top) / 2;
    return {
      ...base,
      style: shadow(false),
      path: ellipsePath(center, rx, ry),
      strokeColor: rgb(pen.color),
      extension: { type: 'Ellipse', center, xradius: round(rx), yradius: round(ry) },
    };
  }
  const corners = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  if (kind === 'rectangle') {
    return {
      ...base,
      style: shadow(false),
      path: `M ${corners.map(pair).join(' L ')} L ${pair({ x: left, y: top })}`,
      strokeColor: rgb(pen.color),
      extension: { type: 'Polygon', vertices: corners, extension: { type: 'Rectangle' } },
    };
  }
  // Evernote's older files have no rounded rectangle; it is written as the
  // free path it is, which every version can draw and move.
  const r = Math.min(right - left, bottom - top) * 0.2;
  const k = r * (1 - 0.5522847498);
  return {
    ...base,
    style: shadow(false),
    strokeColor: rgb(pen.color),
    path: [
      `M ${pair({ x: left + r, y: top })}`,
      `L ${pair({ x: right - r, y: top })}`,
      `C ${pair({ x: right - k, y: top })} ${pair({ x: right, y: top + k })} ${pair({ x: right, y: top + r })}`,
      `L ${pair({ x: right, y: bottom - r })}`,
      `C ${pair({ x: right, y: bottom - k })} ${pair({ x: right - k, y: bottom })} ${pair({ x: right - r, y: bottom })}`,
      `L ${pair({ x: left + r, y: bottom })}`,
      `C ${pair({ x: left + k, y: bottom })} ${pair({ x: left, y: bottom - k })} ${pair({ x: left, y: bottom - r })}`,
      `L ${pair({ x: left, y: top + r })}`,
      `C ${pair({ x: left, y: top + k })} ${pair({ x: left + k, y: top })} ${pair({ x: left + r, y: top })}`,
      'Z',
    ].join(' '),
  };
}

export function textMark(text: string, at: SkPoint, size: number, colorHex: string, guid: string): SkObject {
  // Dark letters get a white edge and light letters a black one, as in Evernote.
  const light = rgb(colorHex);
  const bright = (light.red * 299 + light.green * 587 + light.blue * 114) / 1000 > 200;
  return {
    type: 'Text',
    guid,
    style: shadow(true),
    textStyle: 'bubbleText',
    text,
    origin: at,
    font: { name: 'Helvetica,Arial', size: round(size) },
    strokeColor: bright ? rgb('#000000') : rgb('#ffffff'),
    fillColor: light,
    lineWidth: round(size / 3),
    alignment: 'left',
    direction: 'leftToRight',
  };
}

export function stampMark(kind: StampKind, at: SkPoint, size: number, guid: string): SkObject {
  return {
    type: 'Stamp',
    guid,
    style: shadow(true),
    stampName: `com.evernote.skitch.${kind}`,
    frame: { x: round(at.x - size / 2), y: round(at.y - size / 2), width: round(size), height: round(size) },
  };
}

/** Whether a mark that was just drawn is worth keeping. */
export function isWorthKeeping(mark: SkObject): boolean {
  if (mark.type === 'Text') return textOf(mark).trim() !== '';
  if (mark.type === 'Stamp') return true;
  const shape = extension(mark);
  if (shape?.type === 'Arrow' || shape?.type === 'Line') {
    const start = point(shape.startPoint);
    const end = point(shape.endPoint);
    return Math.hypot(end.x - start.x, end.y - start.y) >= 3;
  }
  if (shape || /Z\s*$/.test(str(mark.path))) {
    const box = boundsOf(mark);
    return box.width - number(mark.lineWidth) >= 3 && box.height - number(mark.lineWidth) >= 3;
  }
  return str(mark.path) !== '';
}
