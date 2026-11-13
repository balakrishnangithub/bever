import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';

/** How long the handle stays after the list has come to rest, in milliseconds. */
const LINGER_MS = 1400;
/** The handle is never shorter than this, so that a finger can take it. */
const SHORTEST = 48;
/** Room left free above and under the handle. */
const MARGIN = 4;

interface Place {
  top: number;
  height: number;
  /** The row at the top of what is in view, counted from one. */
  row: number;
}

/**
 * A handle at the edge of a long list, for a finger: where a mouse has the
 * scroll bar, a phone shows none that can be taken hold of. It appears
 * while the list moves, shows how far down the list is, and can be dragged
 * to any part of it; a label beside it says which row that is.
 *
 * It is shown only where the pointer is a finger, takes no room in the
 * list, and can be touched only while it is showing.
 */
export function ListScroller({
  scroller,
  rowHeight,
  total,
}: {
  scroller: RefObject<HTMLDivElement | null>;
  rowHeight: number;
  total: number;
}) {
  const [touch, setTouch] = useState(() => window.matchMedia('(pointer: coarse)').matches);
  const [place, setPlace] = useState<Place | null>(null);
  const [showing, setShowing] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** Where on the handle the finger took it. */
  const grip = useRef(0);
  const linger = useRef<number | undefined>(undefined);

  useEffect(() => {
    const query = window.matchMedia('(pointer: coarse)');
    const changed = () => setTouch(query.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);

  useEffect(() => {
    const list = scroller.current;
    if (!touch || !list) return;
    let frame = 0;
    const measure = () => {
      const range = list.scrollHeight - list.clientHeight;
      if (range <= 1) {
        setPlace(null);
        return;
      }
      const track = list.clientHeight - 2 * MARGIN;
      const height = Math.min(track, Math.max(SHORTEST, (track * list.clientHeight) / list.scrollHeight));
      setPlace({
        top: MARGIN + ((track - height) * list.scrollTop) / range,
        height,
        row: Math.min(total, Math.floor(list.scrollTop / rowHeight) + 1),
      });
    };
    const moved = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
      setShowing(true);
      window.clearTimeout(linger.current);
      linger.current = window.setTimeout(() => setShowing(false), LINGER_MS);
    };
    const resized = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    measure();
    list.addEventListener('scroll', moved, { passive: true });
    const observer = new ResizeObserver(resized);
    observer.observe(list);
    if (list.firstElementChild) observer.observe(list.firstElementChild);
    return () => {
      list.removeEventListener('scroll', moved);
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      window.clearTimeout(linger.current);
    };
    // The list's length changes how far it scrolls.
  }, [scroller, touch, total, rowHeight]);

  if (!touch || !place) return null;

  const dragTo = (event: PointerEvent<HTMLDivElement>) => {
    const list = scroller.current;
    if (!list) return;
    const track = list.clientHeight - 2 * MARGIN - place.height;
    if (track <= 0) return;
    const top = event.clientY - list.getBoundingClientRect().top - grip.current - MARGIN;
    const share = Math.min(1, Math.max(0, top / track));
    list.scrollTo({ top: share * (list.scrollHeight - list.clientHeight) });
  };
  return (
    <div
      className={`list-scroller ${showing || dragging ? 'showing' : ''} ${dragging ? 'dragging' : ''}`}
      style={{ top: place.top, height: place.height }}
      // The drawer's gestures are not to take this touch for their own.
      onPointerDown={(event) => {
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        grip.current = event.clientY - event.currentTarget.getBoundingClientRect().top;
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!dragging) return;
        event.stopPropagation();
        dragTo(event);
      }}
      onPointerUp={(event) => {
        event.stopPropagation();
        setDragging(false);
      }}
      onPointerCancel={() => setDragging(false)}
      aria-hidden="true"
    >
      <span className="list-scroller-bar" />
      {dragging && (
        <span className="list-scroller-label">
          {place.row.toLocaleString()} of {total.toLocaleString()}
        </span>
      )}
    </div>
  );
}
