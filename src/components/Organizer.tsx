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
import type { Notebook, NoteFilter, Stack, Tag } from '../types';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { useOrganizeMenus } from './organizeMenus';

export type OrganizerKind = 'notebooks' | 'tags';

type Sort = 'name' | 'count';
const SORT_KEY = 'bever.organizerSort';

interface OpenMenu {
  position: { x: number; y: number };
  label: string;
  items: MenuItem[];
}

/**
 * What was unfolded on these screens, for as long as the application runs:
 * a screen one comes back to is as it was left.
 */
const unfolded = {
  /** Stacks begin open and tags closed: a stack holds a few notebooks, a tag may hold hundreds. */
  closedStacks: new Set<string>(),
  openTags: new Set<string>(),
  /** Stacks unfolded where they were found by a search; there they begin closed. */
  foundStacks: new Set<string>(),
};

/** Keeps what is unfolded of one kind for the next visit. */
function keepUnfolded(kind: keyof typeof unfolded, ids: Set<string>) {
  unfolded[kind] = ids;
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
  const openView = useLibraryStore((state) => state.openView);
  const { notebookMenu, stackMenu, tagMenu, newNotebook, newStack, newTag } = useOrganizeMenus();
  // What the list is searched for is part of where one is: a step back
  // from a notebook that was found returns to what was found.
  const query = useLibraryStore((state) => state.screenQuery);
  const setQuery = useLibraryStore((state) => state.setScreenQuery);
  // The order chosen for each of the two screens is this device's.
  const [sort, setSortState] = useState<Sort>(() => {
    try {
      return localStorage.getItem(`${SORT_KEY}.${kind}`) === 'count' ? 'count' : 'name';
    } catch {
      return 'name';
    }
  });
  const setSort = (next: Sort) => {
    setSortState(next);
    try {
      localStorage.setItem(`${SORT_KEY}.${kind}`, next);
    } catch {
      // Not remembered, then.
    }
  };
  const [closedStacks, setClosedStacks] = useState(unfolded.closedStacks);
  const [openTags, setOpenTags] = useState(unfolded.openTags);
  const [foundStacks, setFoundStacks] = useState(unfolded.foundStacks);
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

  // Opening one leaves the screen: the store puts it away as it goes.
  const open = (filter: Partial<NoteFilter>) => openView(filter);
  /** Folds or unfolds one of a kind, here and for the next visit. */
  const toggle = (kind: keyof typeof unfolded, id: string) => {
    const next = new Set(unfolded[kind]);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    keepUnfolded(kind, next);
    if (kind === 'closedStacks') setClosedStacks(next);
    else if (kind === 'openTags') setOpenTags(next);
    else setFoundStacks(next);
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

  /** A stack with its notebooks under it. Found by a search, it begins folded. */
  const stackRow = (stack: Stack, found = false) => {
    const expanded = found ? foundStacks.has(stack.id) : !closedStacks.has(stack.id);
    return (
      <div key={stack.id}>
        {row({
          key: stack.id,
          depth: 0,
          icon: <Layers3 size={15} />,
          name: stack.name,
          detail: found ? 'Stack' : undefined,
          count: stackCount(stack),
          expanded,
          onToggle: () => toggle(found ? 'foundStacks' : 'closedStacks', stack.id),
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

  /**
   * Tags, each with the tags inside it under it when it is unfolded. Found
   * by a search, a tag says where it is instead of how many it holds.
   */
  const tagRows = (tags: Tag[], depth: number, found = false): ReactNode =>
    ordered(tags, (tag) => tag.name, tagCount).map((tag) => {
      const inside = children.get(tag.id) ?? [];
      const expanded = openTags.has(tag.id);
      const detail = found
        ? tagPath(tag, overview.tags).join(' › ') || undefined
        : inside.length
          ? plural(inside.length, 'tag')
          : undefined;
      return (
        <div key={tag.id}>
          {row({
            key: tag.id,
            depth,
            icon: <TagIcon size={15} />,
            name: tag.name,
            detail,
            count: tagCount(tag),
            expanded: inside.length ? expanded : undefined,
            onToggle: inside.length ? () => toggle('openTags', tag.id) : undefined,
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
      // A stack that was found can be unfolded, to what is in it; a
      // notebook that was found says which stack it is in.
      list = (
        <>
          {ordered(stacks, (stack) => stack.name, stackCount).map((stack) => stackRow(stack, true))}
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
    // A tag that was found can be unfolded, to the tags inside it.
    list = tagRows(tags, 0, true);
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
