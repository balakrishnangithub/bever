import type { NoteFilter } from '../types';

/** Which notes are listed: a filter without the order and the page. */
export type View = Omit<NoteFilter, 'sort' | 'limit' | 'offset'>;

/** A screen that lies over the list of notes and the open note. */
export type Screen = 'notebooks' | 'tags';

/**
 * Somewhere one has been in the library: what was listed, the note that was
 * open, and the screen that lay over them. Going back and forward moves
 * among these, as it does among the pages of a browser.
 */
export interface Place {
  view: View;
  noteId: string | null;
  screen: Screen | null;
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
  a.noteId === b.noteId && a.screen === b.screen && sameView(a.view, b.view);

export interface Trail {
  places: Place[];
  /** Which of the places one is at. */
  at: number;
}

/**
 * The trail after going on from where one is to `place`: what lay ahead is
 * dropped, as it is in a browser. Going to where one already is changes
 * nothing.
 */
export function gone(trail: Trail, place: Place): Trail {
  const current = trail.places[trail.at];
  if (current && samePlace(current, place)) return trail;
  const places = [...trail.places.slice(0, trail.at + 1), place].slice(-PLACES_KEPT);
  return { places, at: places.length - 1 };
}

/** The trail with the place one is at changed in itself: another search, another filter. */
export function amended(trail: Trail, place: Place): Trail {
  return { places: trail.places.map((item, index) => (index === trail.at ? place : item)), at: trail.at };
}
