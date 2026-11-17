import { describe, expect, it } from 'vitest';

import {
  clampZoom,
  covers,
  fitWidth,
  MAX_ZOOM,
  MIN_ZOOM,
  pageAt,
  partInView,
  pinchedZoom,
  restingZoom,
  scaled,
  wholeScale,
} from './pdfGeometry';

describe('how large the pages of a PDF are shown', () => {
  it('fits a page to the width of the view', () => {
    // A phone: 390 wide, 16 on either side.
    expect(fitWidth(390, 612, 16)).toBe(358);
    // A wide window does not make the page wider than 1000, less its margins.
    expect(fitWidth(1800, 612, 16)).toBe(968);
    // A small page is not made more than twice its size.
    expect(fitWidth(1000, 200, 16)).toBe(400);
    // And a view too narrow for anything still shows something.
    expect(fitWidth(20, 612, 16)).toBe(40);
  });

  it('keeps the size between the smallest and the largest', () => {
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
    expect(clampZoom(40)).toBe(MAX_ZOOM);
    expect(clampZoom(3)).toBe(3);
    expect(pinchedZoom(1, 100, 250)).toBe(2.5);
    expect(pinchedZoom(2, 200, 50)).toBe(MIN_ZOOM);
    expect(pinchedZoom(2, 0, 50)).toBe(2);
  });

  it('takes a size that almost fits the width for one that does', () => {
    expect(restingZoom(1.04)).toBe(1);
    expect(restingZoom(0.95)).toBe(1);
    expect(restingZoom(1.2)).toBe(1.2);
    expect(restingZoom(0.8)).toBe(0.8);
  });
});

describe('how large a page of a PDF is drawn', () => {
  it('draws a whole page at the scale wanted while that is not too much', () => {
    expect(wholeScale(612, 792, 2, 4_000_000, 4096)).toBe(2);
  });

  it('stops at as many pixels as a drawing may have', () => {
    const scale = wholeScale(612, 792, 12, 4_000_000, 4096);
    expect(scale).toBeLessThan(12);
    expect(612 * scale * 792 * scale).toBeCloseTo(4_000_000, 0);
  });

  it('stops at the longest side a drawing may have', () => {
    // A strip: few pixels in all, and far too long.
    const scale = wholeScale(100, 20_000, 2, 4_000_000, 4096);
    expect(20_000 * scale).toBeCloseTo(4096);
  });
});

describe('the part of a page that is in view', () => {
  const view = { x: 0, y: 100, width: 400, height: 600 };

  it('is what the page and the view have in common, from the corner of the page', () => {
    // A page three times as wide and as tall as the view, scrolled into.
    const page = { x: -300, y: -500, width: 1200, height: 1800 };
    expect(partInView(page, view, 0)).toEqual({ x: 300, y: 600, width: 400, height: 600 });
  });

  it('takes more of the page around it, where the page has more', () => {
    const page = { x: -50, y: -500, width: 1200, height: 1800 };
    // A quarter of the view on every side: 100 across, 150 down. To the
    // left the page has only 50 more.
    expect(partInView(page, view, 0.25)).toEqual({ x: 0, y: 450, width: 550, height: 900 });
  });

  it('is nothing for a page out of view, however near', () => {
    expect(partInView({ x: 0, y: 720, width: 400, height: 500 }, view, 0.25)).toBeNull();
    expect(partInView({ x: 0, y: -500, width: 400, height: 590 }, view, 0.25)).toBeNull();
    expect(partInView({ x: 0, y: 690, width: 400, height: 500 }, view, 0)).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 10,
    });
  });

  it('is covered by a drawing that has all of it', () => {
    const drawn = { x: 100, y: 100, width: 300, height: 300 };
    expect(covers(drawn, { x: 150, y: 150, width: 100, height: 100 }, 0)).toBe(true);
    expect(covers(drawn, { x: 99.5, y: 100, width: 300.9, height: 300 }, 1)).toBe(true);
    expect(covers(drawn, { x: 90, y: 150, width: 100, height: 100 }, 1)).toBe(false);
    expect(covers(drawn, { x: 150, y: 350, width: 100, height: 100 }, 1)).toBe(false);
    expect(scaled(drawn, 0.5)).toEqual({ x: 50, y: 50, width: 150, height: 150 });
  });
});

describe('which page is at a place', () => {
  const tops = [0, 800, 1600, 2400];
  const at = (y: number) => pageAt(tops.length, (index) => tops[index] ?? 0, y);

  it('is the last page that begins at or above it', () => {
    expect(at(0)).toBe(0);
    expect(at(799)).toBe(0);
    expect(at(800)).toBe(1);
    expect(at(2399)).toBe(2);
    expect(at(99_999)).toBe(3);
  });

  it('is the first page above all of them, and for a document of one', () => {
    expect(at(-50)).toBe(0);
    expect(pageAt(1, () => 0, 500)).toBe(0);
    expect(pageAt(0, () => 0, 500)).toBe(0);
  });
});
