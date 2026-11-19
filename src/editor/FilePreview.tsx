import { ChevronLeft, ChevronRight, LoaderCircle, X, ZoomIn, ZoomOut } from 'lucide-react';
import { marked } from 'marked';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { formatBytes } from '../lib/syncProgress';
import { useBackCloses } from '../lib/useBackCloses';
import { leaveField } from '../lib/windowHeight';
import { useLibraryStore } from '../store/useLibraryStore';
import { parseTable, textOfBytes, type PreviewKind } from './attachmentKind';
import { sanitizeClip } from './clipSanitizer';
import { chapterOfAddress, chapterPage, openBook, type Book, type BookFiles } from './epub';
import { followLink } from './followLink';
import { readEntry, urlSource, zipEntries, type ZipEntry } from './zipFile';

interface Props {
  url: string;
  name: string;
  kind: Exclude<PreviewKind, 'pdf'>;
  onClose: () => void;
}

const quiet = (event: SyntheticEvent) => event.stopPropagation();

/** Most of a text that is read and shown; a longer one is shown as far as this. */
const MOST_TEXT = 2 * 1024 * 1024;
/** Most rows of a table, and most files of an archive, that are listed. */
const MOST_ROWS = 5000;
/** The sizes the text can be shown at, as parts of its own size. */
const SIZES = [0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5];

/**
 * How a page from elsewhere is set: a chapter of a book, a text written in
 * Markdown. It is drawn in a tree of its own, so that nothing the
 * application styles reaches it and nothing in it reaches the application.
 */
const PAGE_STYLE = `
  :host { display: block; }
  .page {
    box-sizing: border-box;
    max-width: 46em;
    margin: 0 auto;
    padding: 1.6em 1.5em 3em;
    color: var(--page-ink);
    font: 1em/1.65 Georgia, 'Times New Roman', serif;
    overflow-wrap: anywhere;
  }
  h1, h2, h3, h4, h5, h6 { margin: 1.4em 0 0.5em; font-family: Inter, system-ui, sans-serif; line-height: 1.25; }
  h1 { font-size: 1.7em; } h2 { font-size: 1.35em; } h3 { font-size: 1.15em; }
  h4, h5, h6 { font-size: 1em; }
  .page > :first-child { margin-top: 0; }
  p { margin: 0 0 0.9em; }
  img { max-width: 100%; height: auto; }
  a { color: var(--page-link); cursor: pointer; }
  a:not([href]) { color: inherit; cursor: text; text-decoration: none; }
  blockquote { margin: 0 0 0.9em; padding: 0 0 0 1em; border-left: 3px solid var(--page-line); color: var(--page-muted); }
  pre, code, kbd, samp { font-family: 'JetBrains Mono', Consolas, 'Courier New', monospace; font-size: 0.88em; }
  pre { overflow: auto; margin: 0 0 0.9em; padding: 0.8em 1em; border-radius: 6px; background: var(--page-shade); }
  :not(pre) > code { padding: 0.1em 0.3em; border-radius: 4px; background: var(--page-shade); }
  table { border-collapse: collapse; margin: 0 0 0.9em; }
  th, td { padding: 0.3em 0.6em; border: 1px solid var(--page-line); vertical-align: top; }
  hr { border: 0; border-top: 1px solid var(--page-line); margin: 1.5em 0; }
  ul, ol { margin: 0 0 0.9em; padding-left: 1.6em; }
  li > p { margin-bottom: 0.3em; }
`;

/** A page from elsewhere, drawn in a tree of its own. */
function Page({
  content,
  onLink,
}: {
  content: DocumentFragment;
  onLink: (address: string, text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const root = element.shadowRoot ?? element.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PAGE_STYLE;
    const page = document.createElement('div');
    page.className = 'page';
    // A copy: what is put into a page is taken out of where it was.
    page.appendChild(content.cloneNode(true));
    root.replaceChildren(style, page);
    const open = (event: Event) => {
      const anchor = (event.target as Element | null)?.closest?.('a');
      if (!anchor) return;
      // A link in here is followed by Bever, never by the web view.
      event.preventDefault();
      const address = anchor.getAttribute('href');
      if (address) onLink(address, anchor.textContent ?? '');
    };
    root.addEventListener('click', open);
    return () => root.removeEventListener('click', open);
  }, [content, onLink]);
  return <div className="preview-page" ref={host} />;
}

type Loaded =
  | { kind: 'text' | 'markdown' | 'table'; text: string; cut: boolean }
  | { kind: 'archive'; entries: ZipEntry[] }
  | { kind: 'book'; book: Book; files: BookFiles };

async function load(url: string, kind: Props['kind']): Promise<Loaded> {
  const source = await urlSource(url);
  if (kind === 'archive' || kind === 'book') {
    const entries = await zipEntries(source);
    if (kind === 'archive') return { kind, entries };
    const byName = new Map(entries.filter((entry) => !entry.directory).map((entry) => [entry.name, entry]));
    const files: BookFiles = {
      has: (path) => byName.has(path),
      read: (path) => {
        const entry = byName.get(path);
        return entry ? readEntry(source, entry) : Promise.reject(new Error('The book has no such file.'));
      },
    };
    return { kind, book: await openBook(files), files };
  }
  const bytes = await source.read(0, Math.min(source.size, MOST_TEXT));
  return { kind, text: textOfBytes(bytes), cut: source.size > MOST_TEXT };
}

/**
 * An attachment to read where it is: a text, a text written in Markdown, a
 * table of text, the chapters of an EPUB book, the list of what an archive
 * holds. Read on the device; nothing of the file leaves it, and nothing it
 * names on the web is fetched unless images from the web are allowed.
 *
 * It lies over the whole window, as the PDF preview does.
 */
export function FilePreview({ url, name, kind, onClose }: Props) {
  const allowRemote = useLibraryStore((state) => state.settings.loadRemoteImages);
  const scroller = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Whether a Markdown text or a table is shown as it is written, not as it reads. */
  const [plain, setPlain] = useState(false);
  const [size, setSize] = useState(SIZES.indexOf(1));
  const [chapter, setChapter] = useState(0);
  /** The page of a chapter of a book, and which chapter it is the page of. */
  const [read, setRead] = useState<{ chapter: number; content: DocumentFragment } | null>(null);
  useBackCloses(true, onClose);

  useEffect(() => {
    let current = true;
    load(url, kind).then(
      (result) => current && setLoaded(result),
      (reason: unknown) =>
        current &&
        setError(
          `${reason instanceof Error ? reason.message : 'This file could not be previewed.'} Use Open or Save As to access the original file.`,
        ),
    );
    return () => {
      current = false;
    };
  }, [url, kind]);

  // The keys go to what is shown, so that they scroll it, and a field of the
  // note under this keeps no keyboard up over it.
  useEffect(() => {
    const giveBack = leaveField();
    scroller.current?.focus();
    return giveBack;
  }, []);

  // The chapter of a book that is being read.
  const book = loaded?.kind === 'book' ? loaded : null;
  useEffect(() => {
    if (!book) return;
    let current = true;
    let release: (() => void) | undefined;
    chapterPage(book.files, book.book, chapter).then(
      (result) => {
        if (!current) return result.release();
        release = result.release;
        setRead({ chapter, content: result.content });
        scroller.current?.scrollTo({ top: 0 });
      },
      () => current && setError('This chapter could not be read.'),
    );
    return () => {
      current = false;
      release?.();
    };
  }, [book, chapter]);

  // The page that is there is the chapter's own only once that has been read.
  const page = read?.chapter === chapter ? read.content : null;
  const chapters = book?.book.chapters ?? [];
  const goTo = useCallback(
    (index: number) => {
      if (index >= 0 && index < chapters.length) {
        setError(null);
        setChapter(index);
      }
    },
    [chapters.length],
  );
  const follow = useCallback(
    (address: string, text: string) => {
      const place = chapterOfAddress(address);
      if (place !== null) goTo(place);
      else followLink(address, text);
    },
    [goTo],
  );

  // A text written in Markdown, as it reads.
  const markdown = loaded?.kind === 'markdown' && !plain ? loaded.text : null;
  const written = useMemo(() => {
    if (markdown === null) return null;
    const html = marked
      .parse(markdown, { async: false, gfm: true })
      // A list of things to do keeps its boxes as the marks they are.
      .replace(/<input\b[^>]*\bchecked\b[^>]*>/gi, '☑')
      .replace(/<input\b[^>]*type="checkbox"[^>]*>/gi, '☐');
    return sanitizeClip(html, { resource: () => null, allowRemote }).content;
  }, [markdown, allowRemote]);

  const table = useMemo(
    () => (loaded?.kind === 'table' && !plain ? parseTable(loaded.text, MOST_ROWS) : null),
    [loaded, plain],
  );

  let body: ReactNode = null;
  let note: string | null = null;
  if (loaded?.kind === 'archive') {
    const files = loaded.entries.filter((entry) => !entry.directory);
    const total = files.reduce((sum, entry) => sum + entry.size, 0);
    note = `${files.length.toLocaleString()} ${files.length === 1 ? 'file' : 'files'}, ${formatBytes(total)} unpacked${
      files.length > MOST_ROWS ? `; the first ${MOST_ROWS.toLocaleString()} are listed` : ''
    }`;
    body = (
      <table className="preview-table preview-files">
        <thead>
          <tr>
            <th>Name</th>
            <th>Size</th>
          </tr>
        </thead>
        <tbody>
          {files.slice(0, MOST_ROWS).map((entry, index) => (
            <tr key={index}>
              <td>{entry.name}</td>
              <td>{formatBytes(entry.size)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else if (book) {
    const next = chapters[chapter + 1];
    body = page ? (
      <>
        <Page content={page} onLink={follow} />
        {next && (
          <button className="preview-next" onClick={() => goTo(chapter + 1)}>
            Next: {next.title} <ChevronRight />
          </button>
        )}
      </>
    ) : null;
  } else if (written) {
    body = <Page content={written} onLink={follow} />;
  } else if (table) {
    const columns = Math.max(1, ...table.rows.map((row) => row.length));
    if (table.more) note = `The first ${MOST_ROWS.toLocaleString()} rows are shown`;
    body = (
      <table className="preview-table">
        <tbody>
          {table.rows.map((row, index) => (
            <tr key={index}>
              {Array.from({ length: columns }, (_, column) =>
                index === 0 ? (
                  <th key={column}>{row[column] ?? ''}</th>
                ) : (
                  <td key={column}>{row[column] ?? ''}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else if (loaded && loaded.kind !== 'book') {
    body = <pre className={`preview-text ${loaded.kind === 'text' ? '' : 'wrapped'}`}>{loaded.text}</pre>;
  }
  if (loaded && 'cut' in loaded && loaded.cut) {
    note = [note, `Only the first ${formatBytes(MOST_TEXT)} of this file are shown`]
      .filter(Boolean)
      .join('. ');
  }

  const busy = !error && (!loaded || (book !== null && !page));
  const sized = loaded !== null && loaded.kind !== 'archive';
  const bothWays = loaded?.kind === 'markdown' || loaded?.kind === 'table';

  return createPortal(
    <div
      className="modal-backdrop pdf-backdrop"
      onMouseDown={(event) => {
        event.stopPropagation();
        onClose();
      }}
      // It lies over the window, but to React it is still inside the note
      // it was opened from: what happens here is not the note's to answer.
      onClick={quiet}
      onDoubleClick={quiet}
      onContextMenu={quiet}
      onPointerDown={quiet}
      onKeyDown={quiet}
    >
      <section
        className={`modal pdf-modal file-preview ${book ? 'paper' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={`Preview ${name}`}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          } else if (event.target instanceof HTMLSelectElement) {
            // Choosing a chapter.
          } else if (sized && (event.key === '+' || event.key === '=')) {
            event.preventDefault();
            setSize((value) => Math.min(SIZES.length - 1, value + 1));
          } else if (sized && event.key === '-') {
            event.preventDefault();
            setSize((value) => Math.max(0, value - 1));
          } else if (sized && event.key === '0') {
            event.preventDefault();
            setSize(SIZES.indexOf(1));
          } else if (book && event.key === 'ArrowRight') {
            goTo(chapter + 1);
          } else if (book && event.key === 'ArrowLeft') {
            goTo(chapter - 1);
          }
        }}
      >
        <header>
          <strong title={name}>{book?.book.title || name}</strong>
          <div className="pdf-controls">
            {book && (
              <>
                <button
                  className="icon-button"
                  disabled={chapter <= 0}
                  onClick={() => goTo(chapter - 1)}
                  aria-label="Previous chapter"
                  title="Previous chapter (←)"
                >
                  <ChevronLeft />
                </button>
                <select
                  className="preview-chapters"
                  aria-label="Chapter"
                  title="Go to a chapter"
                  value={chapter}
                  onChange={(event) => goTo(Number(event.target.value))}
                >
                  {chapters.map((item, index) => (
                    <option key={index} value={index}>
                      {item.title}
                    </option>
                  ))}
                </select>
                <button
                  className="icon-button"
                  disabled={chapter >= chapters.length - 1}
                  onClick={() => goTo(chapter + 1)}
                  aria-label="Next chapter"
                  title="Next chapter (→)"
                >
                  <ChevronRight />
                </button>
              </>
            )}
            {bothWays && (
              <button
                className="preview-as"
                aria-pressed={plain}
                onClick={() => setPlain(!plain)}
                title={plain ? 'Show it as it reads' : 'Show it as it is written'}
              >
                {plain ? 'Formatted' : 'As text'}
              </button>
            )}
            {sized && (
              <>
                <button
                  className="icon-button"
                  disabled={size <= 0}
                  onClick={() => setSize(size - 1)}
                  aria-label="Make the text smaller"
                  title="Smaller (−)"
                >
                  <ZoomOut />
                </button>
                <button
                  className="icon-button"
                  disabled={size >= SIZES.length - 1}
                  onClick={() => setSize(size + 1)}
                  aria-label="Make the text larger"
                  title="Larger (+)"
                >
                  <ZoomIn />
                </button>
              </>
            )}
            <button className="icon-button" onClick={onClose} aria-label="Close preview">
              <X />
            </button>
          </div>
        </header>
        <div className="pdf-frame">
          <div
            className="preview-scroll"
            ref={scroller}
            tabIndex={0}
            aria-busy={busy}
            aria-label={name}
            style={{ fontSize: `${15 * (SIZES[size] ?? 1)}px` }}
          >
            {!error && note && <p className="preview-note">{note}.</p>}
            {!error && body}
          </div>
          {busy && <LoaderCircle className="spin" aria-label="Loading preview" />}
          {error && <p role="alert">{error}</p>}
        </div>
      </section>
    </div>,
    document.body,
  );
}
