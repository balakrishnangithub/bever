import { Editor } from '@tiptap/core';
import { describe, expect, it, vi } from 'vitest';

import { createExtensions } from './extensions';

/** The editor's document as plain data, loosely typed for assertions. */
interface DocumentNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: DocumentNode[];
}

const documentOf = (editor: Editor) => editor.getJSON() as DocumentNode;

function editorWith(content: string) {
  return new Editor({
    element: document.createElement('div'),
    extensions: createExtensions(),
    content,
  });
}

describe('editor serialization', () => {
  it('preserves Evernote media, todo, and encrypted blocks', () => {
    const source =
      '<p>Before <en-todo checked="true"></en-todo><en-media hash="abcd1234" type="image/png" width="640"></en-media><en-crypt hint="Hint" cipher="RC2" length="64">payload==</en-crypt></p>';
    const editor = editorWith(source);
    const html = editor.getHTML();
    expect(html).toContain('<en-todo checked="true"');
    expect(html).toContain('<en-media');
    expect(html).toContain('hash="abcd1234"');
    expect(html).toContain('type="image/png"');
    expect(html).toContain('payload==');
    expect(html).toContain('cipher="RC2"');
    editor.destroy();
  });

  it('retains task-list structure and check state after edits', () => {
    const editor = editorWith(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Offline</p></li></ul>',
    );
    editor.commands.updateAttributes('taskItem', { checked: true });
    expect(editor.getHTML()).toContain('data-checked="true"');
    expect(editor.getHTML()).toContain('data-type="taskList"');
    editor.destroy();
  });

  it('serializes typography, alignment, headings, and indentation', () => {
    const editor = editorWith('<p>Formatted</p>');
    editor.commands.selectAll();
    editor
      .chain()
      .focus()
      .toggleBold()
      .setFontFamily('Arial')
      .setColor('#112233')
      .setMark('textStyle', { fontSize: '18px' })
      .run();
    editor.commands.setTextAlign('center');
    editor.commands.updateAttributes('paragraph', { indent: 2 });
    const html = editor.getHTML();
    expect(html).toContain('<strong>');
    expect(html).toContain('font-family: Arial');
    expect(html).toContain('font-size: 18px');
    expect(html).toContain('color: rgb(17, 34, 51)');
    expect(html).toContain('text-align: center');
    expect(html).toContain('margin-left: 4em');
    editor.commands.setHeading({ level: 3 });
    expect(editor.getHTML()).toContain('<h3');
    editor.destroy();
  });
});

describe('Evernote content in the editor', () => {
  it('reads an Evernote highlight, and only a span marked as one', () => {
    const editor = editorWith(
      '<p><span style="--en-highlight:yellow;background-color: #ffef9e;">marked</span> and <span style="background-color: rgb(255, 255, 255);">clipped page styling</span></p>',
    );
    const html = editor.getHTML();
    expect(html).toMatch(/<mark[^>]*>marked<\/mark>/);
    expect(html).not.toMatch(/<mark[^>]*>clipped page styling/);
    editor.destroy();
  });

  it('keeps a text colour on a highlighted span', () => {
    const editor = editorWith(
      '<p><span style="--en-highlight:yellow;background-color: #ffef9e; color: rgb(200, 0, 0);">both</span></p>',
    );
    const html = editor.getHTML();
    expect(html).toContain('<mark');
    expect(html).toContain('color: rgb(200, 0, 0)');
    editor.destroy();
  });

  it('turns an Evernote code block into a code block with its lines', () => {
    const editor = editorWith(
      '<div style="--en-codeblock:true;box-sizing: border-box;"><div>let a = 1;</div><div>  let b = a &lt; 2;</div><div><br></div><div>done();</div></div><div>An ordinary paragraph</div>',
    );
    const json = documentOf(editor);
    expect(json.content?.[0]?.type).toBe('codeBlock');
    expect(json.content?.[0]?.content?.[0]?.text).toBe('let a = 1;\n  let b = a < 2;\n\ndone();');
    expect(json.content?.[1]?.type).toBe('paragraph');
    expect(editor.getHTML()).toContain('<pre><code>');
    editor.destroy();
  });

  it('keeps images embedded as data and images on the web', () => {
    const pixel = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=';
    const editor = editorWith(
      `<p><img src="${pixel}" alt="embedded"><img src="https://example.com/remote.png" alt="remote"></p>`,
    );
    const html = editor.getHTML();
    expect(html).toContain(pixel);
    expect(html).toContain('https://example.com/remote.png');
    editor.destroy();
  });

  it('reads a checklist marked by the importer, with Evernote item markup', () => {
    const editor = editorWith(
      '<ul data-type="taskList" style="--en-todo:true;"><li data-type="taskItem" data-checked="true" style="--en-checked:true;"><div>Done</div></li><li data-type="taskItem" data-checked="false"><div>Open</div></li></ul>',
    );
    const list = documentOf(editor).content?.[0];
    expect(list?.type).toBe('taskList');
    expect(list?.content?.map((item) => item.attrs?.checked)).toEqual([true, false]);
    editor.destroy();
  });

  it('reads a column width written as CSS', () => {
    const editor = editorWith(
      '<table><tbody><tr><td style="width: 130px;"><div>cell</div></td><td><div>other</div></td></tr></tbody></table>',
    );
    const cell = documentOf(editor).content?.[0]?.content?.[0]?.content?.[0];
    expect(cell?.attrs?.colwidth).toEqual([130]);
    editor.destroy();
  });
});

describe('web clippings', () => {
  const clip =
    '<div style="--en-clipped-content:fullPage; --en-clipped-source-url:https://example.com/a?x=1&amp;y=2; --en-clipped-source-title:Example;">' +
    '<div style="min-height: 100vh; display: block; position: relative;"><ul style="display:flex;list-style:none;">' +
    '<li style="margin-left:10px;"><a rel="noopener" href="https://example.com/b" style="font-weight:700;">Section</a></li></ul>' +
    '<en-media hash="abcd1234" type="image/png" width="640" height="480" style="float:right;"></en-media>' +
    '<p style="font-family:&quot;Droid Serif&quot;, serif;">Clipped paragraph</p></div></div>';

  it('are one block that carries its markup unchanged', () => {
    const editor = editorWith(`<p>Before</p>${clip}<p>After</p>`);
    const blocks = documentOf(editor).content ?? [];
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'webClip', 'paragraph']);
    expect(blocks[1]?.attrs?.html).toBe(clip);
    expect(editor.getHTML()).toBe(`<p>Before</p>${clip}<p>After</p>`);
    editor.destroy();
  });

  it('survive edits made around them', () => {
    const editor = editorWith(`<p>Before</p>${clip}`);
    editor.commands.insertContentAt(1, 'My note: ');
    const html = editor.getHTML();
    expect(html).toContain('<p>My note: Before</p>');
    expect(html).toContain(clip);
    editor.destroy();
  });

  it('are recognised wherever the clipping sits, and one by one', () => {
    const second = clip.replace('fullPage', 'selection');
    const editor = editorWith(`<div><br></div>${clip}<div>Between</div>${second}`);
    const blocks = documentOf(editor).content ?? [];
    expect(blocks.filter((block) => block.type === 'webClip')).toHaveLength(2);
    expect(editor.getHTML()).toContain(second);
    editor.destroy();
  });

  it('leave ordinary styled divs as editable text', () => {
    const editor = editorWith('<div style="color:red">Plain <b>text</b></div>');
    expect(documentOf(editor).content?.map((block) => block.type)).toEqual(['paragraph']);
    editor.destroy();
  });
});

describe('storing a note', () => {
  it('does not build its images in the page, where they would be fetched', async () => {
    const { noteHtml } = await import('./serialize');
    const source =
      '<p>Text <img src="https://example.com/remote.png" alt="Remote"></p>' +
      '<div style="--en-clipped-content:article;"><img src="https://example.com/clipped.png"><p>Clip</p></div>' +
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Done</p></li></ul>';
    const editor = editorWith(source);
    const created: string[] = [];
    const createElement = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation((name: string) => {
      created.push(name.toLowerCase());
      return createElement(name);
    });
    const stored = noteHtml(editor);
    spy.mockRestore();
    expect(created).not.toContain('img');
    expect(stored).toBe(editor.getHTML());
    expect(stored).toContain('https://example.com/remote.png');
    expect(stored).toContain('https://example.com/clipped.png');
    editor.destroy();
  });
});

describe('a selected web clipping', () => {
  const clip = '<div style="--en-clipped-content:article;"><p style="color:red">Clipped page</p></div>';

  it('is not replaced by what is typed; the writing goes below it', () => {
    const editor = editorWith(clip);
    editor.commands.setNodeSelection(0);
    const handled = editor.view.someProp('handleTextInput', (handle) =>
      handle(editor.view, 0, 1, 'x', () => editor.state.tr),
    );
    expect(handled).toBe(true);
    // The editor keeps an empty paragraph after a clipping; the letter goes there.
    expect(documentOf(editor).content?.map((block) => block.type)).toEqual(['webClip', 'paragraph']);
    expect(editor.getHTML()).toBe(`${clip}<p>x</p>`);
    // The cursor is in the new paragraph, so the next letters follow it.
    editor.commands.insertContent('yz');
    expect(editor.getHTML()).toBe(`${clip}<p>xyz</p>`);
    editor.destroy();
  });

  it('can still be deleted on purpose', () => {
    const editor = editorWith(`<p>Before</p>${clip}`);
    editor.commands.setNodeSelection(8);
    editor.commands.deleteSelection();
    expect(editor.getHTML()).not.toContain('Clipped page');
    expect(editor.getHTML()).toContain('<p>Before</p>');
    editor.destroy();
  });

  it('starts a paragraph of its own when other content follows it', () => {
    const editor = editorWith(`${clip}<p>After</p>`);
    editor.commands.setNodeSelection(0);
    editor.view.someProp('handleTextInput', (handle) =>
      handle(editor.view, 0, 1, 'x', () => editor.state.tr),
    );
    expect(editor.getHTML()).toBe(`${clip}<p>x</p><p>After</p>`);
    editor.destroy();
  });

  it('leaves typing elsewhere alone', () => {
    const editor = editorWith(`<p>Before</p>${clip}`);
    editor.commands.setTextSelection(3);
    const handled = editor.view.someProp('handleTextInput', (handle) =>
      handle(editor.view, 3, 3, 'x', () => editor.state.tr),
    );
    expect(handled).toBeFalsy();
    editor.destroy();
  });
});

describe('laid-out HTML pasted into a note', () => {
  // Rendered mathematics in the shape KaTeX writes it: a hidden spoken form
  // beside boxes that are placed by their styles.
  const formula =
    '<span style="box-sizing: border-box; font: 400 1.21em / 1.2 KaTeX_Main, &quot;Times New Roman&quot;, serif;">' +
    '<span style="position: absolute; clip: rect(1px, 1px, 1px, 1px); height: 1px; width: 1px; overflow: hidden;"><span>x^{1/2}</span></span>' +
    '<span style="position: relative; white-space: nowrap; display: inline-block;">' +
    '<span style="display: inline-block; height: 0.99em; vertical-align: -0.04em;"></span>' +
    '<span style="font-family: KaTeX_Math; font-style: italic;">x</span>' +
    '<span style="display: inline-table; table-layout: fixed;"><span style="display: table-row;"><span style="display: table-cell; vertical-align: bottom;">½</span></span></span>' +
    '</span></span>';
  const block = `<div><span style="color: rgb(22, 22, 22);">Simplify </span>${formula}</div>`;

  it('is kept as one block with its markup unchanged', () => {
    const editor = editorWith(`<div><b>Quiz</b></div>${block}<div>My answer</div>`);
    const blocks = documentOf(editor).content ?? [];
    expect(blocks.map((item) => item.type)).toEqual(['paragraph', 'webClip', 'paragraph']);
    expect(blocks[1]?.attrs?.html).toBe(block);
    expect(editor.getHTML()).toContain(block);
    editor.destroy();
  });

  it('is the smallest block that holds the layout, not what surrounds it', () => {
    const editor = editorWith(`<div><div>Before it</div>${block}<div>After it</div></div>`);
    const blocks = documentOf(editor).content ?? [];
    expect(blocks.map((item) => item.type)).toEqual(['paragraph', 'webClip', 'paragraph']);
    editor.destroy();
  });

  it('leaves text copied from a web page editable', () => {
    const editor = editorWith(
      '<div><span style="display: inline !important; float: none; color: rgb(22, 22, 22);">Copied text</span> ' +
        '<span style="display: inline-block;">with one badge</span> and <img src="data:image/png;base64,AAAA" style="float: right;"></div>',
    );
    expect(documentOf(editor).content?.map((item) => item.type)).toEqual(['paragraph']);
    editor.destroy();
  });

  it('becomes ordinary text, once, when made editable', async () => {
    const { editableMarkup } = await import('./clipSanitizer');
    const editor = editorWith(editableMarkup(block));
    const blocks = documentOf(editor).content ?? [];
    expect(blocks.map((item) => item.type)).toEqual(['paragraph']);
    // The hidden spoken form is not added to the visible one.
    expect(editor.getText()).toBe('Simplify x½');
    editor.destroy();
  });

  it('makes a marked clipping editable without leaving a kept block behind', async () => {
    const { editableMarkup } = await import('./clipSanitizer');
    const clip = `<div style="--en-clipped-content:selection; --en-clipped-source-url:https://example.com/;"><div style="min-height: 416px; position: relative;"><p>Explanation ${formula}</p></div></div>`;
    const editor = editorWith(editableMarkup(clip));
    const types = (documentOf(editor).content ?? []).map((item) => item.type);
    expect(types).not.toContain('webClip');
    expect(editor.getText()).toContain('Explanation x½');
    editor.destroy();
  });
});

describe('divs that wrap other blocks', () => {
  it('leave no empty paragraph behind', () => {
    const editor = editorWith(
      '<div><div>First</div><div><div>Second</div></div>loose text<ul><li>Item</li></ul></div>',
    );
    const blocks = documentOf(editor).content ?? [];
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'paragraph', 'paragraph', 'bulletList']);
    expect(editor.getText({ blockSeparator: ' ' }).replace(/\s+/g, ' ')).toBe('First Second loose text Item');
    editor.destroy();
  });

  it('are still lines of text when they hold only text', () => {
    const editor = editorWith('<div>One</div><div><br></div><div>Two <b>bold</b></div>');
    expect(documentOf(editor).content?.map((block) => block.type)).toEqual([
      'paragraph',
      'paragraph',
      'paragraph',
    ]);
    editor.destroy();
  });
});

describe('empty lines and hidden elements', () => {
  it('reads Evernote’s empty line as one empty line', () => {
    const editor = editorWith('<div>One</div><div><br></div><div>Two</div><p><br/></p>');
    const blocks = documentOf(editor).content ?? [];
    expect(blocks.map((block) => [block.type, block.content?.length ?? 0])).toEqual([
      ['paragraph', 1],
      ['paragraph', 0],
      ['paragraph', 1],
      ['paragraph', 0],
    ]);
    editor.destroy();
  });

  it('keeps a line break that stands between or after text', () => {
    const editor = editorWith('<div>One<br>Two</div><div>Three<br></div>');
    expect(editor.getHTML()).toBe('<p>One<br>Two</p><p>Three<br></p>');
    editor.destroy();
  });

  it('does not show what the note keeps hidden', () => {
    const editor = editorWith(
      '<div style="display:none;--en-chs:&quot;e30=&quot;"></div><div>Shown<span style="display: none">not shown</span></div>',
    );
    expect(editor.getHTML()).toBe('<p>Shown</p>');
    editor.destroy();
  });
});
