import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppLayers } from './useAppLayers';

type Layers = ReturnType<typeof useAppLayers>;
let layers: Layers;
/** Hands the hook's latest value to the test. */
function Probe({ seen }: { seen: (value: Layers) => void }) {
  const value = useAppLayers();
  useEffect(() => seen(value));
  return null;
}

const historyLayer = () => (window.history.state as { bever?: string } | null)?.bever ?? null;
/** Waits for the step back that is on its way. */
const arrival = () =>
  act(
    () =>
      new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true })),
  );

describe('layers of the phone layout', () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root.render(
        createElement(Probe, {
          seen: (value) => {
            layers = value;
          },
        }),
      ),
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it('closes a layer at once and steps back only once, however often it is asked to', async () => {
    act(() => layers.openLayer('sidebar'));
    expect(layers.layer).toBe('sidebar');
    expect(historyLayer()).toBe('sidebar');

    const back = vi.spyOn(window.history, 'back');
    act(() => {
      layers.closeLayer('sidebar');
      layers.closeLayer('sidebar');
    });
    // Closed before the step back has arrived.
    expect(layers.layer).toBeNull();
    expect(back).toHaveBeenCalledTimes(1);
    await arrival();
    expect(layers.layer).toBeNull();
    expect(historyLayer()).toBeNull();
  });

  it('keeps what was opened from the drawer when the drawer is then closed', async () => {
    act(() => layers.openLayer('sidebar'));
    const entries = window.history.length;
    const back = vi.spyOn(window.history, 'back');
    act(() => {
      layers.openLayer('editor');
      layers.closeLayer('sidebar');
    });
    expect(layers.layer).toBe('editor');
    // The note took the drawer's entry; nothing was stepped back.
    expect(historyLayer()).toBe('editor');
    expect(window.history.length).toBe(entries);
    expect(back).not.toHaveBeenCalled();

    act(() => layers.closeLayer('editor'));
    await arrival();
    expect(layers.layer).toBeNull();
  });

  it('keeps a layer opened while a step back is on its way', async () => {
    act(() => layers.openLayer('sidebar'));
    act(() => {
      layers.closeLayer('sidebar');
      layers.openLayer('editor');
    });
    expect(layers.layer).toBe('editor');
    await arrival();
    expect(layers.layer).toBe('editor');
    expect(historyLayer()).toBe('editor');

    act(() => layers.closeLayer('editor'));
    await arrival();
    expect(layers.layer).toBeNull();
    expect(historyLayer()).toBeNull();
  });

  it('does not bring back a layer that was opened and closed while a step back was on its way', async () => {
    act(() => layers.openLayer('sidebar'));
    act(() => {
      layers.closeLayer('sidebar');
      layers.openLayer('settings');
      layers.closeLayer('settings');
    });
    expect(layers.layer).toBeNull();
    await arrival();
    expect(layers.layer).toBeNull();
    expect(historyLayer()).toBeNull();
  });

  it('closes the layer when Back is pressed', async () => {
    act(() => layers.openLayer('settings'));
    expect(layers.layer).toBe('settings');
    window.history.back();
    await arrival();
    expect(layers.layer).toBeNull();
  });
});
