import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { backStack } from './backStack';

const depth = () => (window.history.state as { depth?: number } | null)?.depth ?? 0;
const layerThere = () => (window.history.state as { bever?: string } | null)?.bever ?? null;
/** Waits for the step in the history that is on its way. */
const arrival = () =>
  new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }));
/** Someone goes back: Android's button, a mouse's, a key. */
const goBack = async () => {
  window.history.back();
  await arrival();
};
/** Someone touches the page. */
const touch = () => window.dispatchEvent(new Event('pointerup'));

describe('what going back closes', () => {
  beforeEach(() => {
    // The stack listens from the first time it is used.
    backStack.subscribe(() => undefined)();
    touch();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    // Every test leaves nothing open.
    expect(depth()).toBe(0);
    expect(backStack.layer()).toBeNull();
  });

  it('closes what was opened, and takes it for closed', async () => {
    const closed = vi.fn();
    backStack.opened(closed);
    expect(depth()).toBe(1);
    await goBack();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(depth()).toBe(0);
  });

  it('takes its entry out of the history when a thing is closed by itself', async () => {
    const closed = vi.fn();
    const item = backStack.opened(closed);
    const back = vi.spyOn(window.history, 'back');
    backStack.closed(item);
    // Closing it twice, as an effect cleaned up twice would, steps back once.
    backStack.closed(item);
    expect(back).toHaveBeenCalledTimes(1);
    await arrival();
    expect(depth()).toBe(0);
    // It closed itself: it is not asked to.
    expect(closed).not.toHaveBeenCalled();
  });

  it('closes the thing opened last, and what was under it at the next step', async () => {
    const order: string[] = [];
    backStack.opened(() => void order.push('dialog'));
    backStack.opened(() => void order.push('menu'));
    expect(depth()).toBe(2);
    await goBack();
    expect(order).toEqual(['menu']);
    expect(depth()).toBe(1);
    await goBack();
    expect(order).toEqual(['menu', 'dialog']);
  });

  it('makes no entry for what was opened with no touch since Back', async () => {
    const first = vi.fn();
    backStack.opened(first);
    await goBack();
    expect(first).toHaveBeenCalledTimes(1);
    // The application opens something by itself: Android would take an
    // entry made now for a trap, and pass every entry of the page by.
    const second = vi.fn();
    const item = backStack.opened(second);
    expect(depth()).toBe(0);
    // The next touch gives it its entry, and Back then closes it.
    touch();
    expect(depth()).toBe(1);
    await goBack();
    expect(second).toHaveBeenCalledTimes(1);
    backStack.closed(item);
  });

  it('keeps a thing that says it stays, without an entry until the page is touched', async () => {
    let saving = true;
    const item = backStack.opened(() => (saving ? false : undefined));
    const under = vi.fn();
    backStack.closed(item);
    await arrival();
    // Under it, something else; then the thing that stays.
    backStack.opened(under);
    const staying = backStack.opened(() => (saving ? false : undefined));
    expect(depth()).toBe(2);
    await goBack();
    // It stays, and what is under it is not closed in its place.
    expect(under).not.toHaveBeenCalled();
    expect(depth()).toBe(1);
    touch();
    expect(depth()).toBe(2);
    saving = false;
    await goBack();
    expect(depth()).toBe(1);
    await goBack();
    expect(under).toHaveBeenCalledTimes(1);
    backStack.closed(staying);
  });

  it('closes one thing for one step back, also when things have no entry', async () => {
    const order: string[] = [];
    backStack.opened(() => void order.push('first'));
    await goBack();
    // Two things opened with no touch: neither has an entry.
    backStack.opened(() => void order.push('second'));
    touch();
    backStack.opened(() => void order.push('third'));
    expect(depth()).toBe(2);
    await goBack();
    backStack.opened(() => void order.push('fourth'));
    expect(depth()).toBe(1);
    await goBack();
    // The topmost, and that one only.
    expect(order).toEqual(['first', 'third', 'fourth']);
    touch();
    expect(depth()).toBe(1);
    await goBack();
    expect(order).toEqual(['first', 'third', 'fourth', 'second']);
  });

  it('gives a thing opened while a step back is on its way its entry when the step has arrived', async () => {
    const first = backStack.opened(() => undefined);
    backStack.closed(first);
    const closed = vi.fn();
    backStack.opened(closed);
    await arrival();
    expect(depth()).toBe(1);
    expect(closed).not.toHaveBeenCalled();
    await goBack();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('closes what lies over a layer before the layer', async () => {
    backStack.openLayer('editor', true);
    const closed = vi.fn();
    backStack.opened(closed);
    expect(depth()).toBe(2);
    // The entry of what lies over the note still says the note is showing.
    expect(layerThere()).toBe('editor');
    await goBack();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(backStack.layer()).toBe('editor');
    await goBack();
    expect(backStack.layer()).toBeNull();
  });

  it('closes a layer with what lies over it, in one step', async () => {
    backStack.openLayer('editor', true);
    const closed = vi.fn();
    backStack.opened(closed);
    const go = vi.spyOn(window.history, 'go');
    backStack.closeLayer('editor');
    expect(backStack.layer()).toBeNull();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith(-2);
    await arrival();
    expect(depth()).toBe(0);
  });

  it('shows the layer under one that is closed', async () => {
    backStack.openLayer('editor', true);
    backStack.openLayer('settings', true);
    expect(backStack.layer()).toBe('settings');
    // A layer under another is not closed from under it.
    backStack.closeLayer('editor');
    expect(backStack.layer()).toBe('settings');
    backStack.closeLayer('settings');
    expect(backStack.layer()).toBe('editor');
    await arrival();
    expect(layerThere()).toBe('editor');
    backStack.closeLayer('editor');
    await arrival();
  });

  it('keeps a layer that is beside the others out of the history', async () => {
    backStack.openLayer('editor', false);
    expect(backStack.layer()).toBe('editor');
    expect(depth()).toBe(0);
    // What lies over everything is shown over it, and makes way for it.
    backStack.openLayer('settings', true);
    expect(backStack.layer()).toBe('settings');
    backStack.openLayer('editor', false);
    expect(backStack.layer()).toBe('editor');
    await arrival();
    expect(depth()).toBe(0);
    backStack.closeLayer('editor');
    expect(backStack.layer()).toBeNull();
  });
});
