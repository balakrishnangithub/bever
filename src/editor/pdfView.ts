import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';

import {
  clampZoom,
  CLOSE_ZOOM,
  covers,
  fitWidth,
  pageAt,
  partInView,
  pinchedZoom,
  restingZoom,
  scaled,
  wholeScale,
  type Box,
} from './pdfGeometry';

/** Room left on either side of a page that fits the width, in pixels. */
const MARGIN = 16;
/**
 * Most pixels the drawing of a whole page has. Each pixel is four bytes of
 * memory, and a few pages are drawn at a time: a phone is given 16 MB for a
 * page. A computer has more, and a denser, larger screen to fill: 36 MB,
 * which is a page as wide as its view, as sharp as that screen shows it.
 */
const WHOLE_PIXELS_BY_FINGER = 4_000_000;
const WHOLE_PIXELS = 9_000_000;
/** Longest side of a drawing; some phones draw nothing longer. */
const LONGEST_SIDE = 4096;
/** Most pixels the drawing of the part in view has. */
const PART_PIXELS = 8_000_000;
/** Pages this many views above and under the view are drawn before they are reached. */
const AHEAD = 1;
/** Pages further than this many views from the view give their drawings back. */
const KEPT = 3;
/** How much of the view is drawn around the part in view, on every side. */
const AROUND = 0.25;
/** How long the pages stay as they are before they count as at rest, in milliseconds. */
const REST_MS = 140;
/** Two taps this close in time and place are a double tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_REACH = 30;
/** A touch that moved further than this was not a tap; a mouse held down, a drag. */
const STILL = 10;
const DRAG_FROM = 4;
/** Pixels of the screen to a pixel of the page that are still drawn for. */
const DENSEST = 3;

type Point = { x: number; y: number };

interface Sheet {
  /** Counted from one, as a PDF counts its pages. */
  number: number;
  box: HTMLDivElement;
  /** In points; those of the first page until its own are known. */
  width: number;
  height: number;
  page: PDFPageProxy | null;
  /** The whole page, drawn at `scale`. */
  whole: { canvas: HTMLCanvasElement; scale: number } | null;
  /** The part of it in view, drawn finer than the whole could be: `area` in points. */
  part: { canvas: HTMLCanvasElement; scale: number; area: Box } | null;
  failed: boolean;
}

interface Job {
  sheet: Sheet;
  scale: number;
  /** The part to draw, in points; the whole page when there is none. */
  area: Box | null;
}

/** A place in the document: a page, and how far across and down it. */
interface Anchor {
  sheet: Sheet;
  across: number;
  down: number;
}

export interface PdfViewEvents {
  /** The page in view changed. */
  onPage: (page: number) => void;
  /** The pages were made larger or smaller. */
  onZoom: (zoom: number) => void;
  /** The first drawing is there to see. */
  onShown: () => void;
  /** Nothing could be drawn. */
  onFailed: () => void;
}

/**
 * Shows a PDF as its pages one under another, to scroll through, and makes
 * them larger and smaller: by two fingers, by Ctrl with the wheel (which is
 * also what a touchpad sends for two fingers), by a double tap or click,
 * and by the buttons. What is under the fingers, or under the pointer,
 * stays there while the size changes.
 *
 * A PDF is drawings and letters, not pixels, so a page made larger is drawn
 * again at its new size and is as sharp as before. While fingers are still
 * moving, the drawing there is stretched; once they rest, it is replaced. A
 * page drawn whole at eight times its size would be more than a phone has
 * memory for, so past a certain size the whole page is left as it is and
 * only the part in view is drawn over it, at the full size.
 *
 * Only the pages in view and near it are drawn, one at a time, and those
 * left far behind give their drawings back: a document of hundreds of pages
 * costs what a few of them do.
 */
export class PdfView {
  private sheets: Sheet[] = [];
  /** The pages that have a drawing. */
  private readonly drawn = new Set<Sheet>();
  /** How wide a page is shown when it fits the width of the view, in pixels. */
  private fit = 1;
  private zoom = 1;
  private closed = false;
  private shown = false;
  private pageShown = 0;

  private drawing = false;
  private task: RenderTask | null = null;
  /** The size is being changed: nothing is drawn until it rests. */
  private zooming = false;
  /** Nothing has moved for a moment: the part in view is worth drawing. */
  private resting = true;
  private restTimer = 0;
  private frame = 0;

  private pinch: { distance: number; zoom: number; anchor: Anchor } | null = null;
  private pinchWanted: { zoom: number; at: Point } | null = null;
  private pinchFrame = 0;
  private touch: { at: Point; time: number; moved: boolean; many: boolean } | null = null;
  private lastTap: { at: Point; time: number } | null = null;
  private lastTouch = 0;
  private drag: { pointer: number; at: Point; going: boolean } | null = null;
  private readonly wholePixels = window.matchMedia('(pointer: coarse)').matches
    ? WHOLE_PIXELS_BY_FINGER
    : WHOLE_PIXELS;
  private readonly observer: ResizeObserver;
  private readonly listeners: (() => void)[] = [];

  constructor(
    private readonly scroller: HTMLElement,
    private readonly pages: HTMLElement,
    private readonly pdf: PDFDocumentProxy,
    private readonly events: PdfViewEvents,
  ) {
    this.observer = new ResizeObserver(() => this.resized());
  }

  /** Lays the pages out and begins to draw them. */
  async open(): Promise<void> {
    const first = await this.pdf.getPage(1);
    if (this.closed) return;
    const size = first.getViewport({ scale: 1 });
    this.fit = fitWidth(this.scroller.clientWidth, size.width, MARGIN);
    this.applyScale();
    const boxes = document.createDocumentFragment();
    for (let number = 1; number <= this.pdf.numPages; number += 1) {
      const box = document.createElement('div');
      box.className = 'pdf-sheet';
      box.dataset.page = String(number);
      box.setAttribute('role', 'img');
      box.setAttribute('aria-label', `Page ${number}`);
      const sheet: Sheet = {
        number,
        box,
        width: size.width,
        height: size.height,
        page: number === 1 ? first : null,
        whole: null,
        part: null,
        failed: false,
      };
      this.size(sheet, size.width, size.height);
      this.sheets.push(sheet);
      boxes.append(box);
    }
    this.pages.replaceChildren(boxes);
    this.listen();
    this.observer.observe(this.scroller);
    this.events.onZoom(this.zoom);
    this.tellPage();
    this.draw();
    void this.measure();
  }

  /** Stops everything and gives back what was drawn. */
  close(): void {
    this.closed = true;
    this.task?.cancel();
    this.observer.disconnect();
    for (const stop of this.listeners) stop();
    window.clearTimeout(this.restTimer);
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.pinchFrame);
    for (const sheet of this.sheets) this.letGo(sheet);
    this.scroller.classList.remove('pinching', 'dragging');
  }

  /** Makes the pages `factor` times the size they are, about the middle of the view. */
  zoomBy(factor: number): void {
    this.zoomTo(this.zoom * factor);
  }

  /** Shows the pages at `zoom` times the width of the view, about `at` or the middle. */
  zoomTo(zoom: number, at?: Point): void {
    const view = this.scroller.getBoundingClientRect();
    const about = at ?? { x: view.left + view.width / 2, y: view.top + view.height / 2 };
    this.show(restingZoom(clampZoom(zoom)), this.anchorAt(about), about);
  }

  /** Brings a page, counted from one, to the top of the view. */
  goToPage(number: number): void {
    const sheet = this.sheets[Math.min(this.sheets.length, Math.max(1, Math.round(number))) - 1];
    if (sheet) this.scroller.scrollTop = Math.max(0, sheet.box.offsetTop - 8);
  }

  // ── Where things are ────────────────────────────────────────────────

  private applyScale(): void {
    this.pages.style.setProperty('--pdf-width', `${this.fit * this.zoom}px`);
  }

  private size(sheet: Sheet, width: number, height: number): void {
    sheet.width = width;
    sheet.height = height;
    sheet.box.style.setProperty('--pdf-shape', String(height / Math.max(1, width)));
  }

  /** The page at a height on the screen: the last that begins at or above it. */
  private sheetAt(y: number): Sheet | undefined {
    const within = y - this.pages.getBoundingClientRect().top;
    return this.sheets[pageAt(this.sheets.length, (index) => this.sheets[index]?.box.offsetTop ?? 0, within)];
  }

  /** The place in the document that is at a point of the screen. */
  private anchorAt(at: Point): Anchor | null {
    const sheet = this.sheetAt(at.y);
    if (!sheet) return null;
    const box = sheet.box.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    return { sheet, across: (at.x - box.left) / box.width, down: (at.y - box.top) / box.height };
  }

  /** Shows the pages at `zoom`, with the place `anchor` at the point `at` of the screen. */
  private show(zoom: number, anchor: Anchor | null, at: Point): void {
    if (zoom !== this.zoom) {
      this.zoom = zoom;
      // What is being drawn is for a size that is no longer wanted.
      this.task?.cancel();
      this.zooming = true;
      this.applyScale();
      this.events.onZoom(zoom);
    }
    if (anchor) {
      // Where the place has come to be, now that everything has its new size.
      const box = anchor.sheet.box.getBoundingClientRect();
      this.scroller.scrollLeft += box.left + anchor.across * box.width - at.x;
      this.scroller.scrollTop += box.top + anchor.down * box.height - at.y;
    }
    this.moved();
  }

  /** The view has another size: the pages fit its width again, at the same place. */
  private resized(): void {
    if (this.closed || !this.sheets[0]) return;
    const fit = fitWidth(this.scroller.clientWidth, this.sheets[0].width, MARGIN);
    if (Math.abs(fit - this.fit) < 0.5) {
      this.moved();
      return;
    }
    const view = this.scroller.getBoundingClientRect();
    const top = { x: view.left + view.width / 2, y: view.top };
    const anchor = this.anchorAt(top);
    this.fit = fit;
    this.task?.cancel();
    this.zooming = true;
    this.applyScale();
    this.show(this.zoom, anchor, { x: view.left + this.scroller.clientWidth / 2, y: view.top });
  }

  /** Something moved or changed size: the page in view is told, and drawing follows. */
  private moved(): void {
    this.resting = false;
    window.clearTimeout(this.restTimer);
    this.restTimer = window.setTimeout(() => {
      this.zooming = false;
      this.resting = true;
      this.draw();
    }, REST_MS);
    this.frame ||= requestAnimationFrame(() => {
      this.frame = 0;
      if (this.closed) return;
      this.tellPage();
      this.draw();
    });
  }

  private tellPage(): void {
    const view = this.scroller.getBoundingClientRect();
    const { scrollTop, scrollHeight, clientHeight } = this.scroller;
    // A short page at either end is never in the middle of the view.
    const sheet =
      scrollTop <= 1
        ? this.sheets[0]
        : scrollTop + clientHeight >= scrollHeight - 1
          ? this.sheets.at(-1)
          : this.sheetAt(view.top + view.height / 2);
    if (sheet && sheet.number !== this.pageShown) {
      this.pageShown = sheet.number;
      this.events.onPage(sheet.number);
    }
  }

  /** Learns the size of every page; until then each has that of the first. */
  private async measure(): Promise<void> {
    for (const sheet of this.sheets.slice(1)) {
      if (this.closed) return;
      try {
        sheet.page ??= await this.pdf.getPage(sheet.number);
      } catch {
        continue;
      }
      const size = sheet.page.getViewport({ scale: 1 });
      if (Math.abs(size.width - sheet.width) > 0.01 || Math.abs(size.height - sheet.height) > 0.01) {
        this.size(sheet, size.width, size.height);
        this.moved();
      }
    }
  }

  // ── Drawing ─────────────────────────────────────────────────────────

  /** Draws what is wanted and not there, one drawing at a time, until nothing is. */
  private draw(): void {
    if (this.drawing || this.closed) return;
    this.drawing = true;
    void (async () => {
      try {
        for (let job = this.nextJob(); job && !this.closed; job = this.nextJob()) {
          try {
            await this.drawJob(job);
          } catch (reason) {
            if (this.closed) return;
            // A drawing given up for another is not one that failed.
            if ((reason as { name?: string } | null)?.name === 'RenderingCancelledException') continue;
            job.sheet.failed = true;
            job.sheet.box.classList.add('failed');
            // The page the document opens at: with it, nothing is there to see.
            if (!this.shown && job.sheet.number === 1) this.events.onFailed();
          }
        }
      } finally {
        this.drawing = false;
      }
    })();
  }

  /** The drawing most wanted now, or none. Also lets go of what is far from view. */
  private nextJob(): Job | null {
    if (this.zooming || this.sheets.length === 0) return null;
    const bounds = this.scroller.getBoundingClientRect();
    const view: Box = { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height };
    if (view.width <= 0 || view.height <= 0) return null;
    const middle = view.y + view.height / 2;
    const dense = Math.min(window.devicePixelRatio || 1, DENSEST);
    /**
     * The pixels of the screen a point of a page is shown with. Every page is
     * as wide as every other, so a page on its side has fewer than an upright one.
     */
    const shownOf = (sheet: Sheet) => (this.fit * this.zoom) / Math.max(1, sheet.width);

    const boxOf = (sheet: Sheet): Box => {
      const box = sheet.box.getBoundingClientRect();
      return { x: box.left, y: box.top, width: box.width, height: box.height };
    };
    /** How far a page is from the view, in views; nought when it is in it. */
    const away = (box: Box) =>
      Math.max(0, box.y - (view.y + view.height), view.y - (box.y + box.height)) / view.height;

    for (const sheet of [...this.drawn]) {
      if (away(boxOf(sheet)) > KEPT) this.letGo(sheet);
    }
    // The pages in view and a view's height above and under it: from the
    // first that reaches so far down, to the last that begins so far up.
    const near: { sheet: Sheet; box: Box }[] = [];
    const from = this.sheetAt(view.y - view.height * AHEAD);
    for (const sheet of this.sheets.slice((from?.number ?? 1) - 1)) {
      const box = boxOf(sheet);
      if (box.y > view.y + view.height * (1 + AHEAD)) break;
      if (away(box) <= AHEAD && !sheet.failed) near.push({ sheet, box });
    }
    // The page in the middle of the view first, then those around it.
    near.sort(
      (a, b) => Math.abs(a.box.y + a.box.height / 2 - middle) - Math.abs(b.box.y + b.box.height / 2 - middle),
    );

    for (const { sheet } of near) {
      const full = shownOf(sheet) * dense;
      const scale = wholeScale(sheet.width, sheet.height, full, this.wholePixels, LONGEST_SIDE);
      if (!sheet.whole || Math.abs(sheet.whole.scale / scale - 1) > 0.02) {
        return { sheet, scale, area: null };
      }
    }
    if (!this.resting) return null;
    for (const { sheet, box } of near) {
      const shown = shownOf(sheet);
      const full = shown * dense;
      const seen = partInView(box, view, 0);
      const whole = wholeScale(sheet.width, sheet.height, full, this.wholePixels, LONGEST_SIDE);
      // Out of view, or drawn whole as finely as the screen shows it.
      if (!seen || full <= whole * 1.02) {
        this.dropPart(sheet);
        continue;
      }
      if (
        sheet.part &&
        Math.abs(sheet.part.scale / full - 1) <= 0.02 &&
        covers(sheet.part.area, scaled(seen, 1 / shown), 1)
      ) {
        continue;
      }
      let area = scaled(partInView(box, view, AROUND) ?? seen, 1 / shown);
      // More than a drawing may have: then only what is in view.
      if (area.width * area.height * full * full > PART_PIXELS) area = scaled(seen, 1 / shown);
      return { sheet, scale: full, area };
    }
    return null;
  }

  private async drawJob({ sheet, scale, area }: Job): Promise<void> {
    sheet.page ??= await this.pdf.getPage(sheet.number);
    if (this.closed) return;
    const viewport = sheet.page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    // In pixels of the drawing, from the corner of the page.
    const left = area ? Math.floor(area.x * scale) : 0;
    const top = area ? Math.floor(area.y * scale) : 0;
    const right = area ? Math.ceil((area.x + area.width) * scale) : Math.round(viewport.width);
    const bottom = area ? Math.ceil((area.y + area.height) * scale) : Math.round(viewport.height);
    canvas.width = Math.max(1, right - left);
    canvas.height = Math.max(1, bottom - top);
    const task = sheet.page.render({
      canvas,
      viewport,
      transform: area ? [1, 0, 0, 1, -left, -top] : undefined,
    });
    this.task = task;
    try {
      await task.promise;
    } catch (reason) {
      release(canvas);
      throw reason;
    } finally {
      if (this.task === task) this.task = null;
    }
    if (this.closed) {
      release(canvas);
      return;
    }
    if (area) {
      // Placed by shares of the page, so that it stays where it belongs
      // while the page is made larger or smaller.
      const width = sheet.width * scale;
      const height = sheet.height * scale;
      canvas.className = 'pdf-part';
      canvas.style.left = `${(left / width) * 100}%`;
      canvas.style.top = `${(top / height) * 100}%`;
      canvas.style.width = `${(canvas.width / width) * 100}%`;
      canvas.style.height = `${(canvas.height / height) * 100}%`;
      const before = sheet.part?.canvas;
      sheet.part = {
        canvas,
        scale,
        area: { x: left / scale, y: top / scale, width: canvas.width / scale, height: canvas.height / scale },
      };
      sheet.box.append(canvas);
      this.drawn.add(sheet);
      if (before) release(before);
    } else {
      canvas.className = 'pdf-whole';
      const before = sheet.whole?.canvas;
      sheet.whole = { canvas, scale };
      sheet.box.prepend(canvas);
      this.drawn.add(sheet);
      if (before) release(before);
      // A part drawn for another size lies over it no longer.
      if (sheet.part && Math.abs(sheet.part.scale / scale - 1) <= 0.02) this.dropPart(sheet);
      sheet.box.dataset.drawn = scale.toFixed(3);
      if (!this.shown) {
        this.shown = true;
        this.events.onShown();
      }
    }
  }

  private dropPart(sheet: Sheet): void {
    if (!sheet.part) return;
    release(sheet.part.canvas);
    sheet.part = null;
  }

  /** Gives back what was drawn of a page. Never while a drawing is being made of it. */
  private letGo(sheet: Sheet): void {
    if (!sheet.whole && !sheet.part) return;
    this.drawn.delete(sheet);
    this.dropPart(sheet);
    if (sheet.whole) release(sheet.whole.canvas);
    sheet.whole = null;
    delete sheet.box.dataset.drawn;
    if (!this.task) sheet.page?.cleanup();
  }

  // ── Fingers, wheel and mouse ────────────────────────────────────────

  private on<K extends keyof HTMLElementEventMap>(
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    passive = true,
  ): void {
    this.scroller.addEventListener(type, handler, { passive });
    this.listeners.push(() => this.scroller.removeEventListener(type, handler));
  }

  private listen(): void {
    this.on('scroll', () => this.moved());

    const between = (touches: TouchList) => {
      const [one, other] = [touches[0], touches[1]];
      if (!one || !other) return null;
      return {
        distance: Math.hypot(one.clientX - other.clientX, one.clientY - other.clientY),
        at: { x: (one.clientX + other.clientX) / 2, y: (one.clientY + other.clientY) / 2 },
      };
    };
    this.on('touchstart', (event) => {
      const one = event.touches[0];
      if (event.touches.length === 1 && one) {
        this.touch = {
          at: { x: one.clientX, y: one.clientY },
          time: event.timeStamp,
          moved: false,
          many: false,
        };
      } else if (this.touch) {
        this.touch.many = true;
      }
      const fingers = event.touches.length === 2 ? between(event.touches) : null;
      const anchor = fingers && this.anchorAt(fingers.at);
      if (!fingers || !anchor || fingers.distance <= 0) {
        this.endPinch();
        return;
      }
      this.pinch = { distance: fingers.distance, zoom: this.zoom, anchor };
      // The fingers change the size and move the pages with them; nothing
      // else scrolls meanwhile, also not a scroll one finger had begun.
      this.scroller.classList.add('pinching');
    });
    this.on(
      'touchmove',
      (event) => {
        const one = event.touches[0];
        if (
          this.touch &&
          one &&
          Math.hypot(one.clientX - this.touch.at.x, one.clientY - this.touch.at.y) > STILL
        ) {
          this.touch.moved = true;
        }
        const fingers = this.pinch && event.touches.length === 2 ? between(event.touches) : null;
        if (!this.pinch || !fingers) return;
        if (event.cancelable) event.preventDefault();
        this.pinchWanted = {
          zoom: pinchedZoom(this.pinch.zoom, this.pinch.distance, fingers.distance),
          at: fingers.at,
        };
        // Once for each picture the screen draws, however often fingers report.
        this.pinchFrame ||= requestAnimationFrame(() => {
          this.pinchFrame = 0;
          if (this.pinch && this.pinchWanted) {
            this.show(this.pinchWanted.zoom, this.pinch.anchor, this.pinchWanted.at);
          }
        });
      },
      false,
    );
    const ended = (event: TouchEvent) => {
      this.lastTouch = event.timeStamp;
      if (event.touches.length < 2 && this.pinch) {
        // What the fingers said last is shown, though the screen had not
        // drawn it yet: a slow device draws seldom, and fingers lift fast.
        if (this.pinchWanted) this.show(this.pinchWanted.zoom, this.pinch.anchor, this.pinchWanted.at);
        this.endPinch();
        const view = this.scroller.getBoundingClientRect();
        // Left almost at the width of the view, it is put there.
        if (restingZoom(this.zoom) !== this.zoom) {
          this.zoomTo(1, { x: view.left + view.width / 2, y: view.top + view.height / 2 });
        }
      }
      if (event.touches.length > 0) return;
      const touch = this.touch;
      this.touch = null;
      if (event.type !== 'touchend' || !touch || touch.moved || touch.many) {
        this.lastTap = null;
        return;
      }
      if (event.timeStamp - touch.time > DOUBLE_TAP_MS) {
        this.lastTap = null;
        return;
      }
      const before = this.lastTap;
      if (
        before &&
        event.timeStamp - before.time <= DOUBLE_TAP_MS &&
        Math.hypot(touch.at.x - before.at.x, touch.at.y - before.at.y) <= DOUBLE_TAP_REACH
      ) {
        this.lastTap = null;
        this.closer(touch.at);
      } else {
        this.lastTap = { at: touch.at, time: event.timeStamp };
      }
    };
    this.on('touchend', ended);
    this.on('touchcancel', ended);

    this.on(
      'wheel',
      (event) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        this.zoomTo(this.zoom * Math.exp(-event.deltaY * 0.0025), { x: event.clientX, y: event.clientY });
      },
      false,
    );
    this.on('dblclick', (event) => {
      // A double tap has been answered already, where it was made.
      if (event.timeStamp - this.lastTouch < 700) return;
      this.closer({ x: event.clientX, y: event.clientY });
    });

    // A mouse takes hold of the pages and moves them.
    this.on('pointerdown', (event) => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      // Not by its scroll bars, which move the pages their own way.
      const view = this.scroller.getBoundingClientRect();
      if (
        event.clientX - view.left >= this.scroller.clientWidth ||
        event.clientY - view.top >= this.scroller.clientHeight
      ) {
        return;
      }
      this.drag = { pointer: event.pointerId, at: { x: event.clientX, y: event.clientY }, going: false };
    });
    this.on('pointermove', (event) => {
      const drag = this.drag;
      if (!drag || drag.pointer !== event.pointerId) return;
      if (!(event.buttons & 1)) {
        this.endDrag();
        return;
      }
      const by = { x: event.clientX - drag.at.x, y: event.clientY - drag.at.y };
      if (!drag.going) {
        if (Math.hypot(by.x, by.y) < DRAG_FROM) return;
        drag.going = true;
        this.scroller.setPointerCapture(event.pointerId);
        this.scroller.classList.add('dragging');
      }
      drag.at = { x: event.clientX, y: event.clientY };
      this.scroller.scrollLeft -= by.x;
      this.scroller.scrollTop -= by.y;
    });
    this.on('pointerup', () => this.endDrag());
    this.on('pointercancel', () => this.endDrag());
  }

  private endPinch(): void {
    this.pinch = null;
    this.pinchWanted = null;
    this.scroller.classList.remove('pinching');
  }

  private endDrag(): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag?.going) return;
    this.scroller.classList.remove('dragging');
    if (this.scroller.hasPointerCapture(drag.pointer)) this.scroller.releasePointerCapture(drag.pointer);
  }

  /** A double tap or click: closer to what is there, or back to the width of the view. */
  private closer(at: Point): void {
    this.zoomTo(this.zoom < 1.5 ? CLOSE_ZOOM : 1, at);
  }
}

/** Gives a drawing's memory back at once, not when the browser gets to it. */
function release(canvas: HTMLCanvasElement): void {
  canvas.remove();
  canvas.width = 0;
  canvas.height = 0;
}
