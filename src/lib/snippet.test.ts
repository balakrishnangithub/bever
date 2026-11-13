import { describe, expect, it } from 'vitest';

import { SNIPPET_END, SNIPPET_START, snippetParts } from './snippet';

describe('search snippets', () => {
  it('splits a snippet into ordinary and matched runs', () => {
    const snippet = `…the ${SNIPPET_START}road${SNIPPET_END}map for ${SNIPPET_START}Road${SNIPPET_END}s`;
    expect(snippetParts(snippet)).toEqual([
      { text: '…the ', match: false },
      { text: 'road', match: true },
      { text: 'map for ', match: false },
      { text: 'Road', match: true },
      { text: 's', match: false },
    ]);
  });

  it('treats markup in a note as text, never as markup', () => {
    const parts = snippetParts(`<img src=x onerror=alert(1)> ${SNIPPET_START}<b>${SNIPPET_END}`);
    expect(parts).toEqual([
      { text: '<img src=x onerror=alert(1)> ', match: false },
      { text: '<b>', match: true },
    ]);
  });

  it('handles snippets without matches and unbalanced markers', () => {
    expect(snippetParts('plain text')).toEqual([{ text: 'plain text', match: false }]);
    expect(snippetParts('')).toEqual([]);
    expect(snippetParts(`cut ${SNIPPET_START}off`)).toEqual([
      { text: 'cut ', match: false },
      { text: 'off', match: true },
    ]);
  });
});
