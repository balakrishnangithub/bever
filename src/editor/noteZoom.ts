import { useEffect, useRef, useState } from 'react';

/** How much larger than its own size a note can be made. */
export const MAX_ZOOM = 5;

type Point = { x: number; y: number };

/**
 * Makes a note larger to look at, as a page of a PDF is made larger: two
 * fingers spread on it, or Ctrl with the wheel (which is also what a
 * touchpad sends for the same gesture).
 *
 * The lines stay as they are. Nothing is wrapped anew to fit the window:
 * the note becomes wider than its place, and what does not fit is reached
 * by moving it. What was under the fingers, or under the pointer, stays
 * there while the size changes.
 *
 * `frame` goes on the element the note moves sideways in; the note itself
 * is its first child. Up and down, the note moves with whatever scrolls it
 * already. The size is one visit's: the next note opens at its own size.
 */
export function useNoteZoom() {
  // The element is there once the editor is, which is after the first
  // drawing: it is taken when it comes.
  const [element, frame] = useState<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const back = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!element) return undefined;
    let current = 1;

    /**
     * Shows the note at `next`, with the point of it that is at `point`
     * (in the note's own size, from its corner) under `at` on the screen.
     */
    const show = (next: number, point: Point | null, at: Point | null) => {
      const page = element.firstElementChild;
      if (!(page instanceof HTMLElement)) return;
      const size = Math.min(MAX_ZOOM, Math.max(1, next));
      // Almost its own size is its own size.
      const zoomed = size > 1.01;
      current = zoomed ? size : 1;
      element.style.setProperty('--note-zoom', String(current));
      element.classList.toggle('zoomed', zoomed);
      if (!zoomed) element.scrollLeft = 0;
      if (zoomed && point && at) {
        const now = page.getBoundingClientRect();
        element.scrollLeft += now.left + point.x * size - at.x;
        const upright = scroller(element);
        if (upright) upright.scrollTop += now.top + point.y * size - at.y;
      }
      setZoom(current);
    };
    /** The point of the note, in its own size, that is at a place on the screen. */
    const pointAt = (at: Point): Point | null => {
      const page = element.firstElementChild;
      if (!(page instanceof HTMLElement)) return null;
      const box = page.getBoundingClientRect();
      return { x: (at.x - box.left) / current, y: (at.y - box.top) / current };
    };
    const between = (touches: TouchList) => {
      const [one, other] = [touches[0], touches[1]];
      if (!one || !other) return null;
      return {
        distance: Math.hypot(one.clientX - other.clientX, one.clientY - other.clientY),
        at: { x: (one.clientX + other.clientX) / 2, y: (one.clientY + other.clientY) / 2 },
      };
    };

    let pinch: { distance: number; zoom: number; point: Point } | null = null;
    let drawing = 0;
    let wanted: { zoom: number; at: Point } | null = null;
    const begin = (event: TouchEvent) => {
      const fingers = event.touches.length === 2 ? between(event.touches) : null;
      const point = fingers && pointAt(fingers.at);
      pinch = fingers && point && fingers.distance > 0 ? { ...fingers, zoom: current, point } : null;
    };
    const move = (event: TouchEvent) => {
      const fingers = pinch && event.touches.length === 2 ? between(event.touches) : null;
      if (!pinch || !fingers) return;
      // The fingers change the note's size, and nothing else.
      event.preventDefault();
      wanted = { zoom: (pinch.zoom * fingers.distance) / pinch.distance, at: fingers.at };
      // Once for each picture the screen draws, however often fingers report.
      drawing ||= requestAnimationFrame(() => {
        drawing = 0;
        if (pinch && wanted) show(wanted.zoom, pinch.point, wanted.at);
      });
    };
    const end = (event: TouchEvent) => {
      if (event.touches.length < 2) pinch = null;
    };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const at = { x: event.clientX, y: event.clientY };
      show(current * Math.exp(-event.deltaY * 0.0025), pointAt(at), at);
    };
    element.addEventListener('touchstart', begin, { passive: true });
    element.addEventListener('touchmove', move, { passive: false });
    element.addEventListener('touchend', end, { passive: true });
    element.addEventListener('touchcancel', end, { passive: true });
    element.addEventListener('wheel', wheel, { passive: false });
    back.current = () => show(1, null, null);
    return () => {
      back.current = null;
      cancelAnimationFrame(drawing);
      element.removeEventListener('touchstart', begin);
      element.removeEventListener('touchmove', move);
      element.removeEventListener('touchend', end);
      element.removeEventListener('touchcancel', end);
      element.removeEventListener('wheel', wheel);
    };
  }, [element]);

  return { frame, zoom, reset: () => back.current?.() };
}

/** What moves `element` up and down: the nearest thing around it that scrolls. */
function scroller(element: HTMLElement): HTMLElement | null {
  for (let around = element.parentElement; around; around = around.parentElement) {
    const overflow = getComputedStyle(around).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return around;
  }
  return null;
}
