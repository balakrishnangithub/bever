/**
 * Turns the markup of a web clipping into elements that are safe to show.
 *
 * Evernote stores a clipped page as the page's own elements with inline
 * styles, wrapped in a div marked `--en-clipped-content`. Showing it the way
 * it was clipped means keeping those styles, which the editor's document
 * model cannot hold. The clipping comes from an imported file or another
 * device, so nothing in it is trusted: only known elements and attributes
 * are rebuilt, and styles are filtered declaration by declaration.
 */

export interface ClipResource {
  url: string;
  mime: string;
  name: string;
}

export interface ClipOptions {
  /** Finds an attachment of the note by the hash its `en-media` carries. */
  resource: (hash: string) => ClipResource | null;
  /** Whether images that live on the web may be requested. */
  allowRemote: boolean;
}

export interface SanitizedClip {
  content: DocumentFragment;
  /** Images and backgrounds left out because they live on the web. */
  blockedRemote: number;
}

export interface ClipInfo {
  /**
   * How Evernote clipped it: `fullPage`, `article`, `simplified`,
   * `selection`, …; or `html` for laid-out markup that was pasted into a
   * note and carries no such mark.
   */
  kind: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
}

/** Elements rebuilt as they are. Anything else is unwrapped or dropped. */
const ELEMENTS = new Set(
  (
    'a abbr acronym address article aside b bdi bdo big blockquote br caption center cite code col colgroup dd del ' +
    'details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark ' +
    'nav ol p pre q s samp section small span strike strong sub summary sup table tbody td tfoot th thead time tr ' +
    'tt u ul var wbr'
  ).split(' '),
);

/** Elements removed together with everything inside them. */
const DROPPED = new Set(
  (
    'script style iframe frame frameset object embed applet template noscript head title meta link base form ' +
    'input button select option textarea audio video source track canvas svg math dialog'
  ).split(' '),
);

const ATTRIBUTES = new Set(
  (
    'align alt bgcolor border cellpadding cellspacing color colspan dir face height lang nowrap rowspan size span ' +
    'start title valign width'
  ).split(' '),
);

const LINK = /^(https?:|mailto:|tel:|evernote:|bever:)/i;
const REMOTE = /^https?:/i;
const EMBEDDED_IMAGE = /^data:image\/(png|jpeg|gif|webp|bmp|avif);/i;

/** What Evernote recorded about a clipping on its wrapper element. */
export function clipInfo(html: string): ClipInfo {
  const style = /^<div[^>]*\sstyle="([^"]*)"/i.exec(html.trimStart())?.[1] ?? '';
  const declarations = new Map(
    splitDeclarations(decodeEntities(style)).map(({ name, value }) => [name, value] as const),
  );
  const text = (name: string) => {
    const value = declarations.get(name)?.trim();
    return value ? value : null;
  };
  const address = text('--en-clipped-source-url');
  return {
    kind: text('--en-clipped-content') ?? 'html',
    sourceUrl: address && REMOTE.test(address) ? address : null,
    sourceTitle: text('--en-clipped-source-title'),
  };
}

/**
 * Inline styles that lay content out in ways the editor's document cannot
 * hold: rendered mathematics, for one, is hundreds of small boxes placed
 * with these. `display: inline` and `float: none` are not among them; text
 * copied from a web page carries those on every span.
 */
const LAID_OUT = [
  /(^|;)\s*display\s*:\s*(inline-block|inline-table|inline-flex|inline-grid|flex|grid|table(-[a-z-]+)?)\b/i,
  /(^|;)\s*position\s*:\s*absolute\b/i,
  /(^|;)\s*float\s*:\s*(left|right)\b/i,
];

/** As few of them as this are a decorated word, not a layout. */
const LAYOUT_THRESHOLD = 3;

const BLOCKS = 'div, p, ul, ol, li, table, tbody, tr, td, th, blockquote, pre';

const layoutScores = new WeakMap<Element, number>();

/** How many elements in `element`, itself included, are laid out by their style. */
function layoutScore(element: Element): number {
  const known = layoutScores.get(element);
  if (known !== undefined) return known;
  const style = element.getAttribute('style');
  let score = style && LAID_OUT.some((pattern) => pattern.test(style)) ? 1 : 0;
  for (const child of element.children) score += layoutScore(child);
  layoutScores.set(element, score);
  return score;
}

/**
 * Whether `element` is a block of laid-out markup to be kept as it is: it
 * holds enough laid-out elements, and no block inside it does so by itself,
 * so that the smallest such block is kept and the text around it stays
 * ordinary, editable text.
 */
export function holdsLayout(element: Element): boolean {
  if (layoutScore(element) < LAYOUT_THRESHOLD) return false;
  for (const inner of element.querySelectorAll(BLOCKS)) {
    if (layoutScore(inner) >= LAYOUT_THRESHOLD) return false;
  }
  return true;
}

/** Style properties that place or size things, dropped by `editableMarkup`. */
const PLACING =
  /^(display|position|float|clear|clip|clip-path|top|right|bottom|left|inset.*|z-index|table-layout|vertical-align|overflow.*|width|height|min-.*|max-.*|box-sizing|transform.*|flex.*|grid.*|align-.*|justify-.*|order|gap|margin.*|padding.*|white-space|text-indent|--en-clipped-.*)$/;

/**
 * The markup of a kept block as the editor can hold it: without the mark
 * that makes it a clipping, without the declarations that lay it out, and
 * without what the page had hidden from view, such as the spoken form that
 * rendered mathematics carries beside the visible one.
 */
export function editableMarkup(html: string): string {
  const source = new DOMParser().parseFromString(html, 'text/html');
  for (const element of [...source.body.querySelectorAll('[style]')]) {
    const declarations = splitDeclarations(element.getAttribute('style') ?? '');
    const value = (name: string) =>
      declarations.find((declaration) => declaration.name === name)?.value.toLowerCase() ?? '';
    const hidden =
      value('display') === 'none' ||
      value('visibility') === 'hidden' ||
      (value('position') === 'absolute' && (value('clip') !== '' || value('clip-path') !== ''));
    if (hidden) {
      element.remove();
      continue;
    }
    const kept = declarations.filter((declaration) => !PLACING.test(declaration.name));
    if (kept.length) {
      element.setAttribute('style', kept.map(({ name, value: text }) => `${name}:${text}`).join(';'));
    } else {
      element.removeAttribute('style');
    }
  }
  return source.body.innerHTML;
}

export function sanitizeClip(html: string, options: ClipOptions): SanitizedClip {
  // A parsed document is inert: it runs no script and requests nothing.
  const source = new DOMParser().parseFromString(html, 'text/html');
  const state = { blockedRemote: 0 };
  const content = document.createDocumentFragment();
  copyChildren(source.body, content, options, state);
  return { content, blockedRemote: state.blockedRemote };
}

function copyChildren(
  from: Node,
  to: Node,
  options: ClipOptions,
  state: { blockedRemote: number },
  depth = 0,
) {
  // Far deeper than any page; guards against markup built to exhaust the stack.
  if (depth > 400) return;
  for (const child of from.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      to.appendChild(document.createTextNode(child.nodeValue ?? ''));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    const name = element.localName.toLowerCase();
    if (DROPPED.has(name)) continue;
    if (name === 'en-media') {
      const media = mediaElement(element, options);
      if (media) to.appendChild(media);
      continue;
    }
    if (name === 'en-todo') {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.disabled = true;
      box.checked = element.getAttribute('checked') === 'true';
      to.appendChild(box);
      continue;
    }
    if (name === 'en-crypt') {
      const note = document.createElement('span');
      note.textContent = '[Encrypted Evernote content]';
      to.appendChild(note);
      continue;
    }
    if (!ELEMENTS.has(name)) {
      // An element this view does not know: its text is still worth showing.
      copyChildren(element, to, options, state, depth + 1);
      continue;
    }
    if (name === 'img') {
      const image = imageElement(element, options, state);
      if (image) to.appendChild(image);
      continue;
    }
    const copy = document.createElement(name);
    copyAttributes(element, copy, options, state);
    if (name === 'a') {
      const href = element.getAttribute('href')?.trim() ?? '';
      if (LINK.test(href)) copy.setAttribute('href', href);
      copy.setAttribute('rel', 'noopener noreferrer');
    }
    copyChildren(element, copy, options, state, depth + 1);
    to.appendChild(copy);
  }
}

function copyAttributes(
  from: Element,
  to: HTMLElement,
  options: ClipOptions,
  state: { blockedRemote: number },
) {
  for (const attribute of from.attributes) {
    const name = attribute.name.toLowerCase();
    if (ATTRIBUTES.has(name)) to.setAttribute(name, attribute.value);
  }
  const style = from.getAttribute('style');
  if (style) {
    const cleaned = sanitizeStyle(style, options.allowRemote, state);
    if (cleaned) to.setAttribute('style', cleaned);
  }
}

function imageElement(element: Element, options: ClipOptions, state: { blockedRemote: number }) {
  const source = element.getAttribute('src')?.trim() ?? '';
  const remote = REMOTE.test(source);
  if (!EMBEDDED_IMAGE.test(source) && !remote) return null;
  if (remote && !options.allowRemote) {
    state.blockedRemote += 1;
    return null;
  }
  const image = document.createElement('img');
  copyAttributes(element, image, options, state);
  image.setAttribute('src', source);
  image.setAttribute('referrerpolicy', 'no-referrer');
  image.setAttribute('loading', 'lazy');
  return image;
}

/** An attachment of the note: shown when it is an image, named otherwise. */
function mediaElement(element: Element, options: ClipOptions) {
  const resource = options.resource(element.getAttribute('hash') ?? '');
  const mime = (resource?.mime ?? element.getAttribute('type') ?? '').toLowerCase();
  if (!resource || !mime.startsWith('image/')) {
    const label = document.createElement('span');
    label.className = 'clip-attachment';
    label.textContent = resource?.name ?? 'Attachment';
    return label;
  }
  const image = document.createElement('img');
  copyAttributes(element, image, { ...options, allowRemote: false }, { blockedRemote: 0 });
  image.setAttribute('src', resource.url);
  image.setAttribute('alt', element.getAttribute('alt') ?? resource.name);
  image.setAttribute('loading', 'lazy');
  return image;
}

/**
 * Keeps the declarations of an inline style that only affect how the element
 * looks inside the clipping. Left out are those that would let it cover the
 * application (`position: fixed`), size itself by the window (`100vh`), run
 * code in old engines, or request something from the web unasked.
 */
export function sanitizeStyle(style: string, allowRemote: boolean, state = { blockedRemote: 0 }): string {
  const kept: string[] = [];
  for (const { name, value } of splitDeclarations(style)) {
    if (!/^(--)?[a-z][a-z0-9-]*$/.test(name)) continue;
    const lower = value.toLowerCase();
    if (/expression\s*\(|javascript:|vbscript:|@import|\\/.test(lower)) continue;
    if (name === 'behavior' || name === '-moz-binding') continue;
    if (name === 'position' && /fixed|sticky/.test(lower)) continue;
    if (/\d(vh|vw|vmin|vmax|dvh|svh|lvh)\b/.test(lower)) continue;
    const reference = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
    const addresses = [...lower.matchAll(reference)].map((match) => match[2] ?? '');
    // Whatever else could name a resource: a malformed url(), image-set("…").
    const rest = lower.replace(reference, '');
    if (/url\(|image-set|cross-fade|src\(|\/\//.test(rest)) continue;
    if (addresses.some((address) => !EMBEDDED_IMAGE.test(address) && !REMOTE.test(address))) continue;
    if (addresses.some((address) => REMOTE.test(address)) && !allowRemote) {
      state.blockedRemote += 1;
      continue;
    }
    kept.push(`${name}:${value}`);
  }
  return kept.join(';');
}

/**
 * Splits an inline style into declarations. A plain split on `;` would cut
 * `url(data:image/png;base64,…)` in two, so brackets and quotes are followed.
 */
function splitDeclarations(style: string): { name: string; value: string }[] {
  const declarations: { name: string; value: string }[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  const finish = () => {
    const colon = current.indexOf(':');
    if (colon > 0) {
      const name = current.slice(0, colon).trim().toLowerCase();
      const value = current.slice(colon + 1).trim();
      if (name && value) declarations.push({ name, value });
    }
    current = '';
  };
  for (const character of style) {
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth = Math.max(0, depth - 1);
    } else if (character === ';' && depth === 0) {
      finish();
      continue;
    }
    current += character;
  }
  finish();
  return declarations;
}

function decodeEntities(text: string): string {
  return text
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}
