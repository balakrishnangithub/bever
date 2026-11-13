import { getSchema } from '@tiptap/core';
import { describe, expect, it } from 'vitest';

import { createExtensions } from './extensions';
import { findMatches, findTextMatches } from './noteFind';

const schema = getSchema(createExtensions());

function documentWithText(text: string) {
  return schema.nodeFromJSON({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
}

describe('note content find', () => {
  it('maps all case-insensitive matches to ProseMirror positions', () => {
    const doc = documentWithText('Alpha beta ALPHA');
    expect(findTextMatches(doc, 'alpha')).toEqual([
      { from: 1, to: 6 },
      { from: 12, to: 17 },
    ]);
  });

  it('does not include titles or library interface text', () => {
    const doc = documentWithText('Only the note body');
    expect(findTextMatches(doc, 'Search notes')).toEqual([]);
    expect(findTextMatches(doc, 'note body')).toHaveLength(1);
  });

  it('supports multi-paragraph search and caps very large results', () => {
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one two' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'two three' }] },
      ],
    });
    expect(findTextMatches(doc, 'two')).toHaveLength(2);
    expect(findTextMatches(documentWithText('aaaa'), 'a', 2)).toHaveLength(2);
  });

  it('finds a word whatever its formatting, and several terms in reading order', () => {
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'A note', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'book and a footnote' },
          ],
        },
      ],
    });
    expect(findTextMatches(doc, 'notebook')).toEqual([{ from: 3, to: 11 }]);
    expect(
      findTextMatches(doc, [
        { text: 'foot', mode: 'prefix' },
        { text: 'note', mode: 'prefix' },
      ]),
    ).toEqual([
      { from: 3, to: 7 },
      { from: 18, to: 22 },
    ]);
  });

  it('finds in the text of pictures, in their place among the text', () => {
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'range one' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'enMedia', attrs: { hash: 'aa', type: 'image/png' } },
            { type: 'text', text: ' range two' },
            { type: 'enMedia', attrs: { hash: 'bb', type: 'image/png' } },
          ],
        },
      ],
    });
    const pictures = (hash: string) =>
      hash === 'aa' ? { xml: null, text: 'Domain and Range' } : { xml: null, text: 'Nothing here' };
    const matches = findMatches(doc, 'range', pictures);
    expect(matches.map((match) => [match.from, match.picture?.whole ?? null])).toEqual([
      [1, null],
      [12, true],
      [14, null],
    ]);
    // Without the pictures' text, only the note's own text is searched.
    expect(findMatches(doc, 'range')).toHaveLength(2);
    expect(findMatches(doc, 'domain', pictures)).toHaveLength(1);
  });
});
