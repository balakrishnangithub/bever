import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Note } from '../types';
import type { FindTerm } from './recognition';
import { RichEditor } from './RichEditor';

/**
 * A note that is a list to its very end, as the import from Evernote stores
 * one. The editor wants an empty line after a list, and adds it the first
 * time anything is asked of it: a search's marks, for one.
 */
const PAGE =
  '<ul><li><div>Oats</div></li><li><div>Barley</div></li></ul>' +
  '<div><br></div><hr><div><br></div>' +
  '<ul><li><div>Rye</div></li><li><div>Millet</div></li></ul>';

const NOTE: Note = {
  id: 'list-to-the-end',
  notebookId: 'inbox',
  title: 'Grains to try',
  contentHtml: PAGE,
  originalEnml: null,
  plainText: 'Oats Barley Rye Millet',
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  attributes: {},
  evernoteGuid: null,
  revision: 1,
  tags: [],
  resources: [],
};

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe('a note that is opened', () => {
  let host: HTMLElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  /** Opens the note and returns what the editor then reported of it, in order. */
  async function opened(highlight: FindTerm[], editable: boolean): Promise<string[]> {
    const reported: string[] = [];
    await act(async () => {
      root.render(
        <RichEditor
          note={NOTE}
          editable={editable}
          contentVersion={0}
          storedHtml={PAGE}
          highlight={highlight}
          onChange={(html) => reported.push(html)}
          onAttachFiles={() => Promise.resolve([])}
          onAttachBlob={() => Promise.resolve(null)}
          onThumbnail={() => undefined}
        />,
      );
      // The editor says that it is ready a moment after it is there.
      await pause(50);
    });
    return reported;
  }

  it('is not changed by the marks of the search it was opened from', async () => {
    const reported = await opened([{ text: 'barley', mode: 'prefix' }], true);
    // The marks are there, and so is the editor's empty line at the end:
    // the editor did change its document.
    expect(host.querySelectorAll('.note-find-match')).toHaveLength(1);
    expect(host.querySelector('.note-prose')?.lastElementChild?.tagName).toBe('P');
    // Whatever it reported, it reported the page that is stored.
    expect(reported.filter((html) => html !== PAGE)).toEqual([]);
  });

  it('is not changed by a search that marks nothing in it', async () => {
    const reported = await opened([{ text: 'grains', mode: 'prefix' }], true);
    expect(host.querySelectorAll('.note-find-match')).toHaveLength(0);
    expect(reported.filter((html) => html !== PAGE)).toEqual([]);
  });

  it('reports nothing at all while it is only read', async () => {
    const reported = await opened([{ text: 'barley', mode: 'prefix' }], false);
    expect(host.querySelectorAll('.note-find-match')).toHaveLength(1);
    expect(reported).toEqual([]);
  });

  it('is not changed when it is opened without a search', async () => {
    expect(await opened([], true)).toEqual([]);
  });
});
