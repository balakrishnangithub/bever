import { useEffect, useRef } from 'react';
import type { PointerEvent } from 'react';

import {
  DRAWER_EDGE_WIDTH,
  drawerOffset,
  isHorizontalSwipe,
  shouldToggleDrawer,
  swipeSpeed,
  turnedUpright,
  type SwipePoint,
} from './drawerGestures';

interface Gesture {
  pointerId: number;
  startX: number;
  startY: number;
  width: number;
  opening: boolean;
  decided: boolean;
  /** Began on the dimmed area beside the open drawer: letting go closes it. */
  outside: boolean;
  trail: SwipePoint[];
}

/** How long after a touch ends its click may still arrive, in milliseconds. */
const CLICK_FOLLOWS_MS = 100;

/**
 * Keeps the click a touch ends with from what the closing drawer uncovers:
 * the touch has already been acted on, and the click, arriving a moment
 * later, would open the note that was under the dimmed area.
 */
function swallowFollowingClick() {
  const done = () => {
    window.removeEventListener('click', swallow, true);
    window.clearTimeout(timer);
  };
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    done();
  };
  const timer = window.setTimeout(done, CLICK_FOLLOWS_MS);
  window.addEventListener('click', swallow, true);
}

/** What a finger moved sideways across may itself want the movement for. */
const SIDEWAYS_OWNERS = 'input, textarea, select, canvas, [contenteditable="true"]';

/** Whether a sideways swipe on `target` scrolls something, or is otherwise spoken for. */
function sidewaysIsTaken(target: Element, within: Element): boolean {
  if (target.closest(SIDEWAYS_OWNERS)) return true;
  for (let element: Element | null = target; element && element !== within; element = element.parentElement) {
    if (element.scrollWidth > element.clientWidth + 1) {
      const overflow = window.getComputedStyle(element).overflowX;
      if (overflow === 'auto' || overflow === 'scroll') return true;
    }
  }
  return false;
}

/** Touch-only, horizontal drawer gestures; vertical scrolling stays native. */
export function useDrawerGestures({
  open,
  blocked,
  onOpen,
  onClose,
}: {
  open: boolean;
  blocked: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const gesture = useRef<Gesture | null>(null);

  // A swipe that ends with speed leaves the browser a fling to run, even
  // where nothing scrolls sideways, and the next touch is spent on stopping
  // it: the tap is felt and its click never comes. That was the drawer
  // ignoring the first touch after it had been swiped open. A sideways swipe
  // whose moves are taken here starts no fling.
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>('.app-shell');
    if (!shell) return;
    let start: { x: number; y: number } | null = null;
    const began = (event: TouchEvent) => {
      const touch = event.touches[0];
      const target = event.target instanceof Element ? event.target : null;
      const free = touch && target && event.touches.length === 1 && !sidewaysIsTaken(target, shell);
      start = free ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const moved = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!start || !touch || !event.cancelable) return;
      const current = gesture.current;
      const sideways = isHorizontalSwipe(touch.clientX - start.x, touch.clientY - start.y);
      if (current?.decided || current?.outside || sideways) event.preventDefault();
    };
    shell.addEventListener('touchstart', began, { passive: true });
    shell.addEventListener('touchmove', moved, { passive: false });
    return () => {
      shell.removeEventListener('touchstart', began);
      shell.removeEventListener('touchmove', moved);
    };
  }, []);

  const drawer = (event: PointerEvent<HTMLDivElement>) =>
    event.currentTarget.querySelector<HTMLElement>('.sidebar');

  const finish = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - current.startX;
    const element = drawer(event);
    if (element) {
      element.style.transition = '';
      element.style.transform = '';
    }
    if (!cancelled) {
      current.trail.push({ x: event.clientX, time: event.timeStamp });
      const far = current.decided && shouldToggleDrawer(deltaX, current.opening, swipeSpeed(current.trail));
      if (current.opening) {
        if (far) onOpen();
      } else if (far || current.outside) {
        // A touch on the dimmed area closes the drawer however it went. One
        // that stayed still is followed by a click, which has nothing left
        // to do.
        if (!current.decided) swallowFollowingClick();
        onClose();
      }
    }
    if (current.decided && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    gesture.current = null;
  };

  return {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'touch' || blocked || !window.matchMedia('(max-width: 760px)').matches)
        return;
      const element = drawer(event);
      if (!element) return;
      const target = event.target instanceof Element ? event.target : null;
      const outside = Boolean(target?.closest('.sidebar-scrim'));
      // The open drawer is dragged by itself or by the dimmed area beside it,
      // not by a dialog or a menu lying over them; the closed one by the
      // window's edge.
      if (open ? !outside && !target?.closest('.sidebar') : event.clientX > DRAWER_EDGE_WIDTH) return;
      if (!open && target?.closest('.modal-backdrop')) return;
      gesture.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        width: element.getBoundingClientRect().width,
        opening: !open,
        decided: false,
        outside: open && outside,
        trail: [{ x: event.clientX, time: event.timeStamp }],
      };
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const deltaX = event.clientX - current.startX;
      const deltaY = event.clientY - current.startY;
      if (!current.decided) {
        if (Math.abs(deltaY) > 8 && Math.abs(deltaY) > Math.abs(deltaX)) {
          // Scrolling the drawer's lists. On the dimmed area there is nothing
          // to scroll, and the touch still closes the drawer when it ends.
          if (!current.outside) gesture.current = null;
          return;
        }
        if (!isHorizontalSwipe(deltaX, deltaY) || (current.opening && deltaX < 0)) return;
        current.decided = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        const element = drawer(event);
        if (element) element.style.transition = 'none';
      }
      // A swipe at one of the drawer's lists, begun on a slant: it went on
      // upward or downward, so it is the list's. The drawer goes back to
      // where it was and lets the touch go; the list moves from here on.
      if (!current.outside && turnedUpright(deltaX, deltaY)) {
        const element = drawer(event);
        if (element) {
          element.style.transition = '';
          element.style.transform = '';
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        gesture.current = null;
        return;
      }
      event.preventDefault();
      current.trail.push({ x: event.clientX, time: event.timeStamp });
      if (current.trail.length > 24) current.trail.shift();
      const element = drawer(event);
      if (element)
        element.style.transform = `translateX(${drawerOffset(deltaX, current.width, current.opening)}px)`;
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => finish(event),
    onPointerCancel: (event: PointerEvent<HTMLDivElement>) => finish(event, true),
  };
}
