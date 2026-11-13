import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  MoreHorizontal,
  MoveHorizontal,
  PenLine,
  RotateCcw,
} from 'lucide-react';
import { useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react';

import { type ImageAlignment, type ImageChange, readImageLayout } from './imageLayout';
import type { PictureMatch } from './recognition';

interface Props {
  url: string;
  name: string;
  alt: string;
  /** The `en-media` attributes that say how the picture is sized and placed. */
  attributes: { width?: unknown; height?: unknown; style?: unknown };
  /** Whether the note can be changed and this picture is the selection. */
  editing: boolean;
  onChange: (change: ImageChange) => void;
  /** Whether the picture is a sketch, whose strokes can be changed. */
  sketch: boolean;
  /** What a search found in the picture's text, and whether it is the match stepped to. */
  found: { found: PictureMatch; active: boolean } | null;
  /** Opens the picture for drawing on. */
  onAnnotate: () => void;
  onMenu: (event: MouseEvent) => void;
  /** The picture's file could not be loaded. */
  onMissing: () => void;
}

const SMALLEST = 40;

/**
 * A picture in a note, at the size and in the place the note gives it.
 *
 * A picture without an alignment flows with the text, so two small pictures
 * stand side by side and wrap on a narrow screen. While it is selected in a
 * note that can be edited, it can be dragged to any width by its corner,
 * keeping its proportions, and placed left, centre, right, or across the
 * whole width.
 */
export function ImageAttachment({
  url,
  name,
  alt,
  attributes,
  editing,
  onChange,
  sketch,
  found,
  onAnnotate,
  onMenu,
  onMissing,
}: Props) {
  const layout = readImageLayout(attributes);
  const box = useRef<HTMLSpanElement>(null);
  const [dragged, setDragged] = useState<number | null>(null);

  const resize = (event: PointerEvent<HTMLSpanElement>) => {
    const picture = box.current;
    // The line the picture stands in; it cannot become wider than that.
    const line = picture?.closest('p, li, td, th, blockquote, .note-prose');
    if (!picture || !line) return;
    // The editor would otherwise start dragging the picture itself.
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const from = event.clientX;
    const start = picture.getBoundingClientRect().width;
    const widest = line.clientWidth;
    // The corner follows the pointer: a centred picture grows on both sides,
    // and one on the right is held by its left corner.
    const pull = layout.alignment === 'center' ? 2 : layout.alignment === 'right' ? -1 : 1;
    let width = start;
    const move = (moved: globalThis.PointerEvent) => {
      width = Math.min(widest, Math.max(SMALLEST, start + (moved.clientX - from) * pull));
      setDragged(width);
    };
    const finish = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      setDragged(null);
      if (Math.round(width) !== Math.round(start)) onChange({ width });
    };
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  };

  const place = (alignment: ImageAlignment) =>
    // Placing a picture that fills the width gives it its own size back.
    onChange(layout.fill ? { alignment, width: null } : { alignment });

  const width = dragged !== null ? `${Math.round(dragged)}px` : layout.width;
  const style: CSSProperties = width ? { width } : {};
  const tool = (
    label: string,
    active: boolean,
    action: () => void,
    icon: React.ReactNode,
    disabled = false,
  ) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={action}
    >
      {icon}
    </button>
  );

  return (
    <span
      ref={box}
      className={`attachment attachment-image ${width ? 'sized' : ''}`}
      style={style}
      data-drag-handle
    >
      <img
        src={url}
        alt={alt || name}
        style={layout.ratio ? { aspectRatio: String(layout.ratio) } : undefined}
        loading="lazy"
        onError={onMissing}
      />
      {found && (
        <span
          className={`image-found ${found.found.whole ? 'whole' : ''} ${found.active ? 'active' : ''}`}
          title={found.found.whole ? 'The text of this picture matches' : undefined}
          data-found={found.found.boxes.length}
        >
          {found.found.boxes.map((word, index) => (
            <span
              key={index}
              style={{
                left: `${word.x * 100}%`,
                top: `${word.y * 100}%`,
                width: `${word.w * 100}%`,
                height: `${word.h * 100}%`,
              }}
            />
          ))}
        </span>
      )}
      <button className="attachment-more icon-button" onClick={onMenu} aria-label={`Actions for ${name}`}>
        <MoreHorizontal />
      </button>
      {editing && (
        <>
          <span
            className="image-tools"
            role="toolbar"
            aria-label="Picture size and placement"
            // Keeps the picture selected while a button is pressed.
            onMouseDown={(event) => event.preventDefault()}
          >
            {tool(
              'Align left',
              !layout.fill && layout.alignment === 'left',
              () => place('left'),
              <AlignLeft />,
            )}
            {tool(
              'Align center',
              !layout.fill && layout.alignment === 'center',
              () => place('center'),
              <AlignCenter />,
            )}
            {tool(
              'Align right',
              !layout.fill && layout.alignment === 'right',
              () => place('right'),
              <AlignRight />,
            )}
            {tool(
              'Fill the width',
              layout.fill,
              () => onChange({ width: layout.fill ? null : 'fill' }),
              <MoveHorizontal />,
            )}
            {tool(
              'Original size',
              false,
              () => onChange({ width: null }),
              <RotateCcw />,
              layout.width === null,
            )}
            <span className="image-tools-rule" />
            {tool(sketch ? 'Edit sketch' : 'Annotate', false, onAnnotate, <PenLine />)}
          </span>
          {!layout.fill && (
            <span
              className="image-resize-handle"
              title="Drag to resize the picture"
              aria-hidden
              onPointerDown={resize}
            />
          )}
        </>
      )}
      {dragged !== null && <span className="image-size-note">{Math.round(dragged)} px wide</span>}
    </span>
  );
}
