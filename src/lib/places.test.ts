import { describe, expect, it } from 'vitest';

import { emptyFilter } from '../types';
import { amended, gone, PLACES_KEPT, samePlace, viewOf, type Place, type Trail } from './places';

const place = (notebookId: string | null, noteId: string | null = null): Place => ({
  view: viewOf({ ...emptyFilter, notebookId }),
  noteId,
  screen: null,
});

describe('the trail of places', () => {
  it('does not count the order of the list or the page as part of a place', () => {
    const one = viewOf({ ...emptyFilter, sort: 'titleAsc', offset: 300 });
    expect(one).toEqual(viewOf(emptyFilter));
    expect(samePlace(place('a', 'n'), place('a', 'n'))).toBe(true);
    expect(samePlace(place('a', 'n'), place('a', 'm'))).toBe(false);
    expect(samePlace(place('a'), { ...place('a'), screen: 'tags' })).toBe(false);
  });

  it('grows by the places gone to, and drops what lay ahead after going back', () => {
    let trail: Trail = { places: [place(null)], at: 0 };
    trail = gone(trail, place('a'));
    trail = gone(trail, place('a', 'note'));
    expect(trail.at).toBe(2);
    // Going where one is adds nothing.
    expect(gone(trail, place('a', 'note'))).toBe(trail);
    // Back by one, then somewhere else: the note that lay ahead is gone.
    trail = gone({ ...trail, at: 1 }, place('b'));
    expect(trail.places.map((item) => item.view.notebookId)).toEqual([null, 'a', 'b']);
    expect(trail.at).toBe(2);
  });

  it('changes the place one is at without adding one', () => {
    const trail: Trail = { places: [place(null), place('a')], at: 0 };
    const searched = amended(trail, { ...place(null), view: viewOf({ ...emptyFilter, query: 'tea' }) });
    expect(searched.places).toHaveLength(2);
    expect(searched.places[0]?.view.query).toBe('tea');
    expect(searched.places[1]).toBe(trail.places[1]);
  });

  it('keeps only so many places', () => {
    let trail: Trail = { places: [place(null)], at: 0 };
    for (let index = 0; index < PLACES_KEPT + 20; index += 1) trail = gone(trail, place(`n${index}`));
    expect(trail.places).toHaveLength(PLACES_KEPT);
    expect(trail.at).toBe(PLACES_KEPT - 1);
    expect(trail.places.at(-1)?.view.notebookId).toBe(`n${PLACES_KEPT + 19}`);
  });
});
