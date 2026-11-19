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

  describe('with places one has been', () => {
    /** A library that has been to `behind` places before the one showing. */
    const library = (behind: number) => {
      const state = { behind, steps: 0 };
      const back = () => {
        state.behind -= 1;
        state.steps += 1;
        backStack.places(state.behind, back);
      };
      const go = (to: number, front = 'list') => {
        state.behind = to;
        backStack.places(to, back, front);
      };
      go(behind);
      return { state, go };
    };

    it('goes back to where one was, a place for a step, and no further than the first', async () => {
      const { state, go } = library(0);
      go(1);
      go(2);
      expect(depth()).toBe(2);
      await goBack();
      expect([state.behind, state.steps, depth()]).toEqual([1, 1, 1]);
      await goBack();
      expect([state.behind, state.steps, depth()]).toEqual([0, 2, 0]);
    });

    it('closes what is open before it goes back', async () => {
      const { state, go } = library(0);
      go(1);
      const menu = vi.fn();
      backStack.opened(menu);
      expect(depth()).toBe(2);
      await goBack();
      expect([menu.mock.calls.length, state.steps]).toEqual([1, 0]);
      await goBack();
      expect([menu.mock.calls.length, state.steps]).toEqual([1, 1]);
    });

    it('goes back before it closes what the place one went on to covers', async () => {
      const { state, go } = library(0);
      // Notes are ticked in the list, and then one of them is opened, which
      // covers the list on a phone.
      const ticked = vi.fn();
      backStack.opened(ticked);
      go(1, 'note');
      expect(depth()).toBe(2);
      await goBack();
      expect([ticked.mock.calls.length, state.steps]).toEqual([0, 1]);
      // The list is in front again, the notes still ticked.
      backStack.places(0, () => undefined, 'list');
      await goBack();
      expect([ticked.mock.calls.length, state.steps]).toEqual([1, 1]);
    });

    it('closes what is still over the place one went on to before it goes back', async () => {
      const { state, go } = library(0);
      // A filter is chosen in the panel of filters: the list is filtered,
      // which is a step, and the panel is over it as it was.
      const panel = vi.fn();
      backStack.opened(panel);
      go(1, 'list');
      await goBack();
      expect([panel.mock.calls.length, state.steps]).toEqual([1, 0]);
      await goBack();
      expect([panel.mock.calls.length, state.steps]).toEqual([1, 1]);
    });

    it('takes the entries of places out when one goes back by other means', async () => {
      const { state, go } = library(0);
      go(1);
      go(2);
      go(3);
      // The application's own Back, twice: no step is asked of the library.
      go(1);
      await arrival();
      expect([depth(), state.steps]).toEqual([1, 0]);
      go(0);
      await arrival();
    });

    it('does not go on asking for a step back that the history does not have', async () => {
      const { go } = library(0);
      go(1);
      go(2);
      // The browser has dropped its oldest entries: a step back goes nowhere.
      const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
      vi.useFakeTimers();
      go(1);
      expect(back).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5000);
      vi.useRealTimers();
      // Asked for once, not once a second; the entry one is on is the place.
      expect(back).toHaveBeenCalledTimes(1);
      expect(depth()).toBe(1);
      back.mockRestore();
      // Here the history does have the entries: going back to the start
      // passes the one that was under, and comes to the first.
      go(0);
      await arrival();
      await arrival();
    });

    it('makes no entry for a place gone to with no touch since Back, and gives it one at the next touch', async () => {
      const { state, go } = library(0);
      go(1);
      await goBack();
      expect(state.steps).toBe(1);
      // Something goes on by itself: an import that ends, and shows its notebook.
      go(1);
      expect(depth()).toBe(0);
      touch();
      expect(depth()).toBe(1);
      await goBack();
      expect([state.behind, state.steps]).toEqual([0, 2]);
      touch();
    });
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
