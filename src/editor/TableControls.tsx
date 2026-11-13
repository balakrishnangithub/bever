import type { Editor } from '@tiptap/core';
import {
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  ChevronDown,
  Columns3,
  Combine,
  Rows3,
  Split,
  Table2,
  Trash2,
} from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { ContextMenu, type MenuItem } from '../components/ContextMenu';

/** Largest table the picker offers; rows and columns can be added afterwards. */
const MAX_COLUMNS = 8;
const MAX_ROWS = 8;

interface TableInfo {
  rows: number;
  columns: number;
  headerRow: boolean;
  headerColumn: boolean;
}

/** Shape of the table the cursor is in. */
function tableInfo(editor: Editor): TableInfo | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const table = $from.node(depth);
    if (table.type.name !== 'table' || !table.childCount) continue;
    let columns = 0;
    table.child(0).forEach((cell) => {
      columns += Number(cell.attrs.colspan ?? 1);
    });
    let headerRow = true;
    table.child(0).forEach((cell) => {
      if (cell.type.name !== 'tableHeader') headerRow = false;
    });
    let headerColumn = true;
    table.forEach((row) => {
      if (row.firstChild?.type.name !== 'tableHeader') headerColumn = false;
    });
    return { rows: table.childCount, columns, headerRow, headerColumn };
  }
  return null;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Everything that can be done to the table the cursor is in, by name. */
function tableMenuItems(editor: Editor): MenuItem[] {
  const info = tableInfo(editor);
  if (!info) return [];
  const run = (command: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => () => {
    command(editor.chain().focus()).run();
  };
  return [
    { label: `${plural(info.columns, 'column')} × ${plural(info.rows, 'row')}`, heading: true },
    {
      label: 'Insert row above',
      icon: <BetweenHorizontalEnd />,
      onSelect: run((chain) => chain.addRowBefore()),
    },
    {
      label: 'Insert row below',
      icon: <BetweenHorizontalStart />,
      onSelect: run((chain) => chain.addRowAfter()),
    },
    {
      label: 'Insert column left',
      icon: <BetweenVerticalEnd />,
      onSelect: run((chain) => chain.addColumnBefore()),
    },
    {
      label: 'Insert column right',
      icon: <BetweenVerticalStart />,
      onSelect: run((chain) => chain.addColumnAfter()),
    },
    {
      label: 'Delete row',
      icon: <Rows3 />,
      separated: true,
      disabled: info.rows < 2,
      onSelect: run((chain) => chain.deleteRow()),
    },
    {
      label: 'Delete column',
      icon: <Columns3 />,
      disabled: info.columns < 2,
      onSelect: run((chain) => chain.deleteColumn()),
    },
    {
      label: 'Header row',
      separated: true,
      checked: info.headerRow,
      onSelect: run((chain) => chain.toggleHeaderRow()),
    },
    {
      label: 'Header column',
      checked: info.headerColumn,
      onSelect: run((chain) => chain.toggleHeaderColumn()),
    },
    {
      label: 'Merge selected cells',
      icon: <Combine />,
      separated: true,
      disabled: !editor.can().mergeCells(),
      onSelect: run((chain) => chain.mergeCells()),
    },
    {
      label: 'Split cell',
      icon: <Split />,
      disabled: !editor.can().splitCell(),
      onSelect: run((chain) => chain.splitCell()),
    },
    {
      label: 'Delete table',
      icon: <Trash2 />,
      separated: true,
      danger: true,
      onSelect: run((chain) => chain.deleteTable()),
    },
  ];
}

/**
 * The toolbar's table button. Outside a table it offers a grid on which the
 * size of a new table is chosen; the table tools appear once the cursor is
 * in one (see `TableMenuButton`).
 */
export function InsertTableButton({ editor, disabled }: { editor: Editor; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState({ columns: 3, rows: 3 });
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const box = popover.current?.getBoundingClientRect();
      if (!anchor || !box) return;
      const margin = 8;
      const below = anchor.bottom + 6;
      setPosition({
        left: Math.min(
          Math.max(margin, anchor.left + anchor.width / 2 - box.width / 2),
          window.innerWidth - box.width - margin,
        ),
        top:
          below + box.height <= window.innerHeight - margin
            ? below
            : Math.max(margin, anchor.top - box.height - 6),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !popover.current?.contains(target)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  const insert = (columns: number, rows: number) => {
    setOpen(false);
    editor.chain().focus().insertTable({ rows, cols: columns, withHeaderRow: true }).run();
  };
  const focusCell = (columns: number, rows: number) => {
    setSize({ columns, rows });
    popover.current
      ?.querySelector<HTMLButtonElement>(`[data-cell="${columns}x${rows}"]`)
      ?.focus({ preventScroll: true });
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`toolbar-button ${open ? 'active' : ''}`}
        title="Insert table"
        aria-label="Insert table"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-haspopup="dialog"
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setSize({ columns: 3, rows: 3 });
          setOpen((value) => !value);
        }}
      >
        <Table2 />
      </button>
      {open &&
        createPortal(
          <div
            ref={popover}
            id={id}
            className="table-picker"
            role="dialog"
            aria-label="Insert table"
            style={{ left: position?.left ?? 8, top: position?.top ?? 8, opacity: position ? 1 : 0 }}
            onKeyDown={(event) => {
              const step: Record<string, [number, number]> = {
                ArrowRight: [1, 0],
                ArrowLeft: [-1, 0],
                ArrowDown: [0, 1],
                ArrowUp: [0, -1],
              };
              if (event.key === 'Escape') {
                event.stopPropagation();
                setOpen(false);
                trigger.current?.focus({ preventScroll: true });
              } else {
                const move = step[event.key];
                if (!move) return;
                event.preventDefault();
                focusCell(
                  Math.min(MAX_COLUMNS, Math.max(1, size.columns + move[0])),
                  Math.min(MAX_ROWS, Math.max(1, size.rows + move[1])),
                );
              }
            }}
          >
            <strong>Insert table</strong>
            <div
              className="table-picker-grid"
              style={{ gridTemplateColumns: `repeat(${MAX_COLUMNS}, 1fr)` }}
              onPointerLeave={() => setSize({ columns: 3, rows: 3 })}
            >
              {Array.from({ length: MAX_ROWS * MAX_COLUMNS }, (_, index) => {
                const column = (index % MAX_COLUMNS) + 1;
                const row = Math.floor(index / MAX_COLUMNS) + 1;
                return (
                  <button
                    type="button"
                    key={index}
                    data-cell={`${column}x${row}`}
                    className={column <= size.columns && row <= size.rows ? 'chosen' : ''}
                    aria-label={`${plural(column, 'column')} by ${plural(row, 'row')}`}
                    // The grid is one stop in the tab order; arrows move within it.
                    tabIndex={column === size.columns && row === size.rows ? 0 : -1}
                    onPointerEnter={() => setSize({ columns: column, rows: row })}
                    onFocus={() => setSize({ columns: column, rows: row })}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insert(column, row)}
                  />
                );
              })}
            </div>
            <span aria-live="polite">
              {plural(size.columns, 'column')} × {plural(size.rows, 'row')}
            </span>
            <small>Rows and columns can be added or removed later from the Table menu.</small>
          </div>,
          document.body,
        )}
    </>
  );
}

/** Named table tools, offered in the toolbar while the cursor is in a table. */
export function TableMenuButton({ editor }: { editor: Editor }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const info = tableInfo(editor);
  if (!info) return null;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`toolbar-button toolbar-labelled ${menu ? 'active' : ''}`}
        title="Change this table: rows, columns, header, delete"
        aria-label="Table options"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          const box = trigger.current?.getBoundingClientRect();
          if (box) setMenu({ x: box.left, y: box.bottom + 5 });
        }}
      >
        <Table2 />
        <span>Table</span>
        <ChevronDown />
      </button>
      {menu && (
        <ContextMenu
          position={menu}
          items={tableMenuItems(editor)}
          label="Table options"
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
