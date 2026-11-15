import type { Node as DocumentNode } from '@tiptap/pm/model';

/**
 * What of a note's document can be seen, as text to compare.
 *
 * An editor changes its document for reasons that are not the writer's: a
 * keyboard on a screen takes up the word under the cursor and puts it back,
 * sometimes with a space after it; the editor adds an empty line at the end
 * so that there is somewhere to write; a letter is typed and deleted again.
 * None of that is a change of the note, and none of it should store the
 * note anew or give it a new date.
 *
 * So a note counts as changed when its face has changed, and not when the
 * editor says that something happened. Two documents have the same face
 * when they differ only in what cannot be seen:
 *
 * - spaces at the end of a line of text;
 * - empty lines at the end of the note.
 *
 * Everything else is part of the face: the text, its marks, the blocks and
 * their attributes, in their order.
 */
export function faceOf(document: DocumentNode): string {
  return JSON.stringify(face(document));
}

type Face = [name: string, attributes: unknown, marks: unknown, content: Face[] | string];

/** A space, a tab, a space that does not break, a hair space, a space of no width. */
const UNSEEN = new Set([0x20, 0x09, 0xa0, 0x200a, 0x200b]);

/** `text` without what cannot be seen at its end. */
function withoutTrailingSpace(text: string): string {
  let end = text.length;
  while (end > 0 && UNSEEN.has(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

function face(node: DocumentNode): Face {
  const marks = node.marks.map((mark) => mark.toJSON() as unknown);
  if (node.isText) return ['text', null, marks, node.text ?? ''];
  const content: Face[] = [];
  node.forEach((child) => content.push(face(child)));
  if (node.isTextblock && !node.type.spec.code) {
    // What a line ends in is not seen when it is spaces.
    while (content.length > 0) {
      const last = content[content.length - 1];
      if (last?.[0] !== 'text' || typeof last[3] !== 'string') break;
      const text = withoutTrailingSpace(last[3]);
      if (text) {
        content[content.length - 1] = [last[0], last[1], last[2], text];
        break;
      }
      content.pop();
    }
  }
  if (node.type.name === 'doc') {
    // Nor are empty lines after the last thing in the note.
    while (content.length > 1 && isEmptyLine(content[content.length - 1])) content.pop();
  }
  return [node.type.name, node.attrs, marks, content];
}

function isEmptyLine(block: Face | undefined): boolean {
  return block?.[0] === 'paragraph' && Array.isArray(block[3]) && block[3].length === 0;
}
