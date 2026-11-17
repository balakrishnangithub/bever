import { useEffect, useRef } from 'react';

import { backStack } from './backStack';

/**
 * While `open`, going back closes this before anything that was there
 * before it: Android's Back, and whatever else steps back in the window's
 * history. `back` is what closes it. It answers false when the thing stays
 * open after all: it closed a part of itself (a menu in it), or it has
 * something to ask before it goes.
 *
 * Whatever opens over the page uses this, so that Back never passes a
 * dialog, a menu or a panel by and closes what is under it, or the
 * application with all of them still open.
 */
export function useBackCloses(open: boolean, back: () => boolean | void): void {
  const latest = useRef(back);
  useEffect(() => {
    latest.current = back;
  });
  useEffect(() => {
    if (!open) return undefined;
    const item = backStack.opened(() => latest.current());
    return () => backStack.closed(item);
  }, [open]);
}
