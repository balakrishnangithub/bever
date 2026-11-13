import {
  ArrowLeft,
  ChevronRight,
  Folder,
  FolderPlus,
  Layers3,
  MoreHorizontal,
  Plus,
  Search,
  Tag as TagIcon,
  X,
} from 'lucide-react';
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';

import { byName } from '../lib/nameOrder';
import { tagChildren, tagPath } from '../lib/tagTree';
import { useLibraryStore } from '../store/useLibraryStore';
import { emptyFilter, type Notebook, type Stack, type Tag } from '../types';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { useOrganizeMenus } from './organizeMenus';

export type OrganizerKind = 'notebooks' | 'tags';

type Sort = 'name' | 'count';

interface OpenMenu {
  position: { x: number; y: number };
  label: string;
  items: MenuItem[];
}

const plural = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;

/**
 * All the notebooks, or all the tags, on a screen of their own: to find one
 * by name, to see how many notes each has, and to rename, move, and delete
 * them. The sidebar lists the same things for going to them; this is where
 * they are kept in order.
 */
export function Organizer({ kind, onClose }: { kind: OrganizerKind; onClose: () => void }) {
  const overview = useLibraryStore((state) => state.overview);
  const setFilter = useLibraryStore((state) => state.setFilter);
  const { notebookMenu, stackMenu, tagMenu, newNotebook, newStack, newTag } = useOrganizeMenus();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('name');
  // Stacks begin open and tags closed: a stack holds a few notebooks, a tag
  // may hold hundreds.
  const [closedStacks, setClosedStacks] = useState<Set<string>>(new Set());
  const [openTags, setOpenTags] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const { counts } = overview;
  const wanted = query.trim().toLowerCase();

  const children = useMemo(() => tagChildren(overview.tags), [overview.tags]);
  const notebookCount = (notebook: Notebook) => counts.notebooks[notebook.id] ?? 0;
  const stackCount = (stack: Stack) =>
    overview.notebooks
      .filter((notebook) => notebook.stackId === stack.id)
      .reduce((sum, notebook) => sum + notebookCount(notebook), 0);
  const tagCount = (tag: Tag) => counts.tags[tag.id] ?? 0;
  /** `items` in the order chosen: by name, or the fullest first. */
  const ordered = <T,>(items: T[], name: (item: T) => string, count: (item: T) => number) =>
    [...items].sort((a, b) =>
      sort === 'count' ? count(b) - count(a) || byName(name(a), name(b)) : byName(name(a), name(b)),
    );

  const open = async (filter: Partial<typeof emptyFilter>) => {
    await setFilter({ ...emptyFilter, ...filter });
    onClose();
  };
  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  /** Opens a menu at the pointer, or under the button that was pressed. */
  const openMenu = (event: MouseEvent, label: string, items: MenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    const box = event.currentTarget.getBoundingClientRect();
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    setMenu({
      label,
      items,
      position:
        event.type === 'click' || fromKeyboard
          ? { x: box.right - 200, y: box.bottom + 4 }
          : { x: event.clientX, y: event.clientY },
    });
  };

  /** One line of the list: what it is, how many notes it has, and its menu. */
  const row = (options: {
    key: string;
    depth: number;
    icon: ReactNode;
    name: string;
    detail?: string;
    count: number;
    /** Shown before the name when the row holds others. */
    expanded?: boolean;
    onToggle?: () => void;
    onOpen: () => void;
    menuLabel: string;
    menu: MenuItem[];
  }) => (
    <div
      className="organizer-row"
      key={options.key}
      style={{ paddingLeft: 6 + options.depth * 22 }}
      onContextMenu={(event) => openMenu(event, options.menuLabel, options.menu)}
    >
      {options.onToggle ? (
        <button
          className="organizer-toggle"
          aria-label={`${options.expanded ? 'Collapse' : 'Expand'} ${options.name}`}
          aria-expanded={options.expanded}
          onClick={options.onToggle}
        >
          <ChevronRight className={options.expanded ? 'expanded' : ''} size={14} />
        </button>
      ) : (
        <span className="organizer-toggle" aria-hidden="true" />
      )}
      <button className="organizer-open" onClick={options.onOpen} title={options.name}>
        {options.icon}
        <span className="organizer-name">{options.name}</span>
        {options.detail && <small>{options.detail}</small>}
      </button>
      <span className="organizer-count" aria-label={plural(options.count, 'note')}>
        {options.count.toLocaleString()}
      </span>
      <button
        className="organizer-more"
        aria-label={options.menuLabel}
        aria-haspopup="menu"
        onClick={(event) => openMenu(event, options.menuLabel, options.menu)}
      >
        <MoreHorizontal />
      </button>
    </div>
  );

  const notebookRow = (notebook: Notebook, depth: number, detail?: string) =>
    row({
      key: notebook.id,
      depth,
      icon: <Folder size={15} />,
      name: notebook.name,
      detail,
      count: notebookCount(notebook),
      onOpen: () => void open({ notebookId: notebook.id }),
      menuLabel: `Actions for ${notebook.name}`,
      menu: notebookMenu(notebook),
    });

  const stackRow = (stack: Stack) => {
    const expanded = !closedStacks.has(stack.id);
    return (
      <div key={stack.id}>
        {row({
          key: stack.id,
          depth: 0,
          icon: <Layers3 size={15} />,
          name: stack.name,
          count: stackCount(stack),
          expanded,
          onToggle: () => setClosedStacks((current) => toggle(current, stack.id)),
          onOpen: () => void open({ stackId: stack.id }),
          menuLabel: `Actions for ${stack.name}`,
          menu: stackMenu(stack),
        })}
        {expanded &&
          ordered(
            overview.notebooks.filter((notebook) => notebook.stackId === stack.id),
            (notebook) => notebook.name,
            notebookCount,
          ).map((notebook) => notebookRow(notebook, 1))}
      </div>
    );
  };

  const tagRows = (tags: Tag[], depth: number): ReactNode =>
    ordered(tags, (tag) => tag.name, tagCount).map((tag) => {
      const inside = children.get(tag.id) ?? [];
      const expanded = openTags.has(tag.id);
      return (
        <div key={tag.id}>
          {row({
            key: tag.id,
            depth,
            icon: <TagIcon size={15} />,
            name: tag.name,
            detail: inside.length ? plural(inside.length, 'tag') : undefined,
            count: tagCount(tag),
            expanded: inside.length ? expanded : undefined,
            onToggle: inside.length ? () => setOpenTags((current) => toggle(current, tag.id)) : undefined,
            onOpen: () => void open({ tagIds: [tag.id] }),
            menuLabel: `Actions for ${tag.name}`,
            menu: tagMenu(tag),
          })}
          {expanded && tagRows(inside, depth + 1)}
        </div>
      );
    });

  let list: ReactNode;
  let found: number;
  if (kind === 'notebooks') {
    if (wanted) {
      const stackName = (notebook: Notebook) =>
        overview.stacks.find((stack) => stack.id === notebook.stackId)?.name;
      const stacks = overview.stacks.filter((stack) => stack.name.toLowerCase().includes(wanted));
      const notebooks = overview.notebooks.filter((notebook) => notebook.name.toLowerCase().includes(wanted));
      found = stacks.length + notebooks.length;
      list = (
        <>
          {ordered(stacks, (stack) => stack.name, stackCount).map((stack) =>
            row({
              key: stack.id,
              depth: 0,
              icon: <Layers3 size={15} />,
              name: stack.name,
              detail: 'Stack',
              count: stackCount(stack),
              onOpen: () => void open({ stackId: stack.id }),
              menuLabel: `Actions for ${stack.name}`,
              menu: stackMenu(stack),
            }),
          )}
          {ordered(notebooks, (notebook) => notebook.name, notebookCount).map((notebook) =>
            notebookRow(notebook, 0, stackName(notebook)),
          )}
        </>
      );
    } else {
      // Stacks and the notebooks outside any stack, in one order.
      const top = [
        ...overview.stacks.map((stack) => ({ stack, name: stack.name, count: stackCount(stack) })),
        ...overview.notebooks
          .filter((notebook) => notebook.stackId === null)
          .map((notebook) => ({ notebook, name: notebook.name, count: notebookCount(notebook) })),
      ];
      found = overview.notebooks.length;
      list = ordered(
        top,
        (item) => item.name,
        (item) => item.count,
      ).map((item) => ('stack' in item ? stackRow(item.stack) : notebookRow(item.notebook, 0)));
    }
  } else if (wanted) {
    const tags = overview.tags.filter((tag) => tag.name.toLowerCase().includes(wanted));
    found = tags.length;
    list = ordered(tags, (tag) => tag.name, tagCount).map((tag) =>
      row({
        key: tag.id,
        depth: 0,
        icon: <TagIcon size={15} />,
        name: tag.name,
        detail: tagPath(tag, overview.tags).join(' › ') || undefined,
        count: tagCount(tag),
        onOpen: () => void open({ tagIds: [tag.id] }),
        menuLabel: `Actions for ${tag.name}`,
        menu: tagMenu(tag),
      }),
    );
  } else {
    found = overview.tags.length;
    list = tagRows(children.get(null) ?? [], 0);
  }

  const title = kind === 'notebooks' ? 'Notebooks' : 'Tags';
  const summary =
    kind === 'notebooks'
      ? `${plural(overview.notebooks.length, 'notebook')}${overview.stacks.length ? ` · ${plural(overview.stacks.length, 'stack')}` : ''}`
      : plural(overview.tags.length, 'tag');

  return (
    <section className="organizer" aria-label={title}>
      <header className="organizer-header">
        <button className="icon-button" onClick={onClose} aria-label="Back to notes">
          <ArrowLeft />
        </button>
        <div>
          <p className="eyebrow">Library</p>
          <h1>
            {title} <span>{summary}</span>
          </h1>
        </div>
        <div className="organizer-actions">
          {kind === 'notebooks' ? (
            <>
              <button onClick={() => void newStack()} title="New stack">
                <Layers3 />
                <span>New stack</span>
              </button>
              <button className="primary" onClick={() => void newNotebook()} title="New notebook">
                <FolderPlus />
                <span>New notebook</span>
              </button>
            </>
          ) : (
            <button className="primary" onClick={() => void newTag()} title="New tag">
              <Plus />
              <span>New tag</span>
            </button>
          )}
        </div>
      </header>
      <div className="organizer-tools">
        <div className="search-wrap">
          <Search aria-hidden="true" />
          <input
            aria-label={kind === 'notebooks' ? 'Find notebooks' : 'Find tags'}
            placeholder={kind === 'notebooks' ? 'Find notebooks…' : 'Find tags…'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.stopPropagation();
                setQuery('');
              }
            }}
          />
          {query && (
            <button className="search-clear" onClick={() => setQuery('')} aria-label="Clear">
              <X />
            </button>
          )}
        </div>
        <select aria-label="Order" value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
          <option value="name">By name</option>
          <option value="count">Most notes first</option>
        </select>
      </div>
      <div className="organizer-columns" aria-hidden="true">
        <span>Name</span>
        <span>Notes</span>
      </div>
      <div className="organizer-list" tabIndex={0} aria-label={`${title} list`}>
        {found === 0 ? (
          <p className="organizer-empty">
            {wanted
              ? `No ${kind === 'notebooks' ? 'notebook' : 'tag'} by that name.`
              : kind === 'notebooks'
                ? 'No notebooks yet.'
                : 'Tags you add to notes appear here.'}
          </p>
        ) : (
          list
        )}
      </div>
      {menu && (
        <ContextMenu
          position={menu.position}
          items={menu.items}
          label={menu.label}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  );
}
