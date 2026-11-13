/**
 * The native search marks each match inside a snippet with these private-use
 * characters. A snippet is always plain text; it is never parsed as HTML.
 */
export const SNIPPET_START = '';
export const SNIPPET_END = '';

export interface SnippetPart {
  text: string;
  match: boolean;
}

/** Splits a snippet into ordinary and matched runs for rendering. */
export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let match = false;
  let text = '';
  const flush = () => {
    if (text) parts.push({ text, match });
    text = '';
  };
  for (const character of snippet) {
    if (character === SNIPPET_START || character === SNIPPET_END) {
      flush();
      match = character === SNIPPET_START;
    } else {
      text += character;
    }
  }
  flush();
  return parts;
}
