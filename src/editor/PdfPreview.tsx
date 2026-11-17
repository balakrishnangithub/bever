import { ChevronDown, ChevronUp, LoaderCircle, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';

import { useBackCloses } from '../lib/useBackCloses';
import { leaveField } from '../lib/windowHeight';
import { MAX_ZOOM, MIN_ZOOM } from './pdfGeometry';
import { PdfView } from './pdfView';

interface Props {
  url: string;
  name: string;
  onClose: () => void;
}

const quiet = (event: SyntheticEvent) => event.stopPropagation();

/** How much a press of a zoom button changes the size. */
const STEP = 1.25;

/**
 * A PDF to read where it is: its pages one under another, to scroll through
 * and to make larger. Drawn on the device; nothing of the document leaves it.
 *
 * It lies over the whole window and not in the note it was opened from. In
 * the note, two fingers on it made the note larger, and the preview with it,
 * from the note's corner.
 */
export function PdfPreview({ url, name, onClose }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const view = useRef<PdfView | null>(null);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  /** What is being typed for the page to go to, while it is being typed. */
  const [typedPage, setTypedPage] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useBackCloses(true, onClose);

  useEffect(() => {
    let cancelled = false;
    let destroy: (() => void) | undefined;
    const failed = () => {
      if (cancelled) return;
      setError('This PDF could not be previewed. Use Open or Save As to access the original file.');
      setLoading(false);
    };
    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url,
        ).toString();
        const task = pdfjs.getDocument({ url, withCredentials: false });
        destroy = () => void task.destroy();
        const loaded = await task.promise;
        if (cancelled || !scroller.current || !pages.current) return;
        setPageCount(loaded.numPages);
        const shown = new PdfView(scroller.current, pages.current, loaded, {
          onPage: setPage,
          onZoom: setZoom,
          onShown: () => setLoading(false),
          onFailed: failed,
        });
        view.current = shown;
        await shown.open();
      } catch {
        failed();
      }
    })();
    return () => {
      cancelled = true;
      view.current?.close();
      view.current = null;
      destroy?.();
    };
  }, [url]);

  // The keys go to the pages, so that they scroll them, and a field of the
  // note under this keeps no keyboard up over it.
  useEffect(() => {
    const giveBack = leaveField();
    scroller.current?.focus();
    return giveBack;
  }, []);

  const goTo = (wanted: number) => {
    if (Number.isFinite(wanted) && pageCount)
      view.current?.goToPage(Math.min(pageCount, Math.max(1, wanted)));
  };
  const goToTyped = () => {
    if (typedPage !== null) goTo(Number.parseInt(typedPage, 10));
    setTypedPage(null);
  };

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
        className="modal pdf-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Preview ${name}`}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          } else if (event.target instanceof HTMLInputElement) {
            // Typing a page number.
          } else if (event.key === '+' || event.key === '=') {
            event.preventDefault();
            view.current?.zoomBy(STEP);
          } else if (event.key === '-') {
            event.preventDefault();
            view.current?.zoomBy(1 / STEP);
          } else if (event.key === '0') {
            event.preventDefault();
            view.current?.zoomTo(1);
          }
        }}
      >
        <header>
          <strong title={name}>{name}</strong>
          <div className="pdf-controls">
            <button
              className="icon-button pdf-step"
              disabled={!pageCount || page <= 1}
              onClick={() => goTo(page - 1)}
              aria-label="Previous PDF page"
              title="Previous page"
            >
              <ChevronUp />
            </button>
            <span className="pdf-page-number">
              <input
                type="text"
                inputMode="numeric"
                aria-label="PDF page"
                title="Go to a page"
                disabled={!pageCount}
                value={typedPage ?? String(page)}
                onFocus={(event) => event.target.select()}
                onChange={(event) => setTypedPage(event.target.value.replace(/\D/g, '').slice(0, 6))}
                onBlur={goToTyped}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    goToTyped();
                    scroller.current?.focus();
                  }
                }}
              />
              / {pageCount || '…'}
            </span>
            <button
              className="icon-button pdf-step"
              disabled={!pageCount || page >= pageCount}
              onClick={() => goTo(page + 1)}
              aria-label="Next PDF page"
              title="Next page"
            >
              <ChevronDown />
            </button>
            <button
              className="icon-button pdf-zoom"
              disabled={loading || zoom <= MIN_ZOOM}
              onClick={() => view.current?.zoomBy(1 / STEP)}
              aria-label="Make the PDF smaller"
              title="Smaller (−)"
            >
              <ZoomOut />
            </button>
            <button
              className="pdf-zoom-level"
              disabled={loading}
              onClick={() => view.current?.zoomTo(1)}
              aria-label={`PDF at ${Math.round(zoom * 100)}% of the width. Fit the width`}
              title="Fit the width (0)"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              className="icon-button pdf-zoom"
              disabled={loading || zoom >= MAX_ZOOM}
              onClick={() => view.current?.zoomBy(STEP)}
              aria-label="Make the PDF larger"
              title="Larger (+)"
            >
              <ZoomIn />
            </button>
            <button className="icon-button" onClick={onClose} aria-label="Close PDF preview">
              <X />
            </button>
          </div>
        </header>
        <div className="pdf-frame">
          <div className="pdf-scroll" ref={scroller} tabIndex={0} aria-busy={loading} aria-label={name}>
            <div className="pdf-pages" ref={pages} />
          </div>
          {loading && <LoaderCircle className="spin" aria-label="Loading PDF" />}
          {error && <p role="alert">{error}</p>}
        </div>
      </section>
    </div>,
    document.body,
  );
}
