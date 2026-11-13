import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  /** Styles the item as destructive. */
  danger?: boolean;
  /** Draws a divider above the item. */
  separated?: boolean;
  /** A non-interactive heading for the items that follow. */
  heading?: boolean;
  /** Marks the current choice in a group, such as the stack a notebook is in. */
  checked?: boolean;
}

interface Props {
  /** Where the menu was asked for, in viewport coordinates. */
  position: { x: number; y: number };
  items: MenuItem[];
  label: string;
  onClose: () => void;
}

/**
 * A menu opened by right-click or by a "more" button. It is rendered at the
 * document root so that no scrolling container can clip it, stays inside the
 * viewport, and is operable with the arrow keys.
 */
export function ContextMenu({ position, items, label, onClose }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);

  const place = useCallback(() => {
    const box = menu.current?.getBoundingClientRect();
    if (!box) return;
    const margin = 8;
    setPlaced({
      left: Math.max(margin, Math.min(position.x, window.innerWidth - box.width - margin)),
      top: Math.max(margin, Math.min(position.y, window.innerHeight - box.height - margin)),
    });
  }, [position.x, position.y]);

  useLayoutEffect(place, [place, items.length]);

  useEffect(() => {
    const first = menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    first?.focus({ preventScroll: true });
    const dismiss = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    // A change of the window's size does not close the menu: it is put
    // back inside the window. On a phone the keyboard closes when the menu
    // takes the focus, which is such a change, and would close the menu
    // the moment it had opened.
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose, place]);

  const move = (step: number) => {
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + step + buttons.length) % buttons.length]?.focus();
  };

  return createPortal(
    <div
      ref={menu}
      className="context-menu"
      role="menu"
      aria-label={label}
      style={{ left: placed?.left ?? position.x, top: placed?.top ?? position.y, opacity: placed ? 1 : 0 }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          move(1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          move(-1);
        }
      }}
    >
      {items.map((item, index) =>
        item.heading ? (
          <div key={`${item.label}-${index}`} className="context-menu-heading" role="presentation">
            {item.label}
          </div>
        ) : (
          <button
            key={`${item.label}-${index}`}
            role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={item.checked}
            className={[
              item.danger ? 'danger' : '',
              item.separated ? 'separated' : '',
              item.checked ? 'checked' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect?.();
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
