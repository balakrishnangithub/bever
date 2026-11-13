import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { CodeXml, ExternalLink, Globe, ImageOff, PencilLine } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { resourceUrl } from '../lib/api';
import { dialogs } from '../lib/dialogs';
import { useLibraryStore } from '../store/useLibraryStore';
import { clipInfo, editableMarkup, sanitizeClip } from './clipSanitizer';
import { followLink } from './followLink';

/**
 * Styles of the clipping's own document. The clipping is drawn in a frame of
 * its own: the application's styles do not reach it, its styles do not reach
 * the application, text in it can be selected and copied without the editor
 * taking the selection, and the frame is sandboxed. It is always shown on white: a page clipped from the web states only
 * some of its colours, and would be unreadable on a dark theme.
 */
const FRAME_STYLE = `
  html { color-scheme: light; }
  /* Pages hide the scrollbars of their scrolling strips with style sheets,
     which a clipping does not carry. */
  * { scrollbar-width: thin; scrollbar-color: #c9ced4 transparent; }
  body {
    margin: 0;
    background: #ffffff;
    color: #1f2328;
    font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    overflow-wrap: anywhere;
  }
  .content { display: flow-root; padding: 12px 14px; }
  img { max-width: 100%; height: auto; }
  a { color: #1a5fb4; cursor: pointer; }
  table { border-collapse: collapse; }
  pre { white-space: pre-wrap; }
  .clip-attachment {
    display: inline-block;
    padding: 2px 8px;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    font-size: 13px;
  }
`;

const KINDS: Record<string, string> = {
  fullPage: 'Full page',
  article: 'Article',
  simplified: 'Simplified article',
  selection: 'Selection',
  bookmark: 'Bookmark',
  screenshot: 'Screenshot',
};

/**
 * A web clipping, shown the way it was clipped and not editable in place,
 * as in Evernote. "Make editable" turns it into ordinary note content, which
 * keeps the text, links, images, lists and tables but not the page's layout.
 */
export function WebClipView({ node, editor, getPos, selected }: NodeViewProps) {
  const resources = useLibraryStore((state) => state.selectedNote?.resources);
  const allowed = useLibraryStore((state) => state.settings.loadRemoteImages);
  const [requested, setRequested] = useState(false);
  const [blocked, setBlocked] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const html = String(node.attrs.html ?? '');
  const info = useMemo(() => clipInfo(html), [html]);
  const allowRemote = allowed || requested;
  /** Laid-out markup pasted into the note, as opposed to a clipped page. */
  const pasted = info.kind === 'html';

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let observer: ResizeObserver | null = null;
    let page: Document | null = null;
    const open = (event: Event) => {
      const anchor = (event.target as Element | null)?.closest?.('a');
      if (!anchor) return;
      // Never let the frame itself go anywhere.
      event.preventDefault();
      const href = anchor.getAttribute('href');
      if (href) followLink(href, anchor.textContent ?? '');
    };
    const fill = () => {
      page?.removeEventListener('click', open);
      page = element.contentDocument;
      if (!page) return;
      const clip = sanitizeClip(html, {
        allowRemote,
        resource: (hash) => {
          const resource = resources?.find((item) => item.md5 === hash || item.sha256 === hash);
          return resource
            ? {
                url: resourceUrl(resource.sha256),
                mime: resource.mime,
                name: resource.fileName ?? 'Attachment',
              }
            : null;
        },
      });
      const style = page.createElement('style');
      style.textContent = FRAME_STYLE;
      page.head.replaceChildren(style);
      // The content has a box of its own to be measured by: the frame's
      // document has no doctype, and in such a document `body` is always as
      // tall as the frame, however little is in it.
      const content = page.createElement('div');
      content.className = 'content';
      content.appendChild(clip.content);
      page.body.replaceChildren(content);
      page.addEventListener('click', open);
      setBlocked(clip.blockedRemote);
      // The frame is as tall as its content, so the note scrolls, not the frame.
      const fit = () => {
        element.style.height = `${Math.ceil(content.getBoundingClientRect().height)}px`;
      };
      observer?.disconnect();
      observer = new ResizeObserver(fit);
      observer.observe(content);
      fit();
    };
    fill();
    // A frame's first document can be replaced once it has loaded.
    element.addEventListener('load', fill);
    return () => {
      element.removeEventListener('load', fill);
      page?.removeEventListener('click', open);
      observer?.disconnect();
    };
  }, [html, resources, allowRemote]);

  const makeEditable = async () => {
    const confirmed = await dialogs.confirm({
      title: pasted ? 'Make this content editable?' : 'Make this clipping editable?',
      message: pasted
        ? 'Its text, links and images become ordinary note content that you can edit. Its layout is not kept: a formula, for example, becomes its characters in a row.'
        : 'Its text, links, images, lists and tables become ordinary note content that you can edit. The page layout and styling of the clipping are not kept.',
      confirmLabel: 'Make editable',
    });
    const position = getPos();
    if (!confirmed || position === undefined) return;
    editor
      .chain()
      .focus()
      .insertContentAt({ from: position, to: position + node.nodeSize }, editableMarkup(html))
      .run();
  };

  let host: string | null = null;
  try {
    host = info.sourceUrl ? new URL(info.sourceUrl).host.replace(/^www\./, '') : null;
  } catch {
    // Not an address that can be shown.
  }

  return (
    <NodeViewWrapper className={`web-clip ${selected ? 'selected' : ''}`} contentEditable={false}>
      <div className="web-clip-bar">
        {pasted ? <CodeXml aria-hidden /> : <Globe aria-hidden />}
        <span className="web-clip-label">
          <strong>{pasted ? 'HTML content' : 'Web clip'}</strong>
          <span>
            {pasted
              ? 'Shown with its own layout'
              : [KINDS[info.kind], host].filter(Boolean).join(' · ') || 'Shown as it was clipped'}
          </span>
        </span>
        {blocked > 0 && !allowRemote && (
          <button
            onClick={() => setRequested(true)}
            title="Images that live on the web are not requested until you ask"
          >
            <ImageOff /> Load {blocked} web {blocked === 1 ? 'image' : 'images'}
          </button>
        )}
        {info.sourceUrl && (
          <button onClick={() => followLink(info.sourceUrl ?? '', '')} title={info.sourceUrl}>
            <ExternalLink /> Open original
          </button>
        )}
        {editor.isEditable && (
          <button onClick={() => void makeEditable()}>
            <PencilLine /> Make editable
          </button>
        )}
      </div>
      {/* The frame gets no forms, popups or navigation. Script is permitted only
          so that this view's own click handler runs for the frame; without it
          the browser calls no handler there at all. The clipping itself has
          none: it is rebuilt from known elements without script or event
          attributes, and the content security policy forbids inline script. */}
      <iframe
        ref={frame}
        className="web-clip-frame"
        title={info.sourceTitle ?? (pasted ? 'HTML content' : 'Web clip')}
        sandbox="allow-same-origin allow-scripts"
        referrerPolicy="no-referrer"
      />
    </NodeViewWrapper>
  );
}
