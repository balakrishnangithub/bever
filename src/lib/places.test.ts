import { describe, expect, it } from 'vitest';

import { emptyFilter } from '../types';
import { amended, gone, PLACES_KEPT, refined, samePlace, viewOf, type Place, type Trail } from './places';

const place = (
  notebookId: string | null,
  noteId: string | null = null,
  more: Partial<Place> = {},
): Place => ({
  view: viewOf({ ...emptyFilter, notebookId }),
  noteId,
  screen: null,
  reading: false,
  refined: false,
  find: '',
  ...more,
});
/** A place as it is when its listing is searched for `query`. */
const searched = (from: Place, query: string): Place => ({ ...from, view: { ...from.view, query } });
const queries = (trail: Trail) => trail.places.map((item) => item.view.query);

describe('the trail of places', () => {
  it('does not count the order of the list or the page as part of a place', () => {
    const one = viewOf({ ...emptyFilter, sort: 'titleAsc', offset: 300 });
    expect(one).toEqual(viewOf(emptyFilter));
    expect(samePlace(place('a', 'n'), place('a', 'n'))).toBe(true);
    expect(samePlace(place('a', 'n'), place('a', 'm'))).toBe(false);
    expect(samePlace(place('a'), place('a', null, { screen: 'tags' }))).toBe(false);
    // A screen searched is another place than the screen whole.
    expect(
      samePlace(place('a', null, { screen: 'tags' }), place('a', null, { screen: 'tags', find: 'x' })),
    ).toBe(false);
    // How a place was left is not what place it is.
    expect(samePlace(place('a', 'n'), place('a', 'n', { reading: true, refined: true }))).toBe(true);
  });

  it('grows by the places gone to, and drops what lay ahead after going back', () => {
    let trail: Trail = { places: [place(null)], at: 0 };
    trail = gone(trail, place('a'));
    trail = gone(trail, place('a', 'note'));
    expect(trail.at).toBe(2);
    // Going where one is adds nothing; the place is as it was left.
    const again = gone(trail, place('a', 'note', { reading: true }));
    expect(again.places).toHaveLength(3);
    expect(again.places[2]?.reading).toBe(true);
    // Back by one, then somewhere else: the note that lay ahead is gone.
    trail = gone({ ...trail, at: 1 }, place('b'));
    expect(trail.places.map((item) => item.view.notebookId)).toEqual([null, 'a', 'b']);
    expect(trail.at).toBe(2);
  });

  it('changes the place one is at without adding one', () => {
    const trail: Trail = { places: [place(null), place('a')], at: 0 };
    const changed = amended(trail, searched(place(null), 'tea'));
    expect(changed.places).toHaveLength(2);
    expect(changed.places[0]?.view.query).toBe('tea');
    expect(changed.places[1]).toBe(trail.places[1]);
  });

  it('does not keep a place twice in a row', () => {
    // A note was opened and then deleted: where one is, is the list again.
    const trail: Trail = { places: [place('a'), place('a', 'note', { reading: true })], at: 1 };
    const after = amended(trail, place('a'));
    expect(after.places).toHaveLength(1);
    expect(after.at).toBe(0);
    // And a place that has become the one ahead of it takes its place.
    const ahead: Trail = { places: [place(null), place('a', 'note'), place('a')], at: 1 };
    const merged = amended(ahead, place('a'));
    expect(merged.places.map((item) => item.noteId)).toEqual([null, null]);
    expect(merged.at).toBe(1);
  });

  it('makes a step of a search, one for all that is typed, and goes back when it is taken away', () => {
    let trail: Trail = { places: [place(null), place('a')], at: 1 };
    for (const typed of ['t', 'te', 'tea']) trail = refined(trail, searched(place('a'), typed));
    expect(queries(trail)).toEqual(['', '', 'tea']);
    expect(trail.at).toBe(2);
    expect(trail.places[2]?.refined).toBe(true);
    // A filter added to the search changes the same step.
    const filtered = {
      ...searched(place('a'), 'tea'),
      view: { ...searched(place('a'), 'tea').view, contains: 'pdf' },
    };
    trail = refined(trail, filtered);
    expect(trail.places).toHaveLength(3);
    // Taking both away is going back to the notebook; the search stays ahead.
    trail = refined(trail, place('a'));
    expect([trail.at, trail.places.length]).toEqual([1, 3]);
    // Searching again from there is a new step, and what lay ahead is gone.
    trail = refined(trail, searched(place('a'), 'oat'));
    expect(queries(trail)).toEqual(['', '', 'oat']);
  });

  it('makes a step of changing a search that was gone to', () => {
    // A search kept among the shortcuts was opened: it is a place gone to.
    let trail: Trail = { places: [place(null), searched(place(null), 'tea')], at: 1 };
    trail = refined(trail, searched(place(null), 'tea pot'));
    expect(queries(trail)).toEqual(['', 'tea', 'tea pot']);
    // Clearing it from there goes back twice in one: to what was before both.
    trail = refined({ ...trail, at: 1 }, place(null));
    expect(trail.at).toBe(0);
  });

  it('keeps only so many places', () => {
    let trail: Trail = { places: [place(null)], at: 0 };
    for (let index = 0; index < PLACES_KEPT + 20; index += 1) trail = gone(trail, place(`n${index}`));
    expect(trail.places).toHaveLength(PLACES_KEPT);
    expect(trail.at).toBe(PLACES_KEPT - 1);
    expect(trail.places.at(-1)?.view.notebookId).toBe(`n${PLACES_KEPT + 19}`);
  });
});
