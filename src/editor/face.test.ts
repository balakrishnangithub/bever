import { Editor } from '@tiptap/core';
import { describe, expect, it } from 'vitest';

import { createExtensions } from './extensions';
import { faceOf } from './face';
import { noteHtml } from './serialize';

/**
 * A note's page as the import from Evernote's files stores it: lines as
 * `div`s, Evernote's own bookkeeping element, which holds a hair space and
 * is not shown, and an empty line at the end.
 */
const STORED =
  `<div style="display:none;--en-chs:&quot;eyJpc0VtcHR5Ijp0cnVlfQ==&quot;">${String.fromCharCode(0x200a)}</div>` +
  '<div><b>Code</b></div>' +
  '<div><a href="https://example.com/project">https://example.com/project</a></div>' +
  '<div><hr/></div>' +
  '<div><b>Build</b></div>' +
  '<div><en-media type="application/vnd.android.package-archive" hash="0123456789abcdef0123456789abcdef"></en-media></div>' +
  '<div><hr/></div>' +
  '<div><br/></div>';

function editorWith(content: string) {
  return new Editor({
    element: document.createElement('div'),
    extensions: createExtensions(),
    content,
  });
}

/** What the editor reports of its note: the stored page while nothing that can be seen has changed. */
function reporting(editor: Editor, stored: string) {
  const face = faceOf(editor.state.doc);
  return () => (faceOf(editor.state.doc) === face ? stored : noteHtml(editor));
}

/** The position just after the text of the line that holds `text`. */
function endOfLine(editor: Editor, text: string): number {
  let end = -1;
  editor.state.doc.descendants((node, position) => {
    if (node.isTextblock && node.textContent.includes(text)) end = position + node.nodeSize - 1;
  });
  if (end < 0) throw new Error(`no line holds ${text}`);
  return end;
}

describe("a note's face", () => {
  it('is the same however the cursor is placed and moved', () => {
    const editor = editorWith(STORED);
    const report = reporting(editor, STORED);
    const document = editor.state.doc;
    for (const position of [1, 3, endOfLine(editor, 'example.com'), document.content.size - 1]) {
      editor.commands.setTextSelection(position);
      expect(report()).toBe(STORED);
    }
    editor.commands.selectAll();
    editor.commands.focus('end');
    expect(report()).toBe(STORED);
    // Nothing of the document was touched at all.
    expect(editor.state.doc.eq(document)).toBe(true);
    editor.destroy();
  });

  it('is the same when a keyboard takes up a word and puts it back', () => {
    const editor = editorWith(STORED);
    const report = reporting(editor, STORED);
    const before = editor.state.doc;
    // As an on-screen keyboard does with the word under the cursor: the
    // same letters are written over themselves.
    editor.view.dispatch(editor.state.tr.insertText('Code', 1, 5));
    expect(editor.state.doc).not.toBe(before);
    expect(report()).toBe(STORED);
    editor.destroy();
  });

  it('is the same when the word is put back with a space after it, at the end of its line', () => {
    const editor = editorWith(STORED);
    const report = reporting(editor, STORED);
    const end = endOfLine(editor, 'example.com');
    editor.view.dispatch(editor.state.tr.insertText(' ', end));
    expect(editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n')).toContain('project \n');
    expect(report()).toBe(STORED);
    // A space that does not break, a tab and a second space are seen no more than the first.
    editor.view.dispatch(editor.state.tr.insertText(`${String.fromCharCode(0xa0)}\t `, end + 1));
    expect(report()).toBe(STORED);
    editor.destroy();
  });

  it('is the same when a letter is typed and taken away again, and another while it is there', () => {
    const editor = editorWith(STORED);
    const report = reporting(editor, STORED);
    editor.view.dispatch(editor.state.tr.insertText('x', 3));
    const typed = report();
    expect(typed).not.toBe(STORED);
    expect(typed).toContain('Cox');
    editor.view.dispatch(editor.state.tr.delete(3, 4));
    expect(report()).toBe(STORED);
    editor.destroy();
  });

  it('is the same when the editor adds an empty line at the end to write in', () => {
    // A note that ends in a rule. The editor wants a line after it, and
    // adds one as soon as anything happens, a cursor being placed included.
    const stored = '<div>Above</div><div><hr/></div>';
    const editor = editorWith(stored);
    const report = reporting(editor, stored);
    const blocks = editor.state.doc.childCount;
    editor.commands.setTextSelection(2);
    expect(editor.state.doc.childCount).toBe(blocks + 1);
    expect(editor.state.doc.lastChild?.type.name).toBe('paragraph');
    expect(report()).toBe(stored);
    editor.destroy();
  });

  it('is another one for everything that can be seen', () => {
    const changes: [string, (editor: Editor) => void][] = [
      ['a letter in a line', (editor) => editor.view.dispatch(editor.state.tr.insertText('!', 5))],
      ['a space within a line', (editor) => editor.view.dispatch(editor.state.tr.insertText(' ', 3))],
      [
        'a space at the beginning of a line',
        (editor) => editor.view.dispatch(editor.state.tr.insertText(' ', 1)),
      ],
      ['bold taken off', (editor) => editor.chain().setTextSelection({ from: 1, to: 5 }).unsetBold().run()],
      [
        'a line made a heading',
        (editor) => editor.chain().setTextSelection(2).setHeading({ level: 2 }).run(),
      ],
      [
        'an empty line between two lines',
        (editor) => editor.chain().setTextSelection(5).splitBlock().splitBlock().run(),
      ],
      ['a line taken away', (editor) => editor.view.dispatch(editor.state.tr.delete(0, 6))],
    ];
    for (const [what, change] of changes) {
      const editor = editorWith(STORED);
      const report = reporting(editor, STORED);
      change(editor);
      expect(report(), what).not.toBe(STORED);
      editor.destroy();
    }
  });

  it("is the same for the stored page and for the editor's own writing of it", () => {
    const editor = editorWith(STORED);
    const written = noteHtml(editor);
    // The two pages are written differently…
    expect(written).not.toBe(STORED);
    expect(written).toContain('<p><strong>Code</strong></p>');
    // …and are one note.
    const again = editorWith(written);
    expect(faceOf(again.state.doc)).toBe(faceOf(editor.state.doc));
    editor.destroy();
    again.destroy();
  });

  it('keeps spaces that are part of code', () => {
    const editor = editorWith('<pre><code>line </code></pre><p>after</p>');
    const before = faceOf(editor.state.doc);
    editor.view.dispatch(editor.state.tr.insertText(' ', 6));
    expect(faceOf(editor.state.doc)).not.toBe(before);
    editor.destroy();
  });
});
