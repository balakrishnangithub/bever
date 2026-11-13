import { describe, expect, it } from 'vitest';

import { drawerOffset, isHorizontalSwipe, shouldToggleDrawer, swipeSpeed } from './drawerGestures';

describe('touch drawer gestures', () => {
  it('accepts deliberate horizontal swipes', () => {
    expect(isHorizontalSwipe(70, 8)).toBe(true);
    expect(shouldToggleDrawer(70, true)).toBe(true);
    expect(shouldToggleDrawer(-70, false)).toBe(true);
  });

  it('rejects vertical scrolling and short taps', () => {
    expect(isHorizontalSwipe(12, 70)).toBe(false);
    expect(isHorizontalSwipe(2, 1)).toBe(false);
    expect(shouldToggleDrawer(35, true)).toBe(false);
    expect(shouldToggleDrawer(-35, false)).toBe(false);
  });

  it('accepts a short swipe that is a flick', () => {
    expect(shouldToggleDrawer(-30, false, -0.8)).toBe(true);
    expect(shouldToggleDrawer(30, true, 0.8)).toBe(true);
    // Too short to be meant, however fast.
    expect(shouldToggleDrawer(-12, false, -2)).toBe(false);
    // Fast, but back the way it came.
    expect(shouldToggleDrawer(-30, false, 0.8)).toBe(false);
    expect(shouldToggleDrawer(30, true, -0.8)).toBe(false);
  });

  it('takes the speed of a swipe from its end', () => {
    expect(swipeSpeed([])).toBe(0);
    expect(swipeSpeed([{ x: 10, time: 0 }])).toBe(0);
    expect(
      swipeSpeed([
        { x: 200, time: 0 },
        { x: 150, time: 50 },
        { x: 100, time: 100 },
      ]),
    ).toBe(-1);
    // A swipe that slowed to a stop before the finger was lifted is not a flick.
    expect(
      swipeSpeed([
        { x: 200, time: 0 },
        { x: 100, time: 50 },
        { x: 100, time: 300 },
        { x: 100, time: 400 },
      ]),
    ).toBe(0);
  });

  it('clamps drag positions to the drawer width', () => {
    expect(drawerOffset(20, 300, true)).toBe(-280);
    expect(drawerOffset(800, 300, true)).toBe(0);
    expect(drawerOffset(-800, 300, false)).toBe(-300);
    expect(drawerOffset(50, 300, false)).toBe(0);
  });
});
