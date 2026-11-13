/**
 * How an image attachment is sized and placed, as Evernote records it on the
 * `en-media` element:
 *
 * ```html
 * <en-media width="400px" style="--en-naturalWidth:643; --en-naturalHeight:150;
 *           --en-imageAlignment:center;" …/>
 * ```
 *
 * Only a width is kept; the height follows from the picture's proportions.
 * The attributes are read and written here and nowhere else, so that what is
 * shown, what is edited, and what is exported agree.
 */

export type ImageAlignment = 'left' | 'center' | 'right';

export interface ImageLayout {
  /** A CSS width such as `250px` or `60%`, or null for the picture's own size. */
  width: string | null;
  /** As wide as the note. */
  fill: boolean;
  alignment: ImageAlignment;
  /** Width divided by height, when the picture's own size is known. */
  ratio: number | null;
}

interface MediaAttributes {
  width?: unknown;
  height?: unknown;
  style?: unknown;
}

/** An attribute as text; an editor attribute can hold anything. */
const text = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

const declarations = (style: string) =>
  style
    .split(';')
    .map((declaration) => {
      const colon = declaration.indexOf(':');
      return colon > 0
        ? { name: declaration.slice(0, colon).trim(), value: declaration.slice(colon + 1).trim() }
        : null;
    })
    .filter((declaration): declaration is { name: string; value: string } => declaration !== null);

const number = (value: unknown) => {
  const parsed = Number.parseFloat(text(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export function readImageLayout(attributes: MediaAttributes): ImageLayout {
  const style = declarations(text(attributes.style));
  const custom = (name: string) =>
    style.find((declaration) => declaration.name.toLowerCase() === name.toLowerCase())?.value ?? '';

  const written = text(attributes.width).trim();
  let width: string | null = null;
  const amount = Number.parseFloat(written);
  if (amount >= 1 && /^\d+(\.\d+)?(px)?$/i.test(written)) width = `${Math.round(amount)}px`;
  else if (amount >= 1 && /^\d+(\.\d+)?%$/.test(written)) width = `${Math.min(100, amount)}%`;

  const placed = custom('--en-imageAlignment').toLowerCase();
  const alignment: ImageAlignment = placed === 'center' || placed === 'right' ? placed : 'left';

  const naturalWidth = number(custom('--en-naturalWidth'));
  const naturalHeight = number(custom('--en-naturalHeight'));
  // Older notes give both sides in pixels instead of the picture's own size.
  const pixels = (value: unknown) => (/^\d+(\.\d+)?(px)?$/i.test(text(value).trim()) ? number(value) : null);
  const ratio =
    naturalWidth && naturalHeight
      ? naturalWidth / naturalHeight
      : pixels(attributes.width) && pixels(attributes.height)
        ? (pixels(attributes.width) ?? 1) / (pixels(attributes.height) ?? 1)
        : null;

  return { width, fill: width === '100%', alignment, ratio };
}

export interface ImageChange {
  /** Pixels; `'fill'` for the width of the note; null for the picture's own size. */
  width?: number | 'fill' | null;
  alignment?: ImageAlignment;
}

/**
 * The `en-media` attributes after a change of size or placement. Everything
 * else the element's style says, such as the picture's own size, is kept.
 */
export function withImageLayout(
  attributes: MediaAttributes,
  change: ImageChange,
): { width: string | null; height: null; style: string | null } {
  const current = readImageLayout(attributes);
  const width =
    change.width === undefined
      ? current.width
      : change.width === 'fill'
        ? '100%'
        : change.width === null
          ? null
          : `${Math.max(16, Math.round(change.width))}px`;
  const alignment = change.alignment ?? current.alignment;
  const kept = declarations(text(attributes.style)).filter(
    (declaration) => declaration.name.toLowerCase() !== '--en-imagealignment',
  );
  // Evernote writes no alignment for a picture that stays on the left.
  if (alignment !== 'left') kept.push({ name: '--en-imageAlignment', value: alignment });
  const style = kept.map((declaration) => `${declaration.name}:${declaration.value};`).join(' ');
  // A height would fix the proportions of a picture whose width has changed.
  return { width, height: null, style: style || null };
}

/**
 * The `en-media` attributes for a picture whose own size has become
 * `width` by `height`, as a sketch's does when strokes are added to it or
 * taken away. It is shown at the scale it was shown at before: a width in
 * pixels grows or shrinks with the picture, a width in percent stays.
 */
export function withNaturalSize(
  attributes: MediaAttributes,
  width: number,
  height: number,
): { width: string | null; height: null; style: string | null } {
  const current = readImageLayout(attributes);
  const all = declarations(text(attributes.style));
  const before = number(
    all.find((declaration) => declaration.name.toLowerCase() === '--en-naturalwidth')?.value,
  );
  const shown = current.width?.endsWith('px') ? Number.parseFloat(current.width) : null;
  const scaled = shown && before ? `${Math.max(16, Math.round((shown * width) / before))}px` : current.width;
  const kept = all.filter(
    (declaration) => !['--en-naturalwidth', '--en-naturalheight'].includes(declaration.name.toLowerCase()),
  );
  const style = [
    { name: '--en-naturalWidth', value: String(width) },
    { name: '--en-naturalHeight', value: String(height) },
    ...kept,
  ]
    .map((declaration) => `${declaration.name}:${declaration.value};`)
    .join(' ');
  return { width: scaled, height: null, style };
}
