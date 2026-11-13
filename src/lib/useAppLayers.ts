import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * What lies over the list of notes: the drawer, the open note, and the
 * settings in the phone layout, and in every layout the screens that list
 * all notebooks and all tags.
 */
export type AppLayer = 'sidebar' | 'editor' | 'settings' | 'notebooks' | 'tags';

interface LayerHistoryState {
  bever?: AppLayer;
}

const isMobileLayout = () => window.matchMedia('(max-width: 760px)').matches;
const historyLayer = () => (window.history.state as LayerHistoryState | null)?.bever ?? null;
/** Longest a step back in the window's history is waited for. */
const BACK_LIMIT_MS = 1000;

/** Gives `layer` an entry in the window's history. */
function record(layer: AppLayer) {
  const current = historyLayer();
  if (current === layer) return;
  const state = { ...(window.history.state as LayerHistoryState | null), bever: layer };
  // The drawer makes way for what was opened from it.
  const replacesDrawer = layer !== 'sidebar' && current === 'sidebar';
  window.history[replacesDrawer ? 'replaceState' : 'pushState'](state, '');
}

/**
 * Which layer is showing. In the phone layout each layer is an entry in the
 * window's history, so that Android's Back closes it.
 *
 * A layer closes on screen at once; the step back in the history that goes
 * with it arrives a moment later. Until it has, the history is left alone:
 * a second close would step back twice, and a layer opened in the meantime
 * would be closed by the step when it arrived.
 */
export function useAppLayers() {
  const [layer, setLayer] = useState<AppLayer | null>(null);
  /** A step back of our own is on its way. */
  const leaving = useRef(false);
  /** The layer opened while that step was on its way. */
  const waiting = useRef<AppLayer | null>(null);
  const limit = useRef<number | undefined>(undefined);

  /** The step back has arrived at `landed`, or is not waited for any longer. */
  const settle = useCallback((landed?: AppLayer | null) => {
    leaving.current = false;
    window.clearTimeout(limit.current);
    const next = waiting.current;
    waiting.current = null;
    if (next) {
      record(next);
      setLayer(next);
    } else if (landed !== undefined) {
      setLayer(landed);
    }
  }, []);

  useEffect(() => {
    const onHistory = (event: PopStateEvent) =>
      settle((event.state as LayerHistoryState | null)?.bever ?? null);
    window.addEventListener('popstate', onHistory);
    return () => {
      window.removeEventListener('popstate', onHistory);
      window.clearTimeout(limit.current);
    };
  }, [settle]);

  const openLayer = useCallback((next: AppLayer) => {
    setLayer(next);
    if (!isMobileLayout()) return;
    if (leaving.current) waiting.current = next;
    else record(next);
  }, []);

  /** Closes `which` if it is the layer showing; any other layer stays. */
  const closeLayer = useCallback(
    (which: AppLayer) => {
      setLayer((current) => (current === which ? null : current));
      if (waiting.current === which) waiting.current = null;
      if (leaving.current || !isMobileLayout() || historyLayer() !== which) return;
      leaving.current = true;
      limit.current = window.setTimeout(() => settle(), BACK_LIMIT_MS);
      window.history.back();
    },
    [settle],
  );

  return { layer, openLayer, closeLayer };
}
