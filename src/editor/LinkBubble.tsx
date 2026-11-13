import { Copy, ExternalLink, FileText, Pencil, Unlink } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface LinkTarget {
  href: string;
  text: string;
  /** Where the link is on screen: the bubble appears just below it. */
  x: number;
  y: number;
  /** The link itself, so that the bubble can follow it when the page moves. */
  anchor?: Element;
}

interface Props {
  link: LinkTarget;
  onOpen: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onRemove: () => void;
  onClose: () => void;
}

/**
 * What can be done with the link that was just clicked while writing.
 *
 * In a note that is being edited, a click on a link has to place the cursor
 * there, or the link's text could not be changed. Opening the link at once
 * instead would make every correction of a link a trip to the browser and
 * back. The bubble offers both: open it, or change it.
 */
export function LinkBubble({ link, onOpen, onEdit, onCopy, onRemove, onClose }: Props) {
  const bubble = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);
  const internal = link.href.startsWith('bever://note/');

  // The bubble is placed below the link, inside the window. On a phone the
  // keyboard opens right after the tap that brought the bubble, which makes
  // the window smaller and moves the note: the bubble then goes where the
  // link has gone. It closes only when the link is no longer to be seen.
  const place = useCallback(() => {
    const box = bubble.current?.getBoundingClientRect();
    if (!box) return;
    let { x, y } = link;
    if (link.anchor) {
      if (!link.anchor.isConnected) {
        onClose();
        return;
      }
      const at = link.anchor.getBoundingClientRect();
      if (at.bottom < 0 || at.top > window.innerHeight) {
        onClose();
        return;
      }
      x = at.left;
      y = at.bottom + 6;
    }
    const margin = 8;
    setPlaced({
      left: Math.max(margin, Math.min(x, window.innerWidth - box.width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - box.height - margin)),
    });
  }, [link, onClose]);

  useLayoutEffect(place, [place]);

  useEffect(() => {
    const dismiss = (event: Event) => {
      const target = event.target as Element | null;
      // A click on another link moves the bubble instead of closing it.
      if (!bubble.current?.contains(target) && !target?.closest?.('.note-prose a')) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // Without the link to follow, a bubble that stays where it was would
    // point at nothing once the page has moved.
    const moved = link.anchor ? place : onClose;
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('resize', moved);
    window.addEventListener('scroll', moved, true);
    window.visualViewport?.addEventListener('resize', moved);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', moved);
      window.removeEventListener('scroll', moved, true);
      window.visualViewport?.removeEventListener('resize', moved);
    };
  }, [onClose, place, link.anchor]);

  return createPortal(
    <div
      ref={bubble}
      className="link-bubble"
      role="toolbar"
      aria-label="Link"
      style={{ left: placed?.left ?? link.x, top: placed?.top ?? link.y, opacity: placed ? 1 : 0 }}
      // Keeps the cursor in the link while a button is pressed.
      onMouseDown={(event) => event.preventDefault()}
    >
      <span className="link-bubble-address" title={internal ? undefined : link.href}>
        {internal ? 'Link to a note' : link.href}
      </span>
      <button onClick={onOpen}>
        {internal ? <FileText /> : <ExternalLink />}
        {internal ? 'Open note' : 'Open'}
      </button>
      <button onClick={onEdit}>
        <Pencil />
        {internal ? 'Change' : 'Edit'}
      </button>
      {!internal && (
        <button onClick={onCopy} title="Copy the address">
          <Copy />
          Copy
        </button>
      )}
      <button onClick={onRemove} title="Keep the text, remove the link">
        <Unlink />
        Remove
      </button>
      <small className="link-bubble-hint">Ctrl+click opens a link directly</small>
    </div>,
    document.body,
  );
}
