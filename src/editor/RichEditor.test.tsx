import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { forgetLinkTitles, learnLinkTitles } from '../lib/noteLinks';
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
  async function opened(highlight: FindTerm[], editable: boolean, page = PAGE): Promise<string[]> {
    const reported: string[] = [];
    await act(async () => {
      root.render(
        <RichEditor
          note={{ ...NOTE, contentHtml: page }}
          editable={editable}
          contentVersion={0}
          storedHtml={page}
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

  describe('with a link that says only the address of a note', () => {
    const ADDRESS =
      'evernote:///view/123456/s12/0a1b2c3d-0000-4000-8000-00000000000a/0a1b2c3d-0000-4000-8000-00000000000a';
    // The demonstration library has the note this leads to, "Welcome to Bever".
    const LINKED =
      '<div>Before.</div>' +
      `<div>See <a href="bever://note/welcome" rev="{&quot;isCached&quot;:false}">${ADDRESS}</a> first.</div>` +
      '<div>After.</div>';
    const editorOf = () => (host.querySelector('.note-prose') as unknown as { editor: Editor }).editor;

    beforeEach(async () => {
      forgetLinkTitles();
      await learnLinkTitles(LINKED);
    });

    it('shows the link by the title of its note, and is not changed by that', async () => {
      const reported = await opened([], true, LINKED);
      const link = host.querySelector('.note-prose a');
      expect(link?.textContent).toBe('Welcome to Bever');
      expect(link?.getAttribute('href')).toBe('bever://note/welcome');
      expect(host.querySelector('.note-prose')?.textContent).not.toContain('evernote:');
      expect(reported).toEqual([]);
    });

    it('is shown so while it is only read, too', async () => {
      const reported = await opened([], false, LINKED);
      expect(host.querySelector('.note-prose a')?.textContent).toBe('Welcome to Bever');
      expect(reported).toEqual([]);
    });

    it('goes on saying its address in what is stored when the note is written in', async () => {
      const reported = await opened([], true, LINKED);
      await act(async () => {
        editorOf().commands.insertContentAt(editorOf().state.doc.content.size, '<p>More.</p>');
        await pause(10);
      });
      const last = reported.at(-1) ?? '';
      expect(last).toContain('More.');
      expect(last).toContain(`>${ADDRESS}</a>`);
      expect(last).not.toContain('Welcome to Bever');
      expect(last).not.toContain('data-note');
      // The page still shows the title.
      expect(host.querySelector('.note-prose a')?.textContent).toBe('Welcome to Bever');
      // And taking the writing back leaves the note as it is stored.
      await act(async () => {
        editorOf().commands.undo();
        await pause(10);
      });
      expect(reported.at(-1)).toBe(LINKED);
    });

    it('stores what the link is made to say by hand', async () => {
      const reported = await opened([], true, LINKED);
      await act(async () => {
        const editor = editorOf();
        let end = 0;
        editor.state.doc.descendants((node, position) => {
          if (node.isText && node.marks.some((mark) => mark.type.name === 'link'))
            end = position + node.nodeSize;
        });
        editor.commands.insertContentAt(end, ' and all');
        await pause(10);
      });
      const last = reported.at(-1) ?? '';
      expect(last).toContain('Welcome to Bever and all');
      expect(last).not.toContain('evernote:');
      expect(last).not.toContain('data-note');
    });
  });
});
