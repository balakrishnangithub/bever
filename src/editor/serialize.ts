import type { Editor } from '@tiptap/core';
import { DOMSerializer } from '@tiptap/pm/model';

let workshop: Document | null = null;

/**
 * The note as HTML, as it is stored.
 *
 * The editor's own `getHTML()` builds the elements in the page before it
 * reads their markup, and an `<img>` created in a page is fetched at once,
 * shown or not. A note that names images on the web would request every one
 * of them each time it is edited, although they are deliberately not shown
 * until asked for. Here the elements are built in a document that is never
 * displayed, where nothing is fetched.
 */
export function noteHtml(editor: Editor): string {
  workshop ??= document.implementation.createHTMLDocument('');
  const holder = workshop.createElement('div');
  DOMSerializer.fromSchema(editor.schema).serializeFragment(
    editor.state.doc.content,
    { document: workshop },
    holder,
  );
  return holder.innerHTML;
}
