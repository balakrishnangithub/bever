import {
  AlignJustify,
  Ban,
  Delete,
  Eraser,
  Grid2x2,
  Grid3x3,
  Grip,
  Highlighter,
  LocateFixed,
  Maximize,
  Menu,
  Minus,
  MousePointer2,
  PaintBucket,
  PenLine,
  Plus,
  Redo2,
  Shapes,
  Undo2,
  Ellipsis,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useBackCloses } from '../lib/useBackCloses';
import { canvasPngSoon } from './canvasPng';
import { leaveField } from '../lib/windowHeight';

import {
  BACKGROUNDS,
  drawPattern,
  drawStroke,
  freeStroke,
  HIGHLIGHTER_SIZES,
  hitsStroke,
  inkBounds,
  isDark,
  movedStroke,
  newInk,
  parseInk,
  penSizeOf,
  recoloredStroke,
  resizedStroke,
  scaledStroke,
  colorHex,
  PATTERNS,
  PEN_COLORS,
  PEN_SIZES,
  pictureFrame,
  serializeInk,
  snapToShape,
  STROKE,
  strokeBounds,
  strokeInBox,
  type Bounds,
  type InkDocument,
  type InkStroke,
  type Sample,
} from './ink';
import { pngSize, readInk, writeInk } from './pngChunks';

type Tool = 'pen' | 'highlighter' | 'eraser' | 'select';

/** Which part of the canvas is in the window: its top left corner, and the zoom. */
interface View {
  x: number;
  y: number;
  zoom: number;
}

interface Paper {
  background: string;
  pattern: number;
  savePattern: boolean;
}

type Action =
  | { kind: 'draw'; samples: Sample[] }
  | { kind: 'erase'; before: InkStroke[]; changed: boolean }
  | { kind: 'move'; from: { x: number; y: number }; by: { x: number; y: number } }
  // Resizing the selection by one of its corners: the opposite corner stays.
  | { kind: 'scale'; anchor: { x: number; y: number }; from: number; factor: number }
  | { kind: 'box'; from: { x: number; y: number }; to: { x: number; y: number } }
  | { kind: 'pan'; clientX: number; clientY: number; view: View };

interface Props {
  /** The sketch's picture file as it is stored; null for a sketch that is begun here. */
  bytes: Uint8Array | null;
  /** What a sketch begun here is known by inside its file, and when it was begun. */
  blank?: { id: string; at: number };
  name: string;
  /** Stores the finished PNG; the editor closes when it resolves. */
  onSave: (picture: Uint8Array) => Promise<void>;
  onClose: () => void;
}

// The patterns in the order Evernote shows them.
const PATTERN_ORDER = [1, 4, 3, 6, 2, 5];
const PATTERN_ICONS: Record<number, ReactNode> = {
  1: <Grip />,
  4: <Ellipsis />,
  3: <AlignJustify />,
  6: <Menu />,
  2: <Grid3x3 />,
  5: <Grid2x2 />,
};

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
/** The largest side of a picture a sketch is saved as, in pixels. */
const LARGEST_SIDE = 8192;

const two = (value: number) => String(value).padStart(2, '0');

/** The view of a window of `size` that shows all of `strokes`, as large as `most` allows. */
function fitted(strokes: InkStroke[], size: { width: number; height: number }, most: number): View {
  const bounds = inkBounds(strokes) ?? { left: 0, top: 0, right: size.width, bottom: size.height };
  const width = Math.max(1, bounds.right - bounds.left);
  const height = Math.max(1, bounds.bottom - bounds.top);
  const zoom = Math.max(MIN_ZOOM, Math.min(most, (size.width - 48) / width, (size.height - 48) / height));
  return {
    zoom,
    x: bounds.left - (size.width / zoom - width) / 2,
    y: bounds.top - (size.height / zoom - height) / 2,
  };
}

/**
 * Changes a sketch drawn in Evernote, in the full window.
 *
 * A sketch is strokes on a canvas without edges. They are read from the
 * picture file, drawn again here, and can be added to, removed, and moved.
 * What is saved is a new picture of the strokes with the strokes inside it,
 * in the form Evernote reads.
 */
export function SketchEditor({ bytes, blank, name, onSave, onClose }: Props) {
  // A sketch begun here is an empty one, as Evernote writes it.
  const [sketch, setSketch] = useState<InkDocument | null>(() =>
    bytes || !blank ? null : newInk(blank.id, blank.at),
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [strokes, setStrokes] = useState<InkStroke[]>([]);
  const [past, setPast] = useState<InkStroke[][]>([]);
  const [future, setFuture] = useState<InkStroke[][]>([]);
  const [paper, setPaper] = useState<Paper>(() => ({
    background: '#ffffff',
    pattern: bytes || !blank ? 0 : newInk(blank.id, blank.at).pattern,
    savePattern: false,
  }));
  const [tool, setTool] = useState<Tool>('pen');
  const [penColor, setPenColor] = useState(PEN_COLORS[0] ?? '#000000');
  const [penSize, setPenSize] = useState(1);
  const [markerColor, setMarkerColor] = useState('#fae356');
  const [markerSize, setMarkerSize] = useState(2);
  const [snap, setSnap] = useState(false);
  const [menu, setMenu] = useState<'color' | 'size' | 'background' | 'pattern' | null>(null);

  // A field of the note under this keeps no keyboard up over it.
  useEffect(() => leaveField(), []);
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [selection, setSelection] = useState<number[]>([]);
  // While strokes are being dragged they are drawn apart from the rest.
  const [lifted, setLifted] = useState(false);
  const [saving, setSaving] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cache = useRef<HTMLCanvasElement | null>(null);
  const live = useRef<{
    action: Action | null;
    pointers: Map<number, { x: number; y: number }>;
    pinch: { distance: number; x: number; y: number; view: View } | null;
    frame: number;
    paint: () => void;
  }>({ action: null, pointers: new Map(), pinch: null, frame: 0, paint: () => undefined });

  useEffect(() => {
    if (!bytes) return;
    let current = true;
    readInk(bytes)
      .then((ink) => {
        if (!current) return;
        const read = ink ? parseInk(ink.inkml) : null;
        if (!read) {
          setFailure('The strokes of this sketch could not be read.');
          return;
        }
        setSketch(read);
        setStrokes(read.strokes);
        setPaper({ background: read.background, pattern: read.pattern, savePattern: read.savePattern });
        // A sketch opens with all of it in view, and no larger than it was drawn.
        const window = stage.current;
        if (window)
          setView(fitted(read.strokes, { width: window.clientWidth, height: window.clientHeight }, 1));
      })
      .catch(() => current && setFailure('This sketch could not be opened.'));
    return () => {
      current = false;
    };
  }, [bytes]);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const marker = tool === 'highlighter';
  const pen = useMemo(
    () =>
      marker
        ? { color: markerColor, size: HIGHLIGHTER_SIZES[markerSize] ?? 24.4 }
        : { color: penColor, size: PEN_SIZES[penSize] ?? 1.5 },
    [marker, markerColor, markerSize, penColor, penSize],
  );
  const changed =
    past.length > 0 ||
    (sketch !== null &&
      (paper.background !== sketch.background ||
        paper.pattern !== sketch.pattern ||
        paper.savePattern !== sketch.savePattern));
  const drawable = useMemo(() => strokes.some((stroke) => stroke.points.length > 0), [strokes]);

  /** Zooms by `factor`, keeping the place at (`x`, `y`) of the window where it is. */
  const zoomAt = useCallback((factor: number, x: number, y: number) => {
    setView((before) => {
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, before.zoom * factor));
      return { zoom, x: before.x + x / before.zoom - x / zoom, y: before.y + y / before.zoom - y / zoom };
    });
  }, []);
  const zoomBy = (factor: number) => zoomAt(factor, size.width / 2, size.height / 2);

  // The wheel moves the canvas; with Ctrl, or a pinch on a touchpad, it zooms.
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const box = element.getBoundingClientRect();
        zoomAt(Math.exp(-event.deltaY * 0.0025), event.clientX - box.left, event.clientY - box.top);
      } else {
        setView((before) => ({
          ...before,
          x: before.x + event.deltaX / before.zoom,
          y: before.y + event.deltaY / before.zoom,
        }));
      }
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [zoomAt]);

  /** Replaces the strokes and remembers the ones before, for Undo. */
  const commit = useCallback(
    (next: InkStroke[]) => {
      setPast((steps) => [...steps, strokes]);
      setFuture([]);
      setStrokes(next);
    },
    [strokes],
  );
  const undo = useCallback(() => {
    const before = past[past.length - 1];
    if (!before) return;
    setPast(past.slice(0, -1));
    setFuture((steps) => [strokes, ...steps]);
    setStrokes(before);
    setSelection([]);
  }, [strokes, past]);
  const redo = useCallback(() => {
    const [after, ...rest] = future;
    if (!after) return;
    setFuture(rest);
    setPast((steps) => [...steps, strokes]);
    setStrokes(after);
    setSelection([]);
  }, [future, strokes]);

  const removeSelected = useCallback(() => {
    if (!selection.length) return;
    commit(strokes.filter((_, index) => !selection.includes(index)));
    setSelection([]);
  }, [selection, strokes, commit]);

  const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.round(size.width * ratio));
  const pixelHeight = Math.max(1, Math.round(size.height * ratio));

  /** Draws the window: paper, the strokes, and whatever is being done. */
  const paint = useCallback(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const scale = ratio * view.zoom;
    const inSketch = () => context.setTransform(scale, 0, 0, scale, -view.x * scale, -view.y * scale);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = paper.background;
    context.fillRect(0, 0, element.width, element.height);
    inSketch();
    const area = {
      left: view.x,
      top: view.y,
      right: view.x + size.width / view.zoom,
      bottom: view.y + size.height / view.zoom,
    };
    drawPattern(context, paper.pattern, paper.background, area, 1 / scale);
    if (cache.current) {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(cache.current, 0, 0);
      inSketch();
    }
    const { action } = live.current;
    if (action?.kind === 'draw') drawStroke(context, freeStroke(action.samples, pen, marker));
    const by = action?.kind === 'move' ? action.by : { x: 0, y: 0 };
    const resize = action?.kind === 'scale' ? action : null;
    /** Where a point of the selection is while it is being moved or resized. */
    const shown = (x: number, y: number) =>
      resize
        ? {
            x: resize.anchor.x + (x - resize.anchor.x) * resize.factor,
            y: resize.anchor.y + (y - resize.anchor.y) * resize.factor,
          }
        : { x: x + by.x, y: y + by.y };
    const chosen = selection.map((index) => strokes[index]).filter((stroke) => stroke !== undefined);
    if (lifted) {
      context.save();
      if (resize) {
        context.translate(resize.anchor.x, resize.anchor.y);
        context.scale(resize.factor, resize.factor);
        context.translate(-resize.anchor.x, -resize.anchor.y);
      } else {
        context.translate(by.x, by.y);
      }
      for (const stroke of chosen) drawStroke(context, stroke);
      context.restore();
    }
    const outline = (box: Bounds, pad: number) => {
      context.save();
      context.setLineDash([6 / view.zoom, 4 / view.zoom]);
      context.lineWidth = 1.5 / view.zoom;
      context.strokeStyle = isDark(paper.background) ? '#8ab4ff' : '#1c7ed6';
      context.strokeRect(
        box.left - pad,
        box.top - pad,
        box.right - box.left + pad * 2,
        box.bottom - box.top + pad * 2,
      );
      context.restore();
    };
    const bounds = tool === 'select' ? inkBounds(chosen) : null;
    if (bounds) {
      const pad = 5 / view.zoom;
      const first = shown(bounds.left, bounds.top);
      const last = shown(bounds.right, bounds.bottom);
      const box = { left: first.x - pad, top: first.y - pad, right: last.x + pad, bottom: last.y + pad };
      outline(box, 0);
      // A handle at each corner, to resize by.
      const half = 4.5 / view.zoom;
      context.save();
      context.lineWidth = 1.5 / view.zoom;
      context.fillStyle = '#ffffff';
      context.strokeStyle = isDark(paper.background) ? '#8ab4ff' : '#1c7ed6';
      for (const [x, y] of [
        [box.left, box.top],
        [box.right, box.top],
        [box.left, box.bottom],
        [box.right, box.bottom],
      ] as const) {
        context.fillRect(x - half, y - half, half * 2, half * 2);
        context.strokeRect(x - half, y - half, half * 2, half * 2);
      }
      context.restore();
    }
    if (action?.kind === 'box') {
      outline(
        {
          left: Math.min(action.from.x, action.to.x),
          top: Math.min(action.from.y, action.to.y),
          right: Math.max(action.from.x, action.to.x),
          bottom: Math.max(action.from.y, action.to.y),
        },
        0,
      );
    }
  }, [ratio, view, size, paper, pen, marker, selection, strokes, lifted, tool]);

  // The strokes that are at rest are drawn once, and kept, so that a stroke
  // in the making does not cost a redrawing of every other.
  useEffect(() => {
    if (!sketch) return;
    let layer = cache.current;
    if (!layer || layer.width !== pixelWidth || layer.height !== pixelHeight) {
      layer = window.document.createElement('canvas');
      layer.width = pixelWidth;
      layer.height = pixelHeight;
      cache.current = layer;
    }
    const context = layer.getContext('2d');
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, layer.width, layer.height);
    const scale = ratio * view.zoom;
    context.setTransform(scale, 0, 0, scale, -view.x * scale, -view.y * scale);
    const right = view.x + size.width / view.zoom;
    const bottom = view.y + size.height / view.zoom;
    strokes.forEach((stroke, index) => {
      if (lifted && selection.includes(index)) return;
      const bounds = strokeBounds(stroke);
      if (
        !bounds ||
        bounds.right < view.x ||
        bounds.left > right ||
        bounds.bottom < view.y ||
        bounds.top > bottom
      ) {
        return;
      }
      drawStroke(context, stroke);
    });
    live.current.paint = paint;
    paint();
  }, [sketch, strokes, view, size, pixelWidth, pixelHeight, ratio, lifted, selection, paint]);

  const repaint = () => {
    if (live.current.frame) return;
    live.current.frame = window.requestAnimationFrame(() => {
      live.current.frame = 0;
      live.current.paint();
    });
  };
  useEffect(() => {
    const state = live.current;
    return () => window.cancelAnimationFrame(state.frame);
  }, []);

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (menu) setMenu(null);
        else if (selection.length) setSelection([]);
        else if (!changed) onClose();
      } else if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (modifier && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selection.length) {
        event.preventDefault();
        removeSelected();
      }
    };
    window.addEventListener('keydown', keys, true);
    return () => window.removeEventListener('keydown', keys, true);
  }, [menu, selection, changed, onClose, undo, redo, removeSelected]);

  /** Where the pointer is, in the sketch's own pixels. */
  const locate = (event: { clientX: number; clientY: number }) => {
    const box = canvas.current?.getBoundingClientRect();
    return {
      x: view.x + (event.clientX - (box?.left ?? 0)) / view.zoom,
      y: view.y + (event.clientY - (box?.top ?? 0)) / view.zoom,
    };
  };
  const sample = (event: PointerEvent<HTMLCanvasElement> | globalThis.PointerEvent): Sample => ({
    ...locate(event),
    time: event.timeStamp,
    pressure: event.pointerType === 'pen' && event.pressure > 0 ? event.pressure : null,
  });
  /** How far, in the sketch's pixels, a pointer may miss a stroke. */
  const reach = () => 6 / view.zoom;

  const eraseAt = (action: Extract<Action, { kind: 'erase' }>, at: { x: number; y: number }) => {
    if (!strokes.some((stroke) => hitsStroke(stroke, at.x, at.y, reach()))) return;
    action.changed = true;
    setStrokes((list) => list.filter((stroke) => !hitsStroke(stroke, at.x, at.y, reach())));
  };

  const press = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!sketch) return;
    const state = live.current;
    event.currentTarget.setPointerCapture(event.pointerId);
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    setMenu(null);
    if (state.pointers.size === 2) {
      // Two fingers move and zoom the canvas; what one of them began is dropped.
      if (state.action?.kind === 'erase' && state.action.changed) setStrokes(state.action.before);
      state.action = null;
      setLifted(false);
      const [first, second] = [...state.pointers.values()];
      if (first && second) {
        state.pinch = {
          distance: Math.hypot(first.x - second.x, first.y - second.y) || 1,
          x: (first.x + second.x) / 2,
          y: (first.y + second.y) / 2,
          view,
        };
      }
      repaint();
      return;
    }
    if (state.pointers.size > 2) return;
    if (event.button === 1) {
      state.action = { kind: 'pan', clientX: event.clientX, clientY: event.clientY, view };
      return;
    }
    if (event.button !== 0) return;
    const at = locate(event);
    if (tool === 'pen' || tool === 'highlighter') {
      state.action = { kind: 'draw', samples: [sample(event)] };
    } else if (tool === 'eraser') {
      state.action = { kind: 'erase', before: strokes, changed: false };
      eraseAt(state.action, at);
    } else {
      let hit = -1;
      for (let index = strokes.length - 1; index >= 0 && hit < 0; index -= 1) {
        const stroke = strokes[index];
        if (stroke && hitsStroke(stroke, at.x, at.y, reach())) hit = index;
      }
      const bounds = inkBounds(
        selection.map((index) => strokes[index]).filter((stroke) => stroke !== undefined),
      );
      const pad = 5 / view.zoom;
      const within =
        bounds !== null &&
        at.x >= bounds.left - pad &&
        at.x <= bounds.right + pad &&
        at.y >= bounds.top - pad &&
        at.y <= bounds.bottom + pad;
      // A corner of the selection resizes it; the opposite corner stays put.
      const corner =
        bounds === null
          ? null
          : (
              [
                [bounds.left - pad, bounds.top - pad, bounds.right, bounds.bottom],
                [bounds.right + pad, bounds.top - pad, bounds.left, bounds.bottom],
                [bounds.left - pad, bounds.bottom + pad, bounds.right, bounds.top],
                [bounds.right + pad, bounds.bottom + pad, bounds.left, bounds.top],
              ] as const
            ).find(([x, y]) => Math.hypot(at.x - x, at.y - y) <= 11 / view.zoom);
      if (corner) {
        const [x, y, anchorX, anchorY] = corner;
        state.action = {
          kind: 'scale',
          anchor: { x: anchorX, y: anchorY },
          from: Math.hypot(x - anchorX, y - anchorY) || 1,
          factor: 1,
        };
        setLifted(true);
      } else if (hit >= 0 && !selection.includes(hit)) {
        setSelection(event.shiftKey ? [...selection, hit] : [hit]);
        state.action = { kind: 'move', from: at, by: { x: 0, y: 0 } };
        setLifted(true);
      } else if (hit >= 0 || within) {
        state.action = { kind: 'move', from: at, by: { x: 0, y: 0 } };
        setLifted(true);
      } else {
        if (!event.shiftKey) setSelection([]);
        state.action = { kind: 'box', from: at, to: at };
      }
    }
    repaint();
  };

  const drag = (event: PointerEvent<HTMLCanvasElement>) => {
    const state = live.current;
    if (state.pointers.has(event.pointerId)) {
      state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (state.pinch && state.pointers.size >= 2) {
      const [first, second] = [...state.pointers.values()];
      const box = canvas.current?.getBoundingClientRect();
      if (!first || !second || !box) return;
      const { pinch } = state;
      const zoom = Math.max(
        MIN_ZOOM,
        Math.min(
          MAX_ZOOM,
          (pinch.view.zoom * Math.hypot(first.x - second.x, first.y - second.y)) / pinch.distance,
        ),
      );
      // The place that was between the fingers stays between them.
      const anchorX = pinch.view.x + (pinch.x - box.left) / pinch.view.zoom;
      const anchorY = pinch.view.y + (pinch.y - box.top) / pinch.view.zoom;
      setView({
        zoom,
        x: anchorX - ((first.x + second.x) / 2 - box.left) / zoom,
        y: anchorY - ((first.y + second.y) / 2 - box.top) / zoom,
      });
      return;
    }
    const { action } = state;
    if (!action) return;
    const at = locate(event);
    if (action.kind === 'draw') {
      // Every place the pointer was since the last event, not only the latest.
      const events = event.nativeEvent.getCoalescedEvents?.() ?? [];
      if (events.length) for (const each of events) action.samples.push(sample(each));
      else action.samples.push(sample(event));
    } else if (action.kind === 'erase') {
      eraseAt(action, at);
    } else if (action.kind === 'move') {
      action.by = { x: at.x - action.from.x, y: at.y - action.from.y };
    } else if (action.kind === 'scale') {
      const distance = Math.hypot(at.x - action.anchor.x, at.y - action.anchor.y);
      action.factor = Math.max(0.05, Math.min(20, distance / action.from));
    } else if (action.kind === 'box') {
      action.to = at;
    } else {
      setView({
        ...action.view,
        x: action.view.x - (event.clientX - action.clientX) / action.view.zoom,
        y: action.view.y - (event.clientY - action.clientY) / action.view.zoom,
      });
    }
    repaint();
  };

  const release = (event: PointerEvent<HTMLCanvasElement>) => {
    const state = live.current;
    state.pointers.delete(event.pointerId);
    if (state.pinch) {
      if (state.pointers.size < 2) state.pinch = null;
      return;
    }
    const { action } = state;
    state.action = null;
    if (!action) return;
    if (action.kind === 'draw') {
      const drawn = freeStroke(action.samples, pen, marker);
      commit([...strokes, snap && !marker ? snapToShape(drawn) : drawn]);
    } else if (action.kind === 'erase') {
      if (action.changed) {
        // One pass of the eraser is one step to undo, however much it removed.
        const { before } = action;
        setPast((steps) => [...steps, before]);
        setFuture([]);
      }
    } else if (action.kind === 'move') {
      setLifted(false);
      const { by } = action;
      if (Math.hypot(by.x, by.y) * view.zoom >= 1) {
        commit(
          strokes.map((stroke, index) =>
            selection.includes(index) ? movedStroke(stroke, by.x, by.y) : stroke,
          ),
        );
      }
    } else if (action.kind === 'scale') {
      setLifted(false);
      const { anchor, factor } = action;
      if (Math.abs(factor - 1) > 0.005) {
        commit(
          strokes.map((stroke, index) =>
            selection.includes(index) ? scaledStroke(stroke, anchor.x, anchor.y, factor) : stroke,
          ),
        );
      }
    } else if (action.kind === 'box') {
      const box = {
        left: Math.min(action.from.x, action.to.x),
        top: Math.min(action.from.y, action.to.y),
        right: Math.max(action.from.x, action.to.x),
        bottom: Math.max(action.from.y, action.to.y),
      };
      const inside = strokes.flatMap((stroke, index) => (strokeInBox(stroke, box) ? [index] : []));
      setSelection(event.shiftKey ? [...new Set([...selection, ...inside])] : inside);
    }
    repaint();
  };

  const save = async () => {
    if (!sketch || saving) return;
    setSaving(true);
    try {
      const frame = pictureFrame(strokes);
      if (!frame) throw new Error('There is nothing drawn to save.');
      const width = frame.right - frame.left;
      const height = frame.bottom - frame.top;
      if (width > LARGEST_SIDE || height > LARGEST_SIDE) {
        throw new Error(
          'The strokes lie too far apart to be saved as one picture. Move them closer together or remove some.',
        );
      }
      const output = window.document.createElement('canvas');
      output.width = width;
      output.height = height;
      const context = output.getContext('2d');
      if (!context) throw new Error('The picture could not be drawn.');
      context.fillStyle = paper.background;
      context.fillRect(0, 0, width, height);
      context.translate(-frame.left, -frame.top);
      if (paper.savePattern) drawPattern(context, paper.pattern, paper.background, frame);
      for (const stroke of strokes) drawStroke(context, stroke);
      // The size in the sketch is the picture's, where it was before. A
      // sketch from a phone names its page there instead, and keeps it.
      const before = bytes ? pngSize(bytes) : null;
      const follows =
        !before || !sketch.width || (before.width === sketch.width && before.height === sketch.height);
      const saved = {
        ...sketch,
        ...paper,
        strokes,
        width: follows ? width : sketch.width,
        height: follows ? height : sketch.height,
      };
      await onSave(
        await writeInk(await canvasPngSoon(output), {
          name: sketch.name,
          inkml: serializeInk(saved),
          width: saved.width,
          height: saved.height,
        }),
      );
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The sketch could not be saved.');
      setSaving(false);
    }
  };

  // Going back leaves, and keeps what was drawn: it is saved as the button
  // would save it, and the editor closes when that is done. Nothing is
  // asked. A question would have to be answered by Back as well, and one
  // Back more would be out of the note. What is open in here (a menu, a
  // text being written) is closed by Back first, each by itself.
  useBackCloses(true, () => {
    if (saving) return false;
    if (changed && drawable) {
      void save();
      return false;
    }
    onClose();
    return undefined;
  });
  useBackCloses(menu !== null, () => setMenu(null));

  const choose = (next: Tool) => {
    setTool(next);
    setMenu(null);
    if (next !== 'select') setSelection([]);
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
  const last = strokes[strokes.length - 1];
  const kind = (stroke: InkStroke | undefined) =>
    stroke ? (Object.entries(STROKE).find(([, type]) => type === stroke.type)?.[0] ?? 'pen') : '';
  // With strokes selected, the colour and the size are theirs, and choosing
  // another changes them.
  const selected =
    tool === 'select'
      ? selection.map((index) => strokes[index]).filter((stroke) => stroke !== undefined)
      : [];
  const [firstSelected] = selected;
  const markers = firstSelected ? selected.every((stroke) => stroke.type === STROKE.highlighter) : marker;
  const colors = PEN_COLORS;
  const sizes = markers ? HIGHLIGHTER_SIZES : PEN_SIZES;
  const nearest = (list: number[], value: number) =>
    list.reduce(
      (best, size, index) => (Math.abs(size - value) < Math.abs((list[best] ?? 0) - value) ? index : best),
      0,
    );
  const sizeIndex = firstSelected ? nearest(sizes, penSizeOf(firstSelected)) : marker ? markerSize : penSize;
  const shownColor = firstSelected ? colorHex(firstSelected.color) : pen.color;
  const selectionBounds = inkBounds(selected);

  return createPortal(
    <div className="annotator sketch" role="dialog" aria-modal="true" aria-label={`Sketch ${name}`}>
      <header className="annotator-bar">
        <div className="annotator-tools" role="toolbar" aria-label="Sketch view and paper">
          <span className="annotator-group sketch-zoom">
            <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}>
              <Minus />
            </button>
            <output aria-label="Zoom">{Math.round(view.zoom * 100)}%</output>
            <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
              <Plus />
            </button>
          </span>
          <span className="annotator-group">
            <button type="button" title="Undo" aria-label="Undo" disabled={!past.length} onClick={undo}>
              <Undo2 />
            </button>
            <button type="button" title="Redo" aria-label="Redo" disabled={!future.length} onClick={redo}>
              <Redo2 />
            </button>
          </span>
          <span className="annotator-group">
            <button
              type="button"
              title="Snap to shape: a line, rectangle, triangle, or ellipse drawn by hand is made exact"
              aria-label="Snap to shape"
              aria-pressed={snap}
              onClick={() => setSnap(!snap)}
            >
              <Shapes />
            </button>
            <button
              type="button"
              title="Reset zoom"
              aria-label="Reset zoom"
              onClick={() => setView(centred(view, size, 1))}
            >
              <LocateFixed />
            </button>
            <button
              type="button"
              title="Fit to window"
              aria-label="Fit to window"
              onClick={() => setView(fitted(strokes, size, 4))}
            >
              <Maximize />
            </button>
            <button
              type="button"
              title="Background colour"
              aria-label="Background colour"
              aria-expanded={menu === 'background'}
              onClick={() => setMenu(menu === 'background' ? null : 'background')}
            >
              <PaintBucket />
            </button>
            <button
              type="button"
              title="Background pattern"
              aria-label="Background pattern"
              aria-expanded={menu === 'pattern'}
              onClick={() => setMenu(menu === 'pattern' ? null : 'pattern')}
            >
              <AlignJustify />
            </button>
          </span>
          {menu === 'background' && (
            <div className="annotator-menu annotator-colors" role="menu" aria-label="Background colour">
              {BACKGROUNDS.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={value === paper.background}
                  aria-label={value}
                  style={{ background: value }}
                  onClick={() => {
                    setPaper({ ...paper, background: value });
                    setMenu(null);
                  }}
                />
              ))}
            </div>
          )}
          {menu === 'pattern' && (
            <div className="annotator-menu sketch-patterns" role="menu" aria-label="Background pattern">
              <div>
                {PATTERN_ORDER.map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={value === paper.pattern}
                    aria-label={PATTERNS[value]?.label}
                    title={PATTERNS[value]?.label}
                    onClick={() => setPaper({ ...paper, pattern: value })}
                  >
                    {PATTERN_ICONS[value]}
                  </button>
                ))}
              </div>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!PATTERN_ORDER.includes(paper.pattern)}
                className="sketch-pattern-none"
                onClick={() => setPaper({ ...paper, pattern: 0 })}
              >
                <Ban />
                None
              </button>
              <label>
                <input
                  type="checkbox"
                  checked={paper.savePattern}
                  onChange={(event) => setPaper({ ...paper, savePattern: event.target.checked })}
                />
                Save sketch with pattern
              </label>
            </div>
          )}
        </div>
        <span className="annotator-name" title={name}>
          {name}
        </span>
        <span className="annotator-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!changed || !drawable || saving}
            title={drawable ? undefined : 'A sketch with nothing drawn cannot be saved'}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Done'}
          </button>
        </span>
      </header>
      <div className="sketch-body">
        <div className="sketch-rail" role="toolbar" aria-label="Sketch tools" aria-orientation="vertical">
          {toolButton('pen', 'Pen', <PenLine />)}
          {toolButton('highlighter', 'Highlighter', <Highlighter />)}
          {toolButton('eraser', 'Eraser: removes a stroke', <Eraser />)}
          {toolButton('select', 'Select and move strokes', <MousePointer2 />)}
          {tool === 'select' && (
            <button
              type="button"
              title={
                selection.length
                  ? 'Remove the selected strokes'
                  : 'Remove the selected strokes: choose some first'
              }
              aria-label="Remove selected"
              disabled={!selection.length}
              onClick={removeSelected}
            >
              <Delete />
            </button>
          )}
          <span className="sketch-rail-rule" />
          <button
            type="button"
            title="Colour"
            aria-label="Colour"
            aria-expanded={menu === 'color'}
            onClick={() => setMenu(menu === 'color' ? null : 'color')}
          >
            <span className="annotator-swatch" style={{ background: shownColor }} />
          </button>
          <button
            type="button"
            className="sketch-size"
            title={selected.length ? 'Size of the selected strokes' : 'Pen size'}
            aria-label="Pen size"
            aria-expanded={menu === 'size'}
            onClick={() => setMenu(menu === 'size' ? null : 'size')}
          >
            {two(sizeIndex + 1)}
          </button>
          {menu === 'color' && (
            <div className="annotator-menu annotator-colors sketch-rail-menu" role="menu" aria-label="Colour">
              {colors.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={value === shownColor}
                  aria-label={value}
                  style={{ background: value }}
                  onClick={() => {
                    if (selected.length) {
                      commit(
                        strokes.map((stroke, index) =>
                          selection.includes(index) ? recoloredStroke(stroke, value) : stroke,
                        ),
                      );
                    } else if (marker) setMarkerColor(value);
                    else setPenColor(value);
                    setMenu(null);
                  }}
                />
              ))}
            </div>
          )}
          {menu === 'size' && (
            <div className="annotator-menu sketch-sizes sketch-rail-menu" role="menu" aria-label="Pen size">
              {sizes.map((value, index) => (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={index === sizeIndex}
                  aria-label={`Size ${two(index + 1)}`}
                  onClick={() => {
                    if (selected.length) {
                      // Each stroke takes the size of this number for its kind of pen.
                      commit(
                        strokes.map((stroke, at) => {
                          if (!selection.includes(at)) return stroke;
                          const list = stroke.type === STROKE.highlighter ? HIGHLIGHTER_SIZES : PEN_SIZES;
                          return resizedStroke(stroke, list[Math.min(index, list.length - 1)] ?? value);
                        }),
                      );
                    } else if (marker) setMarkerSize(index);
                    else setPenSize(index);
                    setMenu(null);
                  }}
                >
                  <span style={{ height: Math.max(1, Math.min(22, value)), background: shownColor }} />
                  {two(index + 1)}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="sketch-stage" ref={stage}>
          {failure && (
            <p className="annotator-note" role="alert">
              {failure}
            </p>
          )}
          {!sketch && !failure && <p className="annotator-note">Opening the sketch…</p>}
          {sketch && (
            <canvas
              ref={canvas}
              className={`sketch-canvas tool-${tool}`}
              width={pixelWidth}
              height={pixelHeight}
              aria-label="Sketch"
              // What a test, or anything else that cannot see, can know of the drawing.
              data-strokes={strokes.length}
              data-last={kind(last)}
              data-selected={selection.length}
              data-selected-ink={firstSelected ? `${shownColor},${sizeIndex}` : ''}
              data-selection={
                selectionBounds
                  ? [selectionBounds.left, selectionBounds.top, selectionBounds.right, selectionBounds.bottom]
                      .map((value) => Math.round(value))
                      .join(',')
                  : ''
              }
              data-view={`${view.x},${view.y},${view.zoom}`}
              data-paper={`${paper.background},${paper.pattern},${paper.savePattern}`}
              onPointerDown={press}
              onPointerMove={drag}
              onPointerUp={release}
              onPointerCancel={release}
            />
          )}
        </div>
      </div>
      {sketch && (
        <footer className="annotator-hint">
          {tool === 'select'
            ? selection.length
              ? 'Drag the selection to move it, a corner to resize it. A colour or size chosen now changes it; Delete removes it.'
              : 'Click a stroke, or drag a box around strokes, to select them.'
            : tool === 'eraser'
              ? 'Click or drag over a stroke to remove it.'
              : snap && tool === 'pen'
                ? 'Draw a line, rectangle, triangle, or ellipse by hand: it is made exact when you let go.'
                : 'Drag to draw. The wheel moves the canvas, Ctrl+wheel or two fingers zoom.'}
        </footer>
      )}
    </div>,
    document.body,
  );
}

/** The view at `zoom` that keeps the middle of the window where it is. */
function centred(view: View, size: { width: number; height: number }, zoom: number): View {
  return {
    zoom,
    x: view.x + size.width / 2 / view.zoom - size.width / 2 / zoom,
    y: view.y + size.height / 2 / view.zoom - size.height / 2 / zoom,
  };
}
