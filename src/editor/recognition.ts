/**
 * The text recognised in a picture, and where in the picture it stands.
 *
 * Evernote keeps it as a `recoIndex` document: one `item` for each word it
 * saw, with the word's rectangle in the picture's pixels and one or more
 * readings of it, each with a weight. Text recognised on this device is kept
 * in the same form.
 */

/** A rectangle in a picture, in fractions of its width and height. */
export interface PictureBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface RecognizedWord extends PictureBox {
  /** What the word may read, the likeliest reading first. */
  readings: string[];
}

export interface Recognition {
  words: RecognizedWord[];
}

/** What a search found in one picture. */
export interface PictureMatch {
  /** The words that match, where the picture's text says where they are. */
  boxes: PictureBox[];
  /** The picture's text matches, but nothing says where in the picture. */
  whole: boolean;
}

/** Something to look for; see {@link termPattern}. */
export interface FindTerm {
  text: string;
  /**
   * `plain` finds the text wherever it stands, as Find does. `prefix` and
   * `words` are what a search of the library matches: whole words, of which
   * the last may go on (`prefix`) or not (`words`).
   */
  mode: 'plain' | 'prefix' | 'words';
}

const LETTER = '[\\p{L}\\p{N}]';
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The pattern that finds `term` in text, or null when it can find nothing. */
export function termPattern(term: FindTerm): RegExp | null {
  if (term.mode === 'plain') {
    return term.text ? new RegExp(escaped(term.text), 'giu') : null;
  }
  // The library's index knows words only: whatever stands between them,
  // a space or a hyphen, is the same to it.
  const words = term.text.match(/[\p{L}\p{N}]+/gu);
  if (!words) return null;
  const end = term.mode === 'words' ? `(?!${LETTER})` : '';
  return new RegExp(`(?<!${LETTER})${words.map(escaped).join(`[^\\p{L}\\p{N}]+`)}${end}`, 'giu');
}

const parsed = new Map<string, Recognition | null>();

/** Reads a `recoIndex` document; null when it says nothing usable. */
export function parseRecognition(xml: string | null | undefined): Recognition | null {
  if (!xml) return null;
  const known = parsed.get(xml);
  if (known !== undefined) return known;
  let result: Recognition | null = null;
  try {
    const root = new DOMParser().parseFromString(xml, 'application/xml').documentElement;
    if (root.localName === 'recoIndex') {
      const number = (element: Element, name: string) => Number(element.getAttribute(name));
      const items = [...root.getElementsByTagName('item')].map((item) => ({
        x: number(item, 'x'),
        y: number(item, 'y'),
        w: number(item, 'w'),
        h: number(item, 'h'),
        readings: [...item.getElementsByTagName('t')]
          .map((reading) => ({
            text: (reading.textContent ?? '').trim(),
            weight: Number(reading.getAttribute('w') ?? 0),
          }))
          .filter((reading) => reading.text)
          .sort((a, b) => b.weight - a.weight)
          .map((reading) => reading.text),
      }));
      const placed = items.filter(
        (item) => item.readings.length && item.w > 0 && item.h > 0 && item.x >= 0 && item.y >= 0,
      );
      // The picture's size is given; older documents leave it out, and the
      // words then at least say how far the picture reaches.
      const width = number(root, 'objWidth') || Math.max(0, ...placed.map((item) => item.x + item.w));
      const height = number(root, 'objHeight') || Math.max(0, ...placed.map((item) => item.y + item.h));
      if (placed.length && width > 0 && height > 0) {
        result = {
          words: placed.map((item) => ({
            x: item.x / width,
            y: item.y / height,
            w: Math.min(item.w / width, 1 - item.x / width),
            h: Math.min(item.h / height, 1 - item.y / height),
            readings: item.readings,
          })),
        };
      }
    }
  } catch {
    // Not a document that can be read: the picture's plain text still is.
  }
  if (parsed.size > 400) parsed.clear();
  parsed.set(xml, result);
  return result;
}

/**
 * Where `patterns` match in a picture's recognised text. `text` is the
 * picture's text without places, which is all there is when the places
 * of its words cannot be read.
 */
export function findInPicture(
  recognition: Recognition | null,
  text: string | null | undefined,
  patterns: RegExp[],
): PictureMatch | null {
  const found = new Set<number>();
  if (recognition) {
    // The likeliest readings in a row, as the picture reads; a phrase may
    // run over several words.
    const starts: number[] = [];
    let line = '';
    recognition.words.forEach((word) => {
      starts.push(line.length);
      line += `${word.readings[0] ?? ''} `;
    });
    for (const pattern of patterns) {
      for (const match of line.matchAll(pattern)) {
        const from = match.index;
        const to = from + Math.max(match[0].length, 1);
        recognition.words.forEach((word, index) => {
          const start = starts[index] ?? 0;
          if (start < to && start + (word.readings[0]?.length ?? 0) > from) found.add(index);
        });
      }
      // A word that may also read otherwise matches by that reading too.
      recognition.words.forEach((word, index) => {
        if (word.readings.slice(1).some((reading) => reading.search(pattern) >= 0)) found.add(index);
      });
    }
  }
  if (found.size) {
    const boxes = [...found]
      .sort((a, b) => a - b)
      .map((index) => recognition?.words[index])
      .filter((word) => word !== undefined)
      .map(({ x, y, w, h }) => ({ x, y, w, h }));
    return { boxes, whole: false };
  }
  if (text && patterns.some((pattern) => text.search(pattern) >= 0)) return { boxes: [], whole: true };
  return null;
}
