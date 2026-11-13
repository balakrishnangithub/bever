export const DRAWER_EDGE_WIDTH = 24;
export const DRAWER_OPEN_DISTANCE = 60;
/** A flick moves the drawer after this little travel… */
export const DRAWER_FLICK_DISTANCE = 20;
/** …when it is at least this fast, in pixels per millisecond. */
export const DRAWER_FLICK_SPEED = 0.4;
/** How much of a swipe's end its speed is taken from, in milliseconds. */
const SPEED_WINDOW_MS = 120;

/** Where a finger was, and when. */
export interface SwipePoint {
  x: number;
  time: number;
}

export function isHorizontalSwipe(deltaX: number, deltaY: number): boolean {
  return Math.abs(deltaX) > 8 && Math.abs(deltaX) > Math.abs(deltaY) * 1.2;
}

export function drawerOffset(deltaX: number, width: number, opening: boolean): number {
  return opening ? Math.min(0, deltaX - width) : Math.max(-width, Math.min(0, deltaX));
}

/** How fast a swipe was going sideways when it ended; to the right is positive. */
export function swipeSpeed(trail: SwipePoint[]): number {
  const last = trail[trail.length - 1];
  if (!last) return 0;
  const first = trail.find((point) => last.time - point.time <= SPEED_WINDOW_MS) ?? last;
  const elapsed = last.time - first.time;
  return elapsed > 0 ? (last.x - first.x) / elapsed : 0;
}

/** Whether a swipe went far enough, or fast enough, to move the drawer. */
export function shouldToggleDrawer(deltaX: number, opening: boolean, speed = 0): boolean {
  const travel = opening ? deltaX : -deltaX;
  const along = opening ? speed : -speed;
  return travel >= DRAWER_OPEN_DISTANCE || (travel >= DRAWER_FLICK_DISTANCE && along >= DRAWER_FLICK_SPEED);
}
