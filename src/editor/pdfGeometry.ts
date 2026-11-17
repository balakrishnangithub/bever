/**
 * The arithmetic of looking at a PDF: how large its pages are shown, how
 * large they are drawn, and which part of a page is in view. Lengths of a
 * page are in points, the unit a PDF is written in; a scale is how many
 * pixels a point is given.
 */

/** A rectangle: its corner and its size. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How small and how large the pages can be made, against fitting the width. */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 8;
/** What a double tap makes of pages that fit the width. */
export const CLOSE_ZOOM = 2.5;

export const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** Almost fitting the width is fitting the width: fingers do not end on a number. */
export const restingZoom = (zoom: number) => (Math.abs(zoom - 1) < 0.06 ? 1 : zoom);

/**
 * How wide a page is shown, in pixels, when it fits a view of `viewWidth`
 * with `margin` on either side. Every page of a document is shown this
 * wide, the wide ones and the narrow ones, so that none of them has to be
 * moved sideways to be read. A wide window does not make a page wider than
 * a line can be read, nor a small page more than twice its size:
 * `pageWidth` is the width of the document's first page, in points.
 */
export function fitWidth(viewWidth: number, pageWidth: number, margin: number): number {
  const room = Math.min(viewWidth, 1000) - 2 * margin;
  return Math.max(40, Math.min(room, 2 * pageWidth));
}

/**
 * The scale a whole page is drawn at: the one `wanted`, unless the drawing
 * would then have more pixels than `maxPixels` or a side longer than
 * `maxSide`. Past that the whole page stays as it is, and the part of it in
 * view is drawn over it at the scale wanted.
 */
export function wholeScale(
  width: number,
  height: number,
  wanted: number,
  maxPixels: number,
  maxSide: number,
): number {
  const byArea = Math.sqrt(maxPixels / Math.max(1, width * height));
  const bySide = maxSide / Math.max(1, width, height);
  return Math.min(wanted, byArea, bySide);
}

/**
 * The part of `page` that is in `view`, with `around` of the view's size
 * added on every side that the page has room on, from the page's own
 * corner. Both are where they are on the screen. Null when the page is not
 * in view.
 */
export function partInView(page: Box, view: Box, around: number): Box | null {
  const left = Math.max(page.x, view.x - view.width * around);
  const top = Math.max(page.y, view.y - view.height * around);
  const right = Math.min(page.x + page.width, view.x + view.width + view.width * around);
  const bottom = Math.min(page.y + page.height, view.y + view.height + view.height * around);
  // Of the view itself, before anything is added to it.
  const seen =
    Math.min(page.x + page.width, view.x + view.width) > Math.max(page.x, view.x) &&
    Math.min(page.y + page.height, view.y + view.height) > Math.max(page.y, view.y);
  if (!seen) return null;
  return { x: left - page.x, y: top - page.y, width: right - left, height: bottom - top };
}

/** Whether `inner` lies in `outer`, give or take `slack`. */
export function covers(outer: Box, inner: Box, slack: number): boolean {
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.width <= outer.x + outer.width + slack &&
    inner.y + inner.height <= outer.y + outer.height + slack
  );
}

/** `box` with every length multiplied by `factor`. */
export const scaled = (box: Box, factor: number): Box => ({
  x: box.x * factor,
  y: box.y * factor,
  width: box.width * factor,
  height: box.height * factor,
});

/**
 * Which of the pages is at `y`, counted from nought: the last whose top is
 * at or above it. `topOf` gives the top of a page; the tops go downward.
 */
export function pageAt(count: number, topOf: (index: number) => number, y: number): number {
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (topOf(middle) <= y) low = middle;
    else high = middle - 1;
  }
  return Math.max(0, low);
}

/** The size two fingers ask for: the size they began at, by how far apart they now are. */
export function pinchedZoom(began: number, distanceThen: number, distanceNow: number): number {
  return distanceThen > 0 ? clampZoom((began * distanceNow) / distanceThen) : began;
}
