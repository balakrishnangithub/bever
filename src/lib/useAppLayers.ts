import { useCallback, useSyncExternalStore } from 'react';

import { backStack } from './backStack';

/**
 * What lies over the library without being a place in it: the drawer in
 * the phone layout, and the settings. Where one is in the library (which
 * notes are listed, the open note, the screens of notebooks and of tags)
 * is the library's own to say; see `places`.
 */
export type AppLayer = 'sidebar' | 'settings';

const isMobileLayout = () => window.matchMedia('(max-width: 760px)').matches;
/** What lies over everything in every layout, and not only in the phone's. */
const OVER_EVERYTHING: AppLayer[] = ['settings'];

/**
 * Which layer is showing. A layer that lies over the others is closed by
 * going back, with whatever was opened over it first: see `backStack`,
 * which keeps the order and the window's history. In a wide window the
 * drawer is beside the list, not over it, and Back has nothing to do with
 * it.
 */
export function useAppLayers() {
  const layer = useSyncExternalStore(backStack.subscribe, backStack.layer) as AppLayer | null;
  const openLayer = useCallback(
    (next: AppLayer) => backStack.openLayer(next, isMobileLayout() || OVER_EVERYTHING.includes(next)),
    [],
  );
  /** Closes `which` if it is the layer showing; any other layer stays. */
  const closeLayer = useCallback((which: AppLayer) => backStack.closeLayer(which), []);
  return { layer, openLayer, closeLayer };
}
