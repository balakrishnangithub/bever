/**
 * What lies over what, for going back: the last thing opened is the first
 * that Back closes. Back is Android's button or gesture, a mouse's or a
 * keyboard's key for it, or anything else that steps back in the window's
 * history.
 *
 * Two kinds of thing are kept here, in the order they were opened:
 *
 * - the layers of the application (the drawer, the open note in the phone
 *   layout, the settings, the screens of notebooks and of tags), of which
 *   the one opened last is the one showing;
 * - whatever else is opened over them: a dialog, a menu, a panel, a
 *   preview, an editor of a picture.
 *
 * Each has an entry in the window's history, so that a step back there
 * lands on the entry of what was under it, and the thing on top is closed:
 * one thing for one step. The other way round, a thing closed by its own
 * button has its entry taken out by a step back of our own. Such a step
 * arrives a moment after it was asked for; until then the history is left
 * alone, and what was opened or closed meanwhile is brought in line when it
 * has arrived.
 *
 * An entry is made only when the page has been touched since the last step
 * back that someone took. Android's web view honours the entries a page
 * makes in answer to a touch or a key, as many as it makes. One made after
 * Back with no touch in between it takes for a trap, and Back then passes
 * every entry of the page by and leaves the application; that was measured
 * on a phone. So a thing that is open without having been touched for (it
 * stayed open when Back asked it to close, or the application opened it by
 * itself) has no entry until the next touch. Back meanwhile still closes
 * it, as the topmost thing there is.
 */

interface LayerItem {
  kind: 'layer';
  name: string;
}
interface OverlayItem {
  kind: 'overlay';
  /**
   * Closes it, asked by Back. Answers false when it stays open: it has
   * something to finish first.
   */
  back: () => boolean | void;
}
type Item = LayerItem | OverlayItem;

/** What an entry of the history says of itself. */
interface BackState {
  /** The layer showing there. */
  bever?: string;
  /** How many things are open there, counted from the bottom. */
  depth?: number;
}

/** Longest a step back in the window's history is waited for. */
const BACK_LIMIT_MS = 1000;
/** What a person does to a page that counts as touching it. */
const TOUCHES = ['pointerup', 'touchend', 'mousedown', 'keydown'] as const;

const items: Item[] = [];
/** A layer that has no entry in the history: beside the others, not over them. */
let loose: string | null = null;
/** A step of our own in the history is on its way. */
let traversing = false;
let limit: number | undefined;
/** The page has been touched since someone last stepped back. */
let touched = false;
/** The depth the history was at when it was last looked at. */
let known = 0;
const listeners = new Set<() => void>();
let listening = false;

const state = () => (window.history.state as BackState | null) ?? {};
const depthThere = () => state().depth ?? 0;

/** The layer showing at a depth: the topmost at or under it. */
function layerAt(depth: number): string | undefined {
  for (let index = Math.min(depth, items.length) - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === 'layer') return item.name;
  }
  return undefined;
}

function tell() {
  for (const listener of listeners) listener();
}

/** Brings the history in line with what is open, unless a step is on its way. */
function reconcile() {
  if (traversing) return;
  const have = depthThere();
  const want = items.length;
  known = have;
  if (want < have) {
    traversing = true;
    window.clearTimeout(limit);
    // A step that never arrives is not waited for for ever.
    limit = window.setTimeout(() => {
      traversing = false;
      reconcile();
    }, BACK_LIMIT_MS);
    if (have - want === 1) window.history.back();
    else window.history.go(want - have);
    return;
  }
  // The entry one is on says which layer shows there.
  if (have > 0 && state().bever !== layerAt(have)) {
    window.history.replaceState({ ...state(), bever: layerAt(have), depth: have }, '');
  }
  // Entries are made in answer to a touch, and not otherwise.
  if (!touched) return;
  for (let depth = have + 1; depth <= want; depth += 1) {
    window.history.pushState({ ...state(), bever: layerAt(depth), depth }, '');
  }
  known = want;
}

function onHistory() {
  if (traversing) {
    // Our own step has arrived.
    traversing = false;
    window.clearTimeout(limit);
  } else if (depthThere() < known) {
    // Someone stepped back: the topmost thing is closed, and that one only.
    // From here on nothing is given an entry until the page is touched.
    touched = false;
    const top = items[items.length - 1];
    if (top?.kind === 'overlay') {
      let stays = false;
      try {
        stays = top.back() === false;
      } catch {
        // What cannot say it stays is taken to have gone.
      }
      // It may have taken itself out while it closed.
      if (!stays && items[items.length - 1] === top) items.pop();
    } else if (top) {
      items.pop();
    }
    tell();
  }
  reconcile();
}

function onTouch() {
  if (touched) return;
  touched = true;
  reconcile();
}

function listen() {
  if (listening) return;
  listening = true;
  known = depthThere();
  window.addEventListener('popstate', onHistory);
  for (const type of TOUCHES) window.addEventListener(type, onTouch, true);
}

/** The layer that is showing, or null. */
function layer(): string | null {
  return loose ?? layerAt(items.length) ?? null;
}

/**
 * Shows a layer. With `inHistory`, Back closes it; without, it is beside
 * what is there and nothing steps back to it.
 */
function openLayer(name: string, inHistory: boolean) {
  listen();
  if (!inHistory) {
    // What lay over everything makes way for it.
    for (let over = layerAt(items.length); over; over = layerAt(items.length)) closeLayer(over);
    loose = name;
    tell();
    return;
  }
  // A layer beside the others was the one showing until now; it is not
  // what comes back when this one is closed.
  loose = null;
  const top = items[items.length - 1];
  if (top?.kind === 'layer' && top.name === name) {
    tell();
    return;
  }
  // The drawer makes way for what was opened from it.
  if (top?.kind === 'layer' && top.name === 'sidebar') items.pop();
  items.push({ kind: 'layer', name });
  tell();
  reconcile();
}

/**
 * Closes a layer if it is the one on top, with whatever was opened over
 * it; a layer under another stays.
 */
function closeLayer(name: string) {
  let changed = false;
  if (loose === name) {
    loose = null;
    changed = true;
  }
  let at = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.kind === 'layer') {
      at = index;
      break;
    }
  }
  const found = items[at];
  if (found?.kind === 'layer' && found.name === name) {
    // What lies over it goes with it, the topmost first.
    const over = items.splice(at).slice(1).reverse();
    for (const item of over) {
      if (item.kind !== 'overlay') continue;
      try {
        item.back();
      } catch {
        // It is out of the list either way.
      }
    }
    changed = true;
  }
  if (!changed) return;
  tell();
  reconcile();
}

/** Something was opened over what is there. Back will ask it to close. */
function opened(back: () => boolean | void): object {
  listen();
  const item: OverlayItem = { kind: 'overlay', back };
  items.push(item);
  reconcile();
  return item;
}

/** It was closed, by Back or by anything else. */
function closed(item: object) {
  const at = items.indexOf(item as Item);
  if (at < 0) return;
  items.splice(at, 1);
  reconcile();
}

function subscribe(listener: () => void) {
  listen();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const backStack = { layer, openLayer, closeLayer, opened, closed, subscribe };
