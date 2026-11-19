import type { NoteFilter } from '../types';

/** Which notes are listed: a filter without the order and the page. */
export type View = Omit<NoteFilter, 'sort' | 'limit' | 'offset'>;

/** A screen that lies over the list of notes and the open note. */
export type Screen = 'notebooks' | 'tags';

/**
 * Somewhere one has been in the library: what was listed, the note that was
 * open, and the screen that lay over them. Going back and forward moves
 * among these, as it does among the pages of a browser.
 *
 * What makes a place another place is what is listed, the open note, the
 * screen and what the screen is searched for. The rest is how the place was
 * left, and comes back with it.
 */
export interface Place {
  view: View;
  noteId: string | null;
  screen: Screen | null;
  /**
   * The open note is in front of the list, where a window has room for one
   * of the two only. In a wide window it says nothing that can be seen.
   */
  reading: boolean;
  /**
   * The listing is one that was there before, searched or filtered where it
   * stood. Searching or filtering it further changes this place; doing so
   * to a listing that was gone to makes a new one. See `refined`.
   */
  refined: boolean;
  /** What the screen's own list is searched for. */
  find: string;
}

/** Places remembered; the earliest make way for new ones. */
export const PLACES_KEPT = 100;

export const viewOf = (filter: NoteFilter): View => ({
  query: filter.query,
  notebookId: filter.notebookId,
  stackId: filter.stackId,
  tagIds: [...filter.tagIds],
  includeTrash: filter.includeTrash,
  trashOnly: filter.trashOnly,
  createdFrom: filter.createdFrom,
  createdTo: filter.createdTo,
  updatedFrom: filter.updatedFrom,
  updatedTo: filter.updatedTo,
  contains: filter.contains,
});

// Both are made by `viewOf`, so their fields are in the same order.
export const sameView = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b);

export const samePlace = (a: Place, b: Place) =>
  a.noteId === b.noteId && a.screen === b.screen && a.find === b.find && sameView(a.view, b.view);

export interface Trail {
  places: Place[];
  /** Which of the places one is at. */
  at: number;
}

/**
 * The trail after going on from where one is to `place`: what lay ahead is
 * dropped, as it is in a browser. Going to where one already is adds
 * nothing; the place is then as `place` says it was left.
 */
export function gone(trail: Trail, place: Place): Trail {
  const current = trail.places[trail.at];
  if (current && samePlace(current, place)) {
    return amended(trail, { ...place, refined: current.refined });
  }
  const places = [...trail.places.slice(0, trail.at + 1), place].slice(-PLACES_KEPT);
  return { places, at: places.length - 1 };
}

/**
 * The trail with the place one is at changed in itself: another search,
 * another filter, its note gone. A place that has become the one before it,
 * or the one after it, is that place and not a second one beside it: a step
 * between the two would be a step that shows nothing.
 */
export function amended(trail: Trail, place: Place): Trail {
  const places = trail.places.map((item, index) => (index === trail.at ? place : item));
  let at = trail.at;
  const before = places[at - 1];
  if (before && samePlace(before, place)) {
    places.splice(at, 1);
    at -= 1;
  }
  const here = places[at];
  const after = places[at + 1];
  if (here && after && samePlace(here, after)) places.splice(at + 1, 1);
  return { places, at };
}

/**
 * The trail after the listing was searched or filtered where it stands, to
 * what `place` says. The first such change of a listing is a step on from
 * it, so that a step back shows the listing whole again; what is typed or
 * chosen after that changes the step that was made, and is not a step for
 * every letter. Taking the change back is going back to the listing, with
 * the search left ahead to return to.
 */
export function refined(trail: Trail, place: Place): Trail {
  const current = trail.places[trail.at];
  if (!current || samePlace(current, place)) return trail;
  const before = trail.places[trail.at - 1];
  if (before && samePlace(before, place)) return { places: trail.places, at: trail.at - 1 };
  if (current.refined) return amended(trail, { ...place, refined: true });
  return gone(trail, { ...place, refined: true });
}
