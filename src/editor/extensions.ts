import { Extension, Node, mergeAttributes, type NodeViewRenderer } from '@tiptap/core';
import CodeBlock from '@tiptap/extension-code-block';
import Color from '@tiptap/extension-color';
import FontFamily from '@tiptap/extension-font-family';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Paragraph from '@tiptap/extension-paragraph';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { Table } from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import Underline from '@tiptap/extension-underline';
import { Fragment } from '@tiptap/pm/model';
import {
  type EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { ReactNodeViewRenderer } from '@tiptap/react';

import { AttachmentView, EncryptedBlockView, ImageView, TodoView } from './nodeViews';
import { holdsLayout } from './clipSanitizer';
import { NoteFindExtension } from './noteFind';
import { WebClipView } from './WebClipView';

export const FontSize = Extension.create({
  name: 'fontSize',
  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => element.style.fontSize || null,
            renderHTML: (attributes) =>
              attributes.fontSize ? { style: `font-size: ${attributes.fontSize}` } : {},
          },
        },
      },
    ];
  },
});

export const Indent = Extension.create({
  name: 'indent',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element) => {
              const margin = Number.parseInt(
                element.style.marginLeft || element.style.paddingLeft || '0',
                10,
              );
              return Number.isFinite(margin) ? Math.round(margin / 32) : 0;
            },
            renderHTML: (attributes) =>
              Number(attributes.indent) > 0
                ? { style: `margin-left: ${Number(attributes.indent) * 2}em` }
                : {},
          },
        },
      },
    ];
  },
});

/** Elements that are blocks of their own inside a `div`. */
const BLOCK_CHILDREN = [
  'div',
  'p',
  'ul',
  'ol',
  'table',
  'blockquote',
  'pre',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]
  .map((tag) => `:scope > ${tag}`)
  .join(', ');

/**
 * Evernote writes a line of text as a `div`. A `div` that only wraps other
 * blocks is not a line: read as a paragraph, it would leave an empty
 * paragraph in front of its content, one for every level of wrapping.
 */
const EvernoteParagraph = Paragraph.extend({
  parseHTML() {
    return [
      { tag: 'p' },
      {
        tag: 'div:not([data-type])',
        getAttrs: (element) => (element.querySelector(BLOCK_CHILDREN) ? false : null),
      },
      // Evernote writes an empty line as `<div><br/></div>`. Read as a line
      // that holds a line break, it would be shown two lines tall.
      {
        tag: 'br',
        priority: 60,
        ignore: true,
        getAttrs: (element) => {
          const line = element.parentElement;
          const alone =
            line !== null &&
            /^(div|p)$/i.test(line.tagName) &&
            [...line.childNodes].every((node) => node === element || !node.textContent?.trim());
          return alone ? null : false;
        },
      },
      // What the note keeps but does not show, such as Evernote's own
      // bookkeeping element, is not a line of the note either.
      {
        tag: '[style]',
        priority: 90,
        ignore: true,
        getAttrs: (element) =>
          /(^|;)\s*display\s*:\s*none\b/i.test(element.getAttribute('style') ?? '') ? null : false,
      },
    ];
  },
});

const hasStyle = (element: HTMLElement, pattern: RegExp) => pattern.test(element.getAttribute('style') ?? '');

/**
 * Evernote writes a highlight as a styled span,
 * `<span style="--en-highlight:yellow;background-color: #ffef9e;">`.
 * Only spans carrying that marker count: web clippings are full of spans
 * with ordinary background colours that are not highlights.
 */
const EvernoteHighlight = Highlight.extend({
  parseHTML() {
    return [
      { tag: 'mark' },
      {
        tag: 'span',
        // The same span may also carry a text colour or font, read by other marks.
        consuming: false,
        getAttrs: (element) => (hasStyle(element, /--en-highlight\s*:/) ? null : false),
      },
    ];
  },
});

/**
 * Evernote writes a code block as a div marked `--en-codeblock:true` with one
 * inner div per line. It becomes an ordinary code block with those lines.
 */
const EvernoteCodeBlock = CodeBlock.extend({
  parseHTML() {
    return [
      { tag: 'pre', preserveWhitespace: 'full' },
      {
        tag: 'div',
        // Ahead of the rule that reads every other div as a paragraph.
        priority: 60,
        preserveWhitespace: 'full',
        getAttrs: (element) => (hasStyle(element, /--en-codeblock\s*:\s*true/) ? null : false),
        getContent: (node, schema) => {
          const element = node as HTMLElement;
          const lines = element.children.length
            ? [...element.children].map((line) => line.textContent ?? '')
            : [element.textContent ?? ''];
          const text = lines.join('\n');
          return text ? Fragment.from(schema.text(text)) : Fragment.empty;
        },
      },
    ];
  },
});

/** Reads a column width the editor wrote, or one Evernote wrote as CSS. */
const columnWidth = (element: HTMLElement) => {
  const written = element.getAttribute('colwidth');
  if (written) return written.split(',').map((width) => Number.parseInt(width, 10));
  const styled = Number.parseInt(element.style.width, 10);
  return Number.isFinite(styled) && styled > 0 ? [styled] : null;
};

const widthAware = {
  addAttributes(this: { parent?: () => Record<string, unknown> }) {
    return {
      ...this.parent?.(),
      colwidth: { default: null, parseHTML: columnWidth },
    };
  },
};

export const EnMedia = Node.create({
  name: 'enMedia',
  inline: true,
  group: 'inline',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      hash: { default: '', parseHTML: (element) => element.getAttribute('hash') },
      type: { default: 'application/octet-stream', parseHTML: (element) => element.getAttribute('type') },
      width: { default: null, parseHTML: (element) => element.getAttribute('width') },
      height: { default: null, parseHTML: (element) => element.getAttribute('height') },
      style: { default: null, parseHTML: (element) => element.getAttribute('style') },
      title: { default: null, parseHTML: (element) => element.getAttribute('title') },
      alt: { default: null, parseHTML: (element) => element.getAttribute('alt') },
    };
  },
  parseHTML() {
    return [{ tag: 'en-media' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['en-media', mergeAttributes(HTMLAttributes)];
  },
  addNodeView() {
    return ReactNodeViewRenderer(AttachmentView, {
      // A picture shows what a search found in it, which reaches it as a
      // decoration: it is drawn again when its decorations change, and not
      // only when the node itself does.
      update: ({ oldNode, newNode, oldDecorations, newDecorations, updateProps }) => {
        const same =
          oldNode === newNode &&
          oldDecorations.length === newDecorations.length &&
          oldDecorations.every((decoration, index) => decoration === newDecorations[index]);
        if (!same) updateProps();
        return true;
      },
    });
  },
});

export const EnTodo = Node.create({
  name: 'enTodo',
  inline: true,
  group: 'inline',
  atom: true,
  addAttributes() {
    return {
      checked: {
        default: 'false',
        parseHTML: (element) => element.getAttribute('checked') ?? 'false',
      },
    };
  },
  parseHTML() {
    return [{ tag: 'en-todo' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['en-todo', mergeAttributes(HTMLAttributes)];
  },
  addNodeView() {
    return ReactNodeViewRenderer(TodoView);
  },
});

export const EnCrypt = Node.create({
  name: 'enCrypt',
  inline: true,
  group: 'inline',
  atom: true,
  addAttributes() {
    return {
      hint: { default: null, parseHTML: (element) => element.getAttribute('hint') },
      cipher: { default: null, parseHTML: (element) => element.getAttribute('cipher') },
      length: { default: null, parseHTML: (element) => element.getAttribute('length') },
      payload: {
        default: '',
        parseHTML: (element) => element.textContent ?? '',
        renderHTML: () => ({}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'en-crypt' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['en-crypt', mergeAttributes(HTMLAttributes), String(node.attrs.payload ?? '')];
  },
  addNodeView() {
    return ReactNodeViewRenderer(EncryptedBlockView);
  },
});

/**
 * A node drawn as an empty element, for the moments React is not there to
 * draw it.
 *
 * Images and clippings are drawn by React components that decide what may be
 * requested from the web. ProseMirror falls back to a node's stored markup
 * whenever such a component is missing: before the editor is on the page,
 * and once more while it is being taken off it, when TipTap removes the
 * React views. That markup is real `<img>` elements in the page, which the
 * browser fetches at once. Every note with an image on the web would request
 * it each time the note is closed. The stand-in requests nothing.
 */
const standIn = (tag: 'span' | 'div') => () => ({ dom: document.createElement(tag) });

/** The React view of a node, or its stand-in while React cannot draw it. */
function guardedView(react: NodeViewRenderer, tag: 'span' | 'div'): NodeViewRenderer {
  return (props) => {
    const view = react(props);
    return 'dom' in view ? view : standIn(tag)();
  };
}

/**
 * Stand-ins for when TipTap has removed its own views altogether. Views a
 * plugin provides are the ones ProseMirror turns to next.
 */
const StandInViews = Extension.create({
  name: 'standInViews',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('standInViews'),
        props: { nodeViews: { image: standIn('span'), webClip: standIn('div') } },
      }),
    ];
  },
});

/**
 * A transaction in which an empty paragraph starts at `position`: the one
 * already there, or a new one.
 */
function openParagraphAt(state: EditorState, position: number): Transaction | null {
  const paragraph = state.schema.nodes.paragraph;
  if (!paragraph) return null;
  const next = state.doc.nodeAt(position);
  const transaction = state.tr;
  if (!(next?.type === paragraph && next.content.size === 0)) {
    transaction.insert(position, paragraph.create());
  }
  return transaction;
}

/** Parsed clipping markup, by its text: serializing a note asks for it often. */
const parsedClips = new Map<string, Element | null>();

function clipElement(html: string): Element | null {
  let parsed = parsedClips.get(html);
  if (parsed === undefined) {
    const template = document.createElement('template');
    template.innerHTML = html;
    parsed = template.content.firstElementChild;
    if (parsedClips.size >= 16) parsedClips.clear();
    parsedClips.set(html, parsed);
  }
  return parsed;
}

/**
 * Markup kept as it is: a web clipping, or laid-out HTML pasted into a note
 * (Evernote calls that "HTML content"). Evernote keeps a clipped page's own
 * elements and inline styles inside a div marked `--en-clipped-content`, and
 * shows it as one object that is not edited in place. The document model here cannot hold
 * such markup, and reading it into paragraphs loses the page's appearance,
 * so the clipping is one indivisible block that carries its markup verbatim
 * and writes it back unchanged. `WebClipView` draws it.
 */
export const WebClip = Node.create({
  name: 'webClip',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      // Written by renderHTML as the element itself, not as an attribute.
      html: { default: '', rendered: false },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'div',
        // Ahead of code blocks and of the rule that reads a div as a paragraph.
        priority: 70,
        getAttrs: (element) =>
          hasStyle(element, /--en-clipped-content\s*:/) ? { html: element.outerHTML } : false,
      },
      // Laid-out markup that was pasted into a note, such as rendered
      // mathematics, carries no mark. It is recognised by its layout.
      ...['div', 'p'].map((tag) => ({
        tag,
        priority: 65,
        getAttrs: (element: HTMLElement) => (holdsLayout(element) ? { html: element.outerHTML } : false),
      })),
    ];
  },
  renderHTML({ node }) {
    const element = clipElement(String(node.attrs.html));
    return element ? (element.cloneNode(true) as HTMLElement) : ['div', {}];
  },
  addNodeView() {
    return guardedView(ReactNodeViewRenderer(WebClipView), 'div');
  },
  addProseMirrorPlugins() {
    const name = this.name;
    /** The position after a selected clipping, where new writing goes. */
    const afterSelectedClip = (selection: unknown) =>
      selection instanceof NodeSelection && selection.node.type.name === name ? selection.to : null;
    return [
      new Plugin({
        key: new PluginKey('webClipGuard'),
        props: {
          // A clipping is selected as a whole, and a selection is replaced by
          // what is typed or pasted: one stray letter would take the place
          // of a whole clipped page. The writing goes below it instead.
          // Delete and Backspace still remove a selected clipping.
          handleTextInput: (view, _from, _to, text) => {
            const position = afterSelectedClip(view.state.selection);
            if (position === null) return false;
            const transaction = openParagraphAt(view.state, position);
            if (!transaction) return false;
            transaction.insertText(text, position + 1);
            transaction.setSelection(TextSelection.create(transaction.doc, position + 1 + text.length));
            view.dispatch(transaction.scrollIntoView());
            return true;
          },
          handlePaste: (view) => {
            const position = afterSelectedClip(view.state.selection);
            if (position === null) return false;
            const transaction = openParagraphAt(view.state, position);
            if (!transaction) return false;
            transaction.setSelection(TextSelection.create(transaction.doc, position + 1));
            view.dispatch(transaction);
            // Not handled: the paste now goes into the new paragraph.
            return false;
          },
        },
      }),
    ];
  },
});

/**
 * Images written straight into a note. Embedded `data:` images are kept;
 * images on the web are shown only on request (see `ImageView`), because
 * loading them tells their server that, and when, the note was opened.
 */
const NoteImage = Image.extend({
  addNodeView() {
    return guardedView(ReactNodeViewRenderer(ImageView), 'span');
  },
});

export function createExtensions() {
  return [
    StarterKit.configure({
      paragraph: false,
      codeBlock: false,
      link: false,
      underline: false,
      heading: { levels: [1, 2, 3, 4] },
    }),
    EvernoteParagraph,
    EvernoteCodeBlock.configure({ exitOnTripleEnter: true }),
    TextStyle,
    FontSize,
    FontFamily,
    Color,
    EvernoteHighlight.configure({ multicolor: true }),
    Underline,
    Subscript,
    Superscript,
    TextAlign.configure({ types: ['paragraph', 'heading'] }),
    Indent,
    TaskList,
    TaskItem.configure({ nested: true }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      protocols: ['bever', 'evernote', 'mailto', 'tel'],
      HTMLAttributes: { rel: 'noopener noreferrer' },
    }),
    Table.configure({ resizable: true, lastColumnResizable: true }),
    TableRow,
    TableHeader.extend(widthAware),
    TableCell.extend(widthAware),
    NoteImage.configure({ inline: true, allowBase64: true }),
    EnMedia,
    EnTodo,
    EnCrypt,
    WebClip,
    StandInViews,
    NoteFindExtension,
  ];
}
