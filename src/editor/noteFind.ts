import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Editor } from '@tiptap/react';

import {
  findInPicture,
  parseRecognition,
  termPattern,
  type FindTerm,
  type PictureMatch,
} from './recognition';

const MAX_MATCHES = 2000;
const key = new PluginKey<FindState>('beverFind');

export interface FindMatch {
  from: number;
  to: number;
  /** Set when the match is a picture: what was found in its text. */
  picture?: PictureMatch;
}

/** The recognised text of the picture with this hash, if it has any. */
export type PictureTexts = (hash: string) => { xml: string | null; text: string | null } | null;

export interface FindState {
  terms: FindTerm[];
  /** The match that is stepped to, or -1 when matches are only marked. */
  active: number;
  matches: FindMatch[];
  pictures: PictureTexts | null;
  decorations: DecorationSet;
}

interface FindUpdate {
  terms: FindTerm[];
  active: number;
  pictures: PictureTexts | null;
}

const asTerms = (query: string | FindTerm[]): FindTerm[] =>
  typeof query === 'string' ? (query.trim() ? [{ text: query.trim(), mode: 'plain' }] : []) : query;

/**
 * The places in a note's content where `query` is found, in reading order:
 * in its text, and in the text recognised in its pictures when `pictures`
 * can tell it. Titles, sidebars, and search results are never included.
 */
export function findMatches(
  doc: ProseMirrorNode,
  query: string | FindTerm[],
  pictures: PictureTexts | null = null,
  limit = MAX_MATCHES,
): FindMatch[] {
  const patterns = asTerms(query)
    .map(termPattern)
    .filter((pattern) => pattern !== null);
  if (!patterns.length) return [];
  const matches: FindMatch[] = [];

  const inPicture = (node: ProseMirrorNode, position: number) => {
    if (!pictures || node.type.name !== 'enMedia') return;
    const known = pictures(String(node.attrs.hash ?? ''));
    if (!known) return;
    const picture = findInPicture(parseRecognition(known.xml), known.text, patterns);
    if (picture) matches.push({ from: position, to: position + node.nodeSize, picture });
  };

  doc.descendants((node, position) => {
    if (matches.length >= limit) return false;
    if (!node.isTextblock) {
      inPicture(node, position);
      return true;
    }
    // A block's text is one text, however it is formatted: a word that is
    // half bold is still that word. Anything else in the line ends words.
    let text = '';
    const places: number[] = [];
    const found: FindMatch[] = [];
    node.forEach((child, offset) => {
      const start = position + 1 + offset;
      if (child.isText && child.text) {
        for (let index = 0; index < child.text.length; index += 1) places.push(start + index);
        text += child.text;
      } else {
        for (let index = 0; index < child.nodeSize; index += 1) places.push(start + index);
        text += '\n'.repeat(child.nodeSize);
        inPicture(child, start);
      }
    });
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        if (!match[0]) continue;
        const from = places[match.index];
        const last = places[match.index + match[0].length - 1];
        if (from !== undefined && last !== undefined) found.push({ from, to: last + 1 });
      }
    }
    // Pictures stand in `matches` already; put the line's text among them.
    const start = matches.findIndex((match) => match.from > position);
    const line = [...(start < 0 ? [] : matches.splice(start)), ...found].sort(
      (a, b) => a.from - b.from || a.to - b.to,
    );
    // Two terms may find the same text; the first one has it.
    let end = -1;
    for (const match of line) {
      if (match.from < end) continue;
      end = match.to;
      matches.push(match);
    }
    return false;
  });
  return matches.slice(0, limit);
}

/** Text matches only; see {@link findMatches}. */
export function findTextMatches(doc: ProseMirrorNode, query: string | FindTerm[], limit = MAX_MATCHES) {
  return findMatches(doc, query, null, limit);
}

function createState(doc: ProseMirrorNode, update: FindUpdate): FindState {
  const matches = findMatches(doc, update.terms, update.pictures);
  const active =
    update.active < 0 || !matches.length
      ? -1
      : ((update.active % matches.length) + matches.length) % matches.length;
  const decorations = matches.map((match, index) => {
    const attributes = {
      class: `${match.picture ? 'note-find-picture' : 'note-find-match'}${index === active ? ' active' : ''}`,
      'data-find-match': String(index),
    };
    return match.picture
      ? Decoration.node(match.from, match.to, attributes, { found: match.picture, active: index === active })
      : Decoration.inline(match.from, match.to, attributes);
  });
  return { ...update, active, matches, decorations: DecorationSet.create(doc, decorations) };
}

export const NoteFindExtension = Extension.create({
  name: 'beverFind',
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key,
        state: {
          init: (_, { doc }) => createState(doc, { terms: [], active: -1, pictures: null }),
          apply(transaction, previous) {
            const update = transaction.getMeta(key) as FindUpdate | undefined;
            if (update) return createState(transaction.doc, update);
            if (!transaction.docChanged || !previous.terms.length) return previous;
            // What is typed may be a match, or end one.
            return createState(transaction.doc, previous);
          },
        },
        props: {
          decorations(state) {
            return key.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

/**
 * Marks what `query` finds in the note. With `active` at 0 or more that
 * match is shown as the current one and scrolled to; with -1 the matches are
 * only marked.
 */
export function updateNoteFind(
  editor: Editor,
  query: string | FindTerm[],
  active = 0,
  pictures: PictureTexts | null = null,
) {
  const terms = asTerms(query);
  // Nothing to look for, and nothing marked: nothing to do.
  if (!terms.length && !key.getState(editor.state)?.terms.length) return key.getState(editor.state);
  editor.view.dispatch(editor.state.tr.setMeta(key, { terms, active, pictures }));
  const state = key.getState(editor.state);
  if (state && state.active >= 0) {
    const element = editor.view.dom.querySelector(`[data-find-match="${state.active}"]`);
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  return state;
}

export function noteFindState(editor: Editor): FindState | undefined {
  return key.getState(editor.state);
}

/** What a picture's node view is told about a search: see `Decoration.node` above. */
export function pictureFound(
  decorations: readonly { spec?: unknown }[],
): { found: PictureMatch; active: boolean } | null {
  for (const decoration of decorations) {
    const spec = decoration.spec as { found?: PictureMatch; active?: boolean } | undefined;
    if (spec?.found) return { found: spec.found, active: spec.active === true };
  }
  return null;
}
