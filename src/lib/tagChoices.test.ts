import { describe, expect, it } from 'vitest';

import type { Tag } from '../types';
import { tagChoices } from './tagChoices';

const tag = (name: string): Tag => ({
  id: `id-${name}`,
  name,
  parentId: null,
  color: null,
  createdAt: 0,
  updatedAt: 0,
});

const tags = ['zebra', 'Apple', 'budget', 'New Zealand', 'jazz', 'note-10', 'note-2', 'Élan'].map(tag);
const names = (choices: { tag: Tag }[]) => choices.map((choice) => choice.tag.name);
const onNotes = { 'id-zebra': 3, 'id-Apple': 1, 'id-jazz': 2, 'id-note-10': 1, 'id-note-2': 4 };

describe('the tags to narrow a listing by', () => {
  it('offers what the listed notes have, as names are read', () => {
    const choices = tagChoices(tags, [], onNotes, '', false);
    expect(names(choices.offered)).toEqual(['Apple', 'jazz', 'note-2', 'note-10', 'zebra']);
    expect(choices.offered.map((choice) => choice.count)).toEqual([1, 2, 4, 1, 3]);
    expect(choices.chosen).toEqual([]);
    expect(choices.elsewhere).toBe(0);
  });

  it('keeps the chosen tags apart, whatever is typed or listed', () => {
    const choices = tagChoices(tags, ['id-budget', 'id-Apple'], onNotes, 'z', false);
    expect(names(choices.chosen)).toEqual(['Apple', 'budget']);
    expect(choices.chosen.map((choice) => choice.count)).toEqual([1, 0]);
    expect(names(choices.offered)).toEqual(['zebra', 'jazz']);
  });

  it('puts names that begin with what was typed before those that only have it', () => {
    const choices = tagChoices(tags, [], { ...onNotes, 'id-New Zealand': 1 }, 'Z', false);
    // Begins with it; a later word begins with it; has it somewhere.
    expect(names(choices.offered)).toEqual(['zebra', 'New Zealand', 'jazz']);
  });

  it('says how many tags answer and are on none of the listed notes', () => {
    const choices = tagChoices(tags, [], onNotes, 'z', false);
    expect(names(choices.offered)).toEqual(['zebra', 'jazz']);
    expect(choices.elsewhere).toBe(1);
    // Nothing typed, nothing to say: the rest is simply not on these notes.
    expect(tagChoices(tags, [], onNotes, '  ', false).elsewhere).toBe(0);
  });

  it('offers every tag when all are asked for', () => {
    const choices = tagChoices(tags, [], onNotes, 'z', true);
    expect(names(choices.offered)).toEqual(['zebra', 'New Zealand', 'jazz']);
    expect(choices.offered.map((choice) => choice.count)).toEqual([3, 0, 2]);
    expect(choices.elsewhere).toBe(0);
    expect(tagChoices(tags, [], {}, '', true).offered).toHaveLength(tags.length);
  });

  it('finds a name without regard to case or accents', () => {
    expect(names(tagChoices(tags, [], {}, 'elan', true).offered)).toEqual(['Élan']);
    expect(names(tagChoices(tags, [], {}, 'ÉLAN', true).offered)).toEqual(['Élan']);
    expect(names(tagChoices(tags, [], {}, 'APP', true).offered)).toEqual(['Apple']);
    expect(tagChoices(tags, [], {}, 'nothing', true).offered).toEqual([]);
  });
});
