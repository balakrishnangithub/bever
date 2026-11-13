import { describe, expect, it } from 'vitest';

import { searchTerms } from '../lib/searchTerms';
import { findInPicture, parseRecognition, termPattern, type FindTerm } from './recognition';

const RECOGNITION = `<?xml version="1.0" encoding="UTF-8"?>
<recoIndex docType="unknown" objType="image" objID="0123" engineVersion="7.0.24.1" recoType="service" lang="en" objWidth="400" objHeight="200">
<item x="40" y="20" w="80" h="20"><t w="90">Domain</t><t w="31">Dormain</t></item>
<item x="130" y="20" w="40" h="20"><t w="88">and</t></item>
<item x="180" y="20" w="100" h="20"><t w="85">Range</t><t w="40">Flange</t></item>
<item x="40" y="100" w="60" h="40"><t w="70">quiz</t></item>
</recoIndex>`;

const patterns = (...terms: FindTerm[]) => terms.map(termPattern).filter((pattern) => pattern !== null);
const plain = (text: string): FindTerm => ({ text, mode: 'plain' });

describe('the text recognised in a picture', () => {
  it('is read with each word’s place as a part of the picture', () => {
    const recognition = parseRecognition(RECOGNITION);
    expect(recognition?.words).toHaveLength(4);
    expect(recognition?.words[0]).toEqual({
      x: 0.1,
      y: 0.1,
      w: 0.2,
      h: 0.1,
      readings: ['Domain', 'Dormain'],
    });
  });

  it('is nothing when it is missing, damaged, or without places', () => {
    expect(parseRecognition(null)).toBeNull();
    expect(parseRecognition('<recoIndex><item><t>text</t></item></recoIndex>')).toBeNull();
    expect(parseRecognition('not xml at all <')).toBeNull();
  });

  it('measures a picture by its words when its size is not given', () => {
    const recognition = parseRecognition(
      '<recoIndex><item x="0" y="0" w="50" h="10"><t w="80">one</t></item><item x="50" y="10" w="50" h="10"><t w="80">two</t></item></recoIndex>',
    );
    expect(recognition?.words[1]).toMatchObject({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });
});

describe('finding in a picture', () => {
  const recognition = parseRecognition(RECOGNITION);

  it('gives the places of the words that match', () => {
    expect(findInPicture(recognition, null, patterns(plain('range')))).toEqual({
      boxes: [{ x: 0.45, y: 0.1, w: 0.25, h: 0.1 }],
      whole: false,
    });
    expect(findInPicture(recognition, null, patterns(plain('nothing')))).toBeNull();
  });

  it('follows a phrase over several words', () => {
    const found = findInPicture(recognition, null, patterns(plain('domain and range')));
    expect(found?.boxes).toHaveLength(3);
    expect(findInPicture(recognition, null, patterns(plain('and quiz')))?.boxes).toBeUndefined();
  });

  it('matches by a less likely reading too', () => {
    expect(findInPicture(recognition, null, patterns(plain('flange')))?.boxes).toHaveLength(1);
  });

  it('marks the whole picture when only its text is known', () => {
    expect(findInPicture(null, 'Domain and Range quiz', patterns(plain('quiz')))).toEqual({
      boxes: [],
      whole: true,
    });
    expect(findInPicture(null, 'Domain and Range', patterns(plain('quiz')))).toBeNull();
    expect(findInPicture(null, null, patterns(plain('quiz')))).toBeNull();
  });

  it('finds several terms at once', () => {
    const found = findInPicture(recognition, null, patterns(plain('quiz'), plain('domain')));
    expect(found?.boxes.map((box) => box.y)).toEqual([0.1, 0.5]);
  });
});

describe('what a search of the library shows in a note', () => {
  it('is its words and phrases, not its operators or what it excludes', () => {
    expect(searchTerms('unity tag:course -draft "game object" created:day-7 intitle:lesson')).toEqual([
      { text: 'unity', mode: 'prefix' },
      { text: 'game object', mode: 'words' },
    ]);
    expect(searchTerms('any: one two')).toEqual([
      { text: 'one', mode: 'prefix' },
      { text: 'two', mode: 'prefix' },
    ]);
    expect(searchTerms('')).toEqual([]);
    expect(searchTerms('& - tag:*')).toEqual([]);
  });

  it('keeps text with a colon that is not an operator, and a term once', () => {
    expect(searchTerms('10:30 Unity unity wild*')).toEqual([
      { text: '10:30', mode: 'prefix' },
      { text: 'Unity', mode: 'prefix' },
      { text: 'wild', mode: 'prefix' },
    ]);
  });

  it('matches words as the library’s index does', () => {
    const matches = (term: FindTerm, text: string) => [...text.matchAll(termPattern(term)!)].map((m) => m[0]);
    // A word the term begins, but not one it is merely inside of.
    expect(matches({ text: 'note', mode: 'prefix' }, 'Notes, footnote, NOTEBOOK')).toEqual(['Note', 'NOTE']);
    // A quoted term is whole words.
    expect(matches({ text: 'note', mode: 'words' }, 'note notes')).toEqual(['note']);
    // Whatever separates words is the same to the index.
    expect(matches({ text: 'game object', mode: 'words' }, 'a game-object, a game  object')).toEqual([
      'game-object',
      'game  object',
    ]);
    expect(termPattern({ text: '&', mode: 'prefix' })).toBeNull();
    // Find takes text as it is written, signs and all.
    expect(matches(plain('a.b'), 'a.b axb')).toEqual(['a.b']);
  });
});
