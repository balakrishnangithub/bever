import {
  ArrowUpRight,
  Circle,
  Delete,
  Eraser,
  Highlighter,
  Minus,
  MousePointer2,
  PenLine,
  Redo2,
  Shapes,
  Square,
  SquareRoundCorner,
  Stamp,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useBackCloses } from '../lib/useBackCloses';
import { canvasPngSoon } from './canvasPng';
import { leaveField } from '../lib/windowHeight';

import { isPng, originalFor, readAnnotations, writeAnnotations, type EmbeddedOriginal } from './pngChunks';
import {
  bitmapsOf,
  boundsOf,
  drawMarks,
  isWorthKeeping,
  markAt,
  marksOf,
  moved,
  newDocument,
  parseDocument,
  SHAPES,
  shapeMark,
  stampMark,
  STAMPS,
  strokeMark,
  textMark,
  textOf,
  toolScale,
  withMarks,
  withText,
  type Measure,
  type ShapeKind,
  type SkDocument,
  type SkFrame,
  type SkObject,
  type SkPoint,
  type StampKind,
} from './skitch';

type Tool = 'select' | 'pen' | 'highlighter' | 'text' | 'stamp' | 'shape' | 'eraser';

const COLORS = ['#e8262d', '#f08c00', '#fff700', '#00e800', '#1c7ed6', '#fc0c59', '#000000', '#ffffff'];

const SHAPE_ICONS: Record<ShapeKind, ReactNode> = {
  rectangle: <Square />,
  rounded: <SquareRoundCorner />,
  ellipse: <Circle />,
  line: <Minus />,
  arrow: <ArrowUpRight />,
};

interface Loaded {
  document: SkDocument;
  /**
   * The unmarked pictures, as they are saved. A picture that is not a PNG is
   * made one while it is being drawn on, so this may not be ready at once.
   */
  originals: Promise<EmbeddedOriginal[]>;
  /** The originals as pictures that can be drawn, in the document's order. */
  pictures: { image: CanvasImageSource; frame: SkFrame }[];
}

interface Props {
  /** The picture file as it is stored. */
  bytes: Uint8Array;
  mime: string;
  name: string;
  /** Stores the finished PNG; the annotator closes when it resolves. */
  onSave: (picture: Uint8Array) => Promise<void>;
  onClose: () => void;
}

async function pictureFrom(bytes: Uint8Array, mime: string): Promise<HTMLImageElement> {
  const address = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  try {
    const image = new Image();
    image.src = address;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(address);
  }
}

/**
 * Reads a picture for annotating. A picture Evernote annotated carries its
 * original and its marks, which are taken up as they are. Any other picture
 * becomes the original of a new, empty annotation document.
 */
async function load(bytes: Uint8Array, mime: string): Promise<Loaded> {
  const embedded = isPng(bytes) ? readAnnotations(bytes) : null;
  const document = embedded ? parseDocument(embedded.manifest) : null;
  if (embedded && document) {
    const pictures: Loaded['pictures'] = [];
    for (const [index, bitmap] of bitmapsOf(document).entries()) {
      const original = originalFor(embedded.originals, bitmap.guid, index);
      if (original) pictures.push({ image: await pictureFrom(original, 'image/png'), frame: bitmap.frame });
    }
    if (pictures.length) return { document, originals: Promise.resolve(embedded.originals), pictures };
  }
  const image = await pictureFrom(bytes, mime);
  const width = image.naturalWidth || 1;
  const height = image.naturalHeight || 1;
  // Evernote keeps originals as PNG, so another format is converted once.
  // That takes a moment for a photograph, so it is not waited for here: it
  // is done once the picture is showing, and saving waits for the rest.
  let original = Promise.resolve(bytes);
  if (!isPng(bytes) || embedded) {
    const canvas = window.document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')?.drawImage(image, 0, 0, width, height);
    original = canvasPngSoon(canvas);
  }
  const guid = crypto.randomUUID();
  const fresh = newDocument(width, height, guid);
  const originals = original.then((converted) => [{ guid, bytes: converted }]);
  // A failure is reported when the picture is saved, which is where it matters.
  originals.catch(() => undefined);
  return { document: fresh, originals, pictures: [{ image, frame: fresh.frame }] };
}

function paint(context: CanvasRenderingContext2D, loaded: Loaded, marks: SkObject[]) {
  const { frame } = loaded.document;
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  // Where the canvas reaches beyond the original, it is white, as in Evernote.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, context.canvas.width, context.canvas.height);
  context.scale(context.canvas.width / frame.width, context.canvas.height / frame.height);
  context.translate(-frame.x, -frame.y);
  for (const picture of loaded.pictures) {
    context.drawImage(
      picture.image,
      picture.frame.x,
      picture.frame.y,
      picture.frame.width,
      picture.frame.height,
    );
  }
  drawMarks(context, marks);
  context.restore();
}

/**
 * Draws on a picture: pen, highlighter, text, stamps and shapes, in the
 * format Evernote uses, so that marks made in either application can be
 * moved, reworded or removed in the other. The original picture is kept
 * inside the saved file and is never drawn on.
 */
export function ImageAnnotator({ bytes, mime, name, onSave, onClose }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [marks, setMarks] = useState<SkObject[]>([]);
  const [past, setPast] = useState<SkObject[][]>([]);
  const [future, setFuture] = useState<SkObject[][]>([]);
  const [tool, setTool] = useState<Tool>('pen');
  const [shape, setShape] = useState<ShapeKind>('arrow');
  const [stamp, setStamp] = useState<StampKind>('approved');
  const [color, setColor] = useState(COLORS[0] ?? '#e8262d');
  const [weight, setWeight] = useState(5);
  const [menu, setMenu] = useState<'color' | 'weight' | 'shape' | 'stamp' | null>(null);
  const [draft, setDraft] = useState<SkObject | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [writing, setWriting] = useState<{
    at: SkPoint;
    text: string;
    replaces: number | null;
    /** Where the field lies on screen, and how many screen pixels a picture pixel is. */
    left: number;
    top: number;
    scale: number;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  // A field of the note under this keeps no keyboard up over it.
  useEffect(() => leaveField(), []);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    start: SkPoint;
    points: SkPoint[];
    moving: SkObject | null;
    erased: boolean;
  } | null>(null);

  useEffect(() => {
    let current = true;
    load(bytes, mime)
      .then((result) => {
        if (!current) return;
        setLoaded(result);
        setMarks(marksOf(result.document));
        // Someone who opens a picture that has marks most likely wants to change them.
        if (marksOf(result.document).length) setTool('select');
      })
      .catch(() => current && setFailure('This picture could not be opened for annotating.'));
    return () => {
      current = false;
    };
  }, [bytes, mime]);

  const unit = loaded ? toolScale(loaded.document.frame) : 1;
  const pen = useMemo(() => ({ color, width: weight * 1.6 * unit }), [color, weight, unit]);
  const textSize = (9 + weight * 3) * unit;
  const changed = past.length > 0;

  const measure = useCallback<Measure>((text, font) => {
    const context = canvas.current?.getContext('2d');
    if (!context) return text.length * 8;
    context.save();
    context.font = font;
    const { width } = context.measureText(text);
    context.restore();
    return width;
  }, []);

  /** Replaces the marks and remembers the ones before, for Undo. */
  const commit = useCallback(
    (next: SkObject[]) => {
      setPast((steps) => [...steps, marks]);
      setFuture([]);
      setMarks(next);
    },
    [marks],
  );
  const undo = useCallback(() => {
    const before = past[past.length - 1];
    if (!before) return;
    setPast(past.slice(0, -1));
    setFuture((steps) => [marks, ...steps]);
    setMarks(before);
    setSelected(null);
  }, [marks, past]);
  const redo = useCallback(() => {
    const [after, ...rest] = future;
    if (!after) return;
    setFuture(rest);
    setPast((steps) => [...steps, marks]);
    setMarks(after);
    setSelected(null);
  }, [future, marks]);

  // The picture with its marks, the one being drawn, and the selection.
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context || !loaded) return;
    // A text that is being reworded is shown by the field, not twice.
    const shown = marks.filter((_, index) => index !== writing?.replaces);
    paint(context, loaded, draft ? [...shown, draft] : shown);
    const mark = selected !== null ? marks[selected] : undefined;
    if (mark && tool === 'select') {
      const { frame } = loaded.document;
      const box = boundsOf(mark, measure);
      const pad = 4 * unit;
      context.save();
      context.scale(context.canvas.width / frame.width, context.canvas.height / frame.height);
      context.translate(-frame.x, -frame.y);
      context.setLineDash([6 * unit, 4 * unit]);
      context.lineWidth = 1.5 * unit;
      context.strokeStyle = '#1c7ed6';
      context.strokeRect(box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2);
      context.restore();
    }
  }, [loaded, marks, draft, selected, tool, unit, measure, writing]);

  const commitWriting = useCallback(() => {
    if (!writing) return;
    setWriting(null);
    const text = writing.text.replace(/\s+$/, '');
    if (writing.replaces !== null) {
      const index = writing.replaces;
      const before = marks[index];
      if (!before || textOf(before) === text) return;
      commit(
        text.trim()
          ? marks.map((mark, at) => (at === index ? withText(mark, text) : mark))
          : marks.filter((_, at) => at !== index),
      );
    } else if (text.trim()) {
      commit([...marks, textMark(text, writing.at, textSize, color, crypto.randomUUID())]);
    }
  }, [writing, marks, commit, textSize, color]);

  const removeSelected = useCallback(() => {
    if (selected === null) return;
    const target = marks[selected];
    // A stamp takes its label with it.
    commit(marks.filter((mark, index) => index !== selected && mark.labelParent !== target?.guid));
    setSelected(null);
  }, [selected, marks, commit]);

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const typing = (event.target as HTMLElement | null)?.tagName === 'TEXTAREA';
      const modifier = event.ctrlKey || event.metaKey;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (writing) setWriting(null);
        else if (menu) setMenu(null);
        else if (selected !== null) setSelected(null);
        else if (!changed) onClose();
      } else if (typing) {
        return;
      } else if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (modifier && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selected !== null) {
        event.preventDefault();
        removeSelected();
      }
    };
    window.addEventListener('keydown', keys, true);
    return () => window.removeEventListener('keydown', keys, true);
  }, [writing, menu, selected, changed, onClose, undo, redo, removeSelected]);

  /** Where the pointer is, in the document's own pixels. */
  const locate = (event: { clientX: number; clientY: number }): SkPoint => {
    const element = canvas.current;
    if (!element || !loaded) return { x: 0, y: 0 };
    const box = element.getBoundingClientRect();
    const { frame } = loaded.document;
    return {
      x: frame.x + ((event.clientX - box.left) / box.width) * frame.width,
      y: frame.y + ((event.clientY - box.top) / box.height) * frame.height,
    };
  };
  /** Where a point of the picture lies on screen, and how many screen pixels a picture pixel is. */
  const placeOf = useCallback(
    (at: SkPoint) => {
      const element = canvas.current;
      if (!element || !loaded) return null;
      const box = element.getBoundingClientRect();
      const { frame } = loaded.document;
      const scale = box.width / frame.width;
      return {
        left: box.left + (at.x - frame.x) * scale,
        top: box.top + (at.y - frame.y) * scale,
        scale,
      };
    },
    [loaded],
  );
  /** Opens the field that text is typed into, over the canvas at `at`. */
  const startWriting = (at: SkPoint, initial: string, replaces: number | null) => {
    const place = placeOf(at);
    if (place) setWriting({ at, text: initial, replaces, ...place });
  };
  // The field stays on its place in the picture when the picture moves or
  // changes size under it, as it does when a phone's keyboard opens and
  // leaves the picture less room.
  const isWriting = writing !== null;
  useEffect(() => {
    if (!isWriting) return;
    const follow = () =>
      setWriting((current) => {
        const place = current && placeOf(current.at);
        if (!current || !place) return current;
        const still =
          place.left === current.left && place.top === current.top && place.scale === current.scale;
        return still ? current : { ...current, ...place };
      });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(follow);
    if (stage.current) observer?.observe(stage.current);
    if (canvas.current) observer?.observe(canvas.current);
    window.addEventListener('resize', follow);
    window.visualViewport?.addEventListener('resize', follow);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', follow);
      window.visualViewport?.removeEventListener('resize', follow);
    };
  }, [isWriting, placeOf]);
  /** How far, in the document's pixels, a pointer may miss a mark. */
  const slack = () => {
    const element = canvas.current;
    if (!element || !loaded) return 6;
    return (8 * loaded.document.frame.width) / element.getBoundingClientRect().width;
  };

  const press = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!loaded || event.button !== 0) return;
    setMenu(null);
    if (writing) {
      commitWriting();
      return;
    }
    const at = locate(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { start: at, points: [at], moving: null, erased: false };
    if (tool === 'stamp') {
      gesture.current = null;
      commit([...marks, stampMark(stamp, at, 100 * unit, crypto.randomUUID())]);
    } else if (tool === 'select') {
      const index = markAt(marks, at, slack(), measure);
      setSelected(index >= 0 ? index : null);
      gesture.current.moving = index >= 0 ? (marks[index] ?? null) : null;
    } else if (tool === 'eraser') {
      erase(at);
    } else if (tool === 'pen' || tool === 'highlighter') {
      setDraft(strokeMark([at], pen, tool === 'highlighter', 'draft'));
    }
  };

  const erase = (at: SkPoint) => {
    const index = markAt(marks, at, slack(), measure);
    if (index < 0) return;
    const target = marks[index];
    const kept = marks.filter((mark, place) => place !== index && mark.labelParent !== target?.guid);
    // One stroke of the eraser is one step to undo, however much it removes.
    if (gesture.current?.erased) setMarks(kept);
    else commit(kept);
    if (gesture.current) gesture.current.erased = true;
  };

  const drag = (event: PointerEvent<HTMLCanvasElement>) => {
    const current = gesture.current;
    if (!current || !loaded) return;
    const at = locate(event);
    if (tool === 'pen' || tool === 'highlighter') {
      const last = current.points[current.points.length - 1];
      if (last && Math.hypot(at.x - last.x, at.y - last.y) < unit) return;
      current.points.push(at);
      setDraft(strokeMark(current.points, pen, tool === 'highlighter', 'draft'));
    } else if (tool === 'shape') {
      setDraft(shapeMark(shape, current.start, at, pen, 'draft'));
    } else if (tool === 'eraser') {
      erase(at);
    } else if (tool === 'select' && current.moving && selected !== null) {
      setDraft(null);
      const shifted = moved(current.moving, at.x - current.start.x, at.y - current.start.y);
      setMarks((list) => list.map((mark, index) => (index === selected ? shifted : mark)));
    }
  };

  const release = (event: PointerEvent<HTMLCanvasElement>) => {
    const current = gesture.current;
    gesture.current = null;
    if (!current || !loaded) return;
    const at = locate(event);
    if (tool === 'text') {
      // The field opens when the press ends: a press takes the focus to what
      // was pressed, and would take it from a field opened any earlier.
      startWriting(current.start, '', null);
    } else if (tool === 'pen' || tool === 'highlighter') {
      setDraft(null);
      commit([...marks, strokeMark(current.points, pen, tool === 'highlighter', crypto.randomUUID())]);
    } else if (tool === 'shape') {
      setDraft(null);
      const mark = shapeMark(shape, current.start, at, pen, crypto.randomUUID());
      if (isWorthKeeping(mark)) commit([...marks, mark]);
    } else if (tool === 'select' && current.moving && selected !== null) {
      const distance = Math.hypot(at.x - current.start.x, at.y - current.start.y);
      const original = current.moving;
      if (distance < 1) {
        setMarks((list) => list.map((mark, index) => (index === selected ? original : mark)));
        return;
      }
      // The move was shown while dragging; now it becomes a step to undo.
      const after = marks;
      setPast((steps) => [...steps, after.map((mark, index) => (index === selected ? original : mark))]);
      setFuture([]);
    }
  };

  const reword = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (tool !== 'select') return;
    const index = markAt(marks, locate(event), slack(), measure);
    const mark = marks[index];
    if (!mark || mark.type !== 'Text' || typeof mark.labelParent === 'string') return;
    const box = boundsOf(mark, measure);
    setSelected(null);
    startWriting({ x: box.x, y: box.y }, textOf(mark), index);
  };

  const save = async () => {
    if (!loaded || saving) return;
    setSaving(true);
    try {
      const { frame } = loaded.document;
      const output = window.document.createElement('canvas');
      output.width = Math.max(1, Math.round(frame.width));
      output.height = Math.max(1, Math.round(frame.height));
      const context = output.getContext('2d');
      if (!context) throw new Error('The picture could not be drawn.');
      paint(context, loaded, marks);
      const document = withMarks(loaded.document, marks);
      const [picture, originals] = await Promise.all([canvasPngSoon(output), loaded.originals]);
      await onSave(writeAnnotations(picture, { manifest: document, originals }));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The picture could not be saved.');
      setSaving(false);
    }
  };

  // Going back leaves, and keeps what was marked: it is saved as the button
  // would save it, and the editor closes when that is done. Nothing is
  // asked. A question would have to be answered by Back as well, and one
  // Back more would be out of the note. What is open in here (a menu, a
  // text being written) is closed by Back first, each by itself.
  useBackCloses(true, () => {
    if (saving) return false;
    if (changed) {
      void save();
      return false;
    }
    onClose();
    return undefined;
  });
  useBackCloses(menu !== null, () => setMenu(null));
  useBackCloses(writing !== null, () => setWriting(null));

  const choose = (next: Tool) => {
    commitWriting();
    setTool(next);
    setMenu(null);
    if (next !== 'select') setSelected(null);
  };
  const toolButton = (id: Tool, label: string, icon: ReactNode) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={tool === id}
      onClick={() => choose(id)}
    >
      {icon}
    </button>
  );

  // The field text is typed into lies over the canvas, at the same size.
  let field: ReactNode = null;
  if (writing) {
    const { scale } = writing;
    const editing = writing.replaces !== null ? marks[writing.replaces] : undefined;
    const font = editing && typeof editing.font === 'object' && editing.font !== null ? editing.font : null;
    const size = Number((font as { size?: unknown } | null)?.size) || textSize;
    field = (
      <textarea
        className="annotator-text"
        autoFocus
        aria-label="Text on the picture"
        value={writing.text}
        rows={Math.max(1, writing.text.split('\n').length)}
        style={{
          left: writing.left,
          top: writing.top,
          fontSize: size * scale,
          color,
          minWidth: size * scale * 3,
          width: `${Math.max(3, ...writing.text.split('\n').map((row) => row.length + 2))}ch`,
        }}
        onChange={(event) => {
          const text = event.target.value;
          setWriting((current) => current && { ...current, text });
        }}
        onBlur={commitWriting}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            commitWriting();
          }
        }}
      />
    );
  }

  return createPortal(
    <div className="annotator" role="dialog" aria-modal="true" aria-label={`Annotate ${name}`}>
      <header className="annotator-bar">
        <span className="annotator-name" title={name}>
          {name}
        </span>
        <div className="annotator-tools" role="toolbar" aria-label="Annotation tools">
          <span className="annotator-group">
            <button
              type="button"
              title="Colour"
              aria-label="Colour"
              aria-expanded={menu === 'color'}
              onClick={() => setMenu(menu === 'color' ? null : 'color')}
            >
              <span className="annotator-swatch" style={{ background: color }} />
            </button>
            <button
              type="button"
              title="Thickness and text size"
              aria-label="Thickness and text size"
              aria-expanded={menu === 'weight'}
              onClick={() => setMenu(menu === 'weight' ? null : 'weight')}
            >
              <span className="annotator-weight" style={{ height: Math.max(2, weight * 1.4) }} />
            </button>
          </span>
          <span className="annotator-group">
            {toolButton('pen', 'Pen', <PenLine />)}
            {toolButton('highlighter', 'Highlighter', <Highlighter />)}
            {toolButton('text', 'Text', <Type />)}
            <button
              type="button"
              title={`Stamp: ${STAMPS[stamp].label}`}
              aria-label="Stamp"
              aria-pressed={tool === 'stamp'}
              aria-expanded={menu === 'stamp'}
              onClick={() => {
                choose('stamp');
                setMenu(menu === 'stamp' ? null : 'stamp');
              }}
            >
              <Stamp style={{ color: tool === 'stamp' ? STAMPS[stamp].color : undefined }} />
            </button>
            <button
              type="button"
              title={`Shape: ${SHAPES[shape]}`}
              aria-label="Shape"
              aria-pressed={tool === 'shape'}
              aria-expanded={menu === 'shape'}
              onClick={() => {
                choose('shape');
                setMenu(menu === 'shape' ? null : 'shape');
              }}
            >
              {tool === 'shape' ? SHAPE_ICONS[shape] : <Shapes />}
            </button>
          </span>
          <span className="annotator-group">
            {toolButton('eraser', 'Eraser: removes a mark', <Eraser />)}
            {toolButton('select', 'Select, move, and reword marks', <MousePointer2 />)}
            <button
              type="button"
              title={
                selected === null
                  ? 'Remove the selected mark: choose one with the select tool first'
                  : 'Remove the selected mark'
              }
              aria-label="Remove selected"
              disabled={selected === null}
              onClick={removeSelected}
            >
              <Delete />
            </button>
          </span>
          <span className="annotator-group">
            <button type="button" title="Undo" aria-label="Undo" disabled={!past.length} onClick={undo}>
              <Undo2 />
            </button>
            <button type="button" title="Redo" aria-label="Redo" disabled={!future.length} onClick={redo}>
              <Redo2 />
            </button>
            <button
              type="button"
              title="Remove every mark and show the original picture"
              aria-label="Clear annotations"
              disabled={!marks.length}
              onClick={() => {
                commit([]);
                setSelected(null);
              }}
            >
              <Trash2 />
            </button>
          </span>
          {menu === 'color' && (
            <div className="annotator-menu annotator-colors" role="menu" aria-label="Colour">
              {COLORS.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={value === color}
                  aria-label={value}
                  style={{ background: value }}
                  onClick={() => {
                    setColor(value);
                    setMenu(null);
                  }}
                />
              ))}
            </div>
          )}
          {menu === 'weight' && (
            <div className="annotator-menu annotator-slider" role="menu" aria-label="Thickness and text size">
              <input
                type="range"
                min={1}
                max={10}
                value={weight}
                aria-label="Thickness and text size"
                onChange={(event) => setWeight(Number(event.target.value))}
              />
              <output>{weight}</output>
            </div>
          )}
          {menu === 'stamp' && (
            <div className="annotator-menu annotator-colors" role="menu" aria-label="Stamp">
              {(Object.keys(STAMPS) as StampKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="menuitemradio"
                  aria-checked={kind === stamp}
                  aria-label={STAMPS[kind].label}
                  title={STAMPS[kind].label}
                  style={{ background: STAMPS[kind].color }}
                  onClick={() => {
                    setStamp(kind);
                    setMenu(null);
                  }}
                >
                  {{ approved: '✓', question: '?', rejected: '✕', exclaim: '!', perfect: '♥' }[kind]}
                </button>
              ))}
            </div>
          )}
          {menu === 'shape' && (
            <div className="annotator-menu annotator-list" role="menu" aria-label="Shape">
              {(Object.keys(SHAPES) as ShapeKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="menuitemradio"
                  aria-checked={kind === shape}
                  onClick={() => {
                    setShape(kind);
                    setMenu(null);
                  }}
                >
                  {SHAPE_ICONS[kind]}
                  {SHAPES[kind]}
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="annotator-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={!changed || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </span>
      </header>
      <div className="annotator-stage" ref={stage}>
        {failure && (
          <p className="annotator-note" role="alert">
            {failure}
          </p>
        )}
        {!loaded && !failure && <p className="annotator-note">Opening the picture…</p>}
        {loaded && (
          <canvas
            ref={canvas}
            className={`annotator-canvas tool-${tool}`}
            width={Math.max(1, Math.round(loaded.document.frame.width))}
            height={Math.max(1, Math.round(loaded.document.frame.height))}
            aria-label="Picture to annotate"
            // How many marks there are; a picture's pixels say little else.
            data-marks={marks.length}
            onPointerDown={press}
            onPointerMove={drag}
            onPointerUp={release}
            onPointerCancel={release}
            onDoubleClick={reword}
          />
        )}
        {field}
      </div>
      {loaded && (
        <footer className="annotator-hint">
          {tool === 'select'
            ? marks.length
              ? 'Click a mark to select it, drag to move it, double-click text to reword it. The remove button or Delete takes it away.'
              : 'There are no marks on this picture yet. Choose a tool to add one.'
            : tool === 'eraser'
              ? 'Click or drag over a mark to remove it. The picture underneath is not changed.'
              : tool === 'text'
                ? 'Click where the text should start; Enter finishes it, Shift+Enter starts a new line.'
                : tool === 'stamp'
                  ? 'Click where the stamp should go.'
                  : 'Drag on the picture to draw.'}
        </footer>
      )}
    </div>,
    document.body,
  );
}
