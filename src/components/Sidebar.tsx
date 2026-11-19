import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronRight,
  FileInput,
  FileText,
  Folder,
  Layers3,
  Library,
  MoreHorizontal,
  Plus,
  ScanText,
  Search,
  Settings,
  Star,
  Tag,
  Tags,
  Trash2,
  X,
} from 'lucide-react';
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';

import { isNative } from '../lib/api';
import { importPercent } from '../lib/importProgress';
import { tagChildren } from '../lib/tagTree';
import { useImportStore } from '../store/useImportStore';
import { useLibraryStore } from '../store/useLibraryStore';
import type { Notebook, NoteFilter, ShortcutTarget, Tag as TagItem } from '../types';
import { ContextMenu, type MenuItem } from './ContextMenu';
import type { OrganizerKind } from './Organizer';
import { useOrganizeMenus } from './organizeMenus';

interface Props {
  open: boolean;
  onClose: () => void;
  onSettings: () => void;
  /** Opens the screen that lists all notebooks, or all tags. */
  onOrganize: (kind: OrganizerKind) => void;
}

/** What is folded away in the sidebar: stacks, and the three lists themselves. */
const COLLAPSED_KEY = 'bever-collapsed-stacks';
/** Tags whose nested tags are shown; a tag begins with them folded away. */
const OPEN_TAGS_KEY = 'bever-open-tags';
const SHORTCUTS = 'section:shortcuts';
const NOTEBOOKS = 'section:notebooks';
const TAGS = 'section:tags';

/** The place of the arrow that unfolds a row, kept in a row that has nothing
    to unfold, so that the names of a list stand under one another. */
const noToggle = <span className="stack-toggle" aria-hidden="true" />;

function storedIds(key: string): Record<string, boolean> {
  try {
    const ids = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
    return Array.isArray(ids) ? Object.fromEntries(ids.map((id) => [String(id), true])) : {};
  } catch {
    return {};
  }
}

function storeIds(key: string, ids: Record<string, boolean>) {
  try {
    localStorage.setItem(key, JSON.stringify(Object.keys(ids).filter((id) => ids[id])));
  } catch {
    // Not remembered, then.
  }
}

interface OpenMenu {
  position: { x: number; y: number };
  label: string;
  items: MenuItem[];
}

/** What a shortcut leads to, shown before its name. */
const SHORTCUT_ICONS: Record<ShortcutTarget, ReactNode> = {
  note: <FileText size={14} />,
  notebook: <Folder size={14} />,
  stack: <Layers3 size={14} />,
  tag: <Tag size={14} />,
  search: <Search size={14} />,
};

export function Sidebar({ open: visible, onClose, onSettings, onOrganize }: Props) {
  const overview = useLibraryStore((state) => state.overview);
  const filter = useLibraryStore((state) => state.filter);
  const ocr = useLibraryStore((state) => state.ocr);
  const { openView, selectNote, createNote, toggleShortcut, goBack, goForward } = useLibraryStore.getState();
  const canGoBack = useLibraryStore((state) => state.placeAt > 0);
  const canGoForward = useLibraryStore((state) => state.placeAt < state.places.length - 1);
  const { notebookMenu, stackMenu, tagMenu, shortcutItem, newNotebook, newStack, newTag } =
    useOrganizeMenus();
  const importPhase = useImportStore((state) => state.phase);
  const importOpen = useImportStore((state) => state.open);
  const importProgress = useImportStore((state) => state.progress);
  const chooseImport = useImportStore((state) => state.choose);
  const showImport = useImportStore((state) => state.show);
  const [collapsed, setCollapsed] = useState(() => storedIds(COLLAPSED_KEY));
  const [openTags, setOpenTags] = useState(() => storedIds(OPEN_TAGS_KEY));
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const { counts, shortcuts } = overview;
  const nestedTags = useMemo(() => tagChildren(overview.tags), [overview.tags]);

  const navigate = async (next: Partial<NoteFilter>) => {
    await openView(next);
    onClose();
  };
  const newNote = async () => {
    await createNote();
    onClose();
  };
  const toggleCollapsed = (id: string) =>
    setCollapsed((current) => {
      const next = { ...current, [id]: !current[id] };
      storeIds(COLLAPSED_KEY, next);
      return next;
    });
  const toggleTag = (id: string) =>
    setOpenTags((current) => {
      const next = { ...current, [id]: !current[id] };
      storeIds(OPEN_TAGS_KEY, next);
      return next;
    });

  /** Opens a menu at the pointer, or under the button that was pressed. */
  const openMenu = (event: MouseEvent, label: string, items: MenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    const box = event.currentTarget.getBoundingClientRect();
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    const atButton = event.type === 'click';
    setMenu({
      label,
      items,
      position:
        atButton || fromKeyboard
          ? { x: box.left, y: box.bottom + 4 }
          : { x: event.clientX, y: event.clientY },
    });
  };

  const notebookRow = (notebook: Notebook) => (
    <div
      key={notebook.id}
      className={`notebook-row ${filter.notebookId === notebook.id ? 'active' : ''}`}
      onContextMenu={(event) => openMenu(event, `Actions for ${notebook.name}`, notebookMenu(notebook))}
    >
      {noToggle}
      <button className="tree-row" onClick={() => void navigate({ notebookId: notebook.id })}>
        <Folder size={14} />
        <span>{notebook.name}</span>
        <small className="row-count">{(counts.notebooks[notebook.id] ?? 0).toLocaleString()}</small>
      </button>
      <button
        className="row-more"
        aria-label={`Actions for ${notebook.name}`}
        aria-haspopup="menu"
        onClick={(event) => openMenu(event, `Actions for ${notebook.name}`, notebookMenu(notebook))}
      >
        <MoreHorizontal />
      </button>
    </div>
  );

  /** A tag, with the tags inside it under it when it is unfolded. */
  const tagRows = (tags: TagItem[]): ReactNode =>
    tags.map((tag) => {
      const inside = nestedTags.get(tag.id) ?? [];
      const unfolded = Boolean(openTags[tag.id]);
      return (
        <div className="stack-group" key={tag.id}>
          <div
            className={`stack-row notebook-row ${filter.tagIds.includes(tag.id) ? 'active' : ''}`}
            onContextMenu={(event) => openMenu(event, `Actions for ${tag.name}`, tagMenu(tag))}
          >
            {inside.length > 0 ? (
              <button
                className="stack-toggle"
                aria-label={`${unfolded ? 'Collapse' : 'Expand'} tag ${tag.name}`}
                aria-expanded={unfolded}
                onClick={() => toggleTag(tag.id)}
              >
                <ChevronRight className={unfolded ? 'expanded' : ''} size={13} />
              </button>
            ) : (
              noToggle
            )}
            <button
              className="tree-row stack-name"
              title={tag.name}
              onClick={() => void navigate({ tagIds: [tag.id] })}
            >
              <Tag size={13} />
              <span>{tag.name}</span>
              <small className="row-count">{(counts.tags[tag.id] ?? 0).toLocaleString()}</small>
            </button>
            <button
              className="row-more"
              aria-label={`Actions for ${tag.name}`}
              aria-haspopup="menu"
              onClick={(event) => openMenu(event, `Actions for ${tag.name}`, tagMenu(tag))}
            >
              <MoreHorizontal />
            </button>
          </div>
          {unfolded && inside.length > 0 && <div className="stack-children">{tagRows(inside)}</div>}
        </div>
      );
    });

  /** The heading of one of the three lists. Its arrow folds the list away.
      The name of the notebooks and of the tags leads to the screen that
      lists them all; the shortcuts have no such screen, and their name
      folds them as the arrow does. */
  const sectionHeading = (
    id: string,
    title: string,
    icon: ReactNode,
    count: number,
    actions: ReactNode,
    kind?: OrganizerKind,
  ) => (
    <h2 className="section-heading">
      <button
        className="section-fold"
        aria-label={`${collapsed[id] ? 'Expand' : 'Collapse'} ${title}`}
        aria-expanded={!collapsed[id]}
        onClick={() => toggleCollapsed(id)}
      >
        <ChevronRight className={collapsed[id] ? '' : 'expanded'} size={13} />
      </button>
      <button
        className="section-open"
        title={
          kind
            ? `All ${title.toLowerCase()}: find, rename, and arrange them`
            : `${collapsed[id] ? 'Show' : 'Hide'} the ${title.toLowerCase()}`
        }
        onClick={() => {
          if (!kind) return toggleCollapsed(id);
          onClose();
          onOrganize(kind);
        }}
      >
        {icon}
        <span>{title}</span>
      </button>
      {count > 0 && (
        <small className="section-count" aria-hidden="true">
          {count.toLocaleString()}
        </small>
      )}
      <span className="section-actions">{actions}</span>
    </h2>
  );

  const importing = importPhase === 'running';

  return (
    <>
      {/* Always there in the phone layout, where it fades with the drawer;
          it can be touched only while the drawer is open. */}
      <button
        className={`sidebar-scrim ${visible ? 'shown' : ''}`}
        aria-label="Close navigation"
        tabIndex={-1}
        onClick={onClose}
      />
      <aside className={`sidebar ${visible ? 'is-open' : ''}`}>
        <div className="brand">
          <img className="brand-mark" src="/bever.svg" alt="" />
          <span>Bever</span>
          {/* Back and forward among the places one has been, as in a browser. */}
          <div className="history-buttons">
            <button
              className="icon-button"
              disabled={!canGoBack}
              title="Back (Alt+Left)"
              aria-label="Back"
              onClick={() => void goBack().then(onClose)}
            >
              <ArrowLeft />
            </button>
            <button
              className="icon-button"
              disabled={!canGoForward}
              title="Forward (Alt+Right)"
              aria-label="Forward"
              onClick={() => void goForward().then(onClose)}
            >
              <ArrowRight />
            </button>
          </div>
          <button className="mobile-close icon-button" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        <button className="new-note-button" onClick={() => void newNote()}>
          <Plus size={18} />
          New note<span>Ctrl N</span>
        </button>
        <nav className="primary-nav">
          <button
            className={
              !filter.notebookId && !filter.stackId && !filter.tagIds.length && !filter.trashOnly
                ? 'active'
                : ''
            }
            onClick={() => void navigate({})}
          >
            <Library />
            All notes
            <small className="row-count">{counts.all.toLocaleString()}</small>
          </button>
          <button
            onClick={() => {
              onClose();
              void chooseImport();
            }}
            title={
              isNative
                ? 'Import notes from Evernote, or from its export files'
                : 'Available in the native app'
            }
          >
            <FileInput />
            {importing ? 'Importing…' : 'Import notes'}
          </button>
        </nav>
        {importing && !importOpen && (
          <button className="background-task" onClick={showImport} title="Show import progress">
            <FileInput />
            <span>
              Importing {importProgress?.fileName ?? ''} · {importPercent(importProgress)}%
            </span>
            <progress aria-label="Import progress" max={100} value={importPercent(importProgress)} />
          </button>
        )}
        {ocr?.enabled && ocr.pending > 0 && (
          <p
            className="background-task"
            role="status"
            title="Text in images becomes searchable as it is recognised"
          >
            <ScanText />
            <span>Reading text in images · {ocr.pending.toLocaleString()} left</span>
          </p>
        )}
        <div className="sidebar-scroll" tabIndex={0} aria-label="Notebook navigation">
          <section className="sidebar-section">
            {sectionHeading(SHORTCUTS, 'Shortcuts', <Star size={13} />, shortcuts.length, null)}
            {!collapsed[SHORTCUTS] && (
              <div className="section-body">
                {shortcuts.length === 0 && (
                  <p className="sidebar-empty">
                    Star a note, a notebook, a stack, a tag, or a search for quick access.
                  </p>
                )}
                {shortcuts.map((shortcut) => (
                  <div
                    className="notebook-row"
                    key={shortcut.id}
                    onContextMenu={(event) =>
                      openMenu(event, `Actions for ${shortcut.label}`, [
                        shortcutItem(shortcut.targetType, shortcut.targetId, shortcut.label),
                      ])
                    }
                  >
                    {noToggle}
                    <button
                      className="tree-row"
                      onClick={() => {
                        if (shortcut.targetType === 'note') {
                          void selectNote(shortcut.targetId);
                          onClose();
                        } else if (shortcut.targetType === 'notebook')
                          void navigate({ notebookId: shortcut.targetId });
                        else if (shortcut.targetType === 'stack')
                          void navigate({ stackId: shortcut.targetId });
                        else if (shortcut.targetType === 'search')
                          void navigate({ query: shortcut.targetId });
                        else void navigate({ tagIds: [shortcut.targetId] });
                      }}
                      title={
                        shortcut.targetType === 'search' ? `Search: ${shortcut.targetId}` : shortcut.label
                      }
                    >
                      {SHORTCUT_ICONS[shortcut.targetType]}
                      <span>{shortcut.label}</span>
                    </button>
                    <button
                      className="row-more"
                      aria-label={`Remove shortcut ${shortcut.label}`}
                      onClick={() =>
                        void toggleShortcut(shortcut.targetType, shortcut.targetId, shortcut.label)
                      }
                    >
                      <X />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="sidebar-section">
            {sectionHeading(
              NOTEBOOKS,
              'Notebooks',
              <BookOpen size={13} />,
              overview.notebooks.length,
              <>
                <button onClick={() => void newStack()} title="New stack" aria-label="New stack">
                  <Layers3 />
                </button>
                <button onClick={() => void newNotebook()} title="New notebook" aria-label="New notebook">
                  <Plus />
                </button>
              </>,
              'notebooks',
            )}
            {!collapsed[NOTEBOOKS] && (
              <div className="section-body">
                {overview.notebooks.filter((notebook) => !notebook.stackId).map(notebookRow)}
                {overview.stacks.map((stack) => (
                  <div className="stack-group" key={stack.id}>
                    <div
                      className={`stack-row notebook-row ${filter.stackId === stack.id ? 'active' : ''}`}
                      onContextMenu={(event) =>
                        openMenu(event, `Actions for ${stack.name}`, stackMenu(stack))
                      }
                    >
                      <button
                        className="stack-toggle"
                        aria-label={`${collapsed[stack.id] ? 'Expand' : 'Collapse'} stack ${stack.name}`}
                        aria-expanded={!collapsed[stack.id]}
                        onClick={() => toggleCollapsed(stack.id)}
                      >
                        <ChevronRight className={collapsed[stack.id] ? '' : 'expanded'} size={13} />
                      </button>
                      <button
                        className="tree-row stack-name"
                        onClick={() => void navigate({ stackId: stack.id })}
                      >
                        <Layers3 size={14} />
                        <span>{stack.name}</span>
                      </button>
                      <button
                        className="row-more"
                        aria-label={`Actions for ${stack.name}`}
                        aria-haspopup="menu"
                        onClick={(event) => openMenu(event, `Actions for ${stack.name}`, stackMenu(stack))}
                      >
                        <MoreHorizontal />
                      </button>
                    </div>
                    {!collapsed[stack.id] && (
                      <div className="stack-children">
                        {overview.notebooks
                          .filter((notebook) => notebook.stackId === stack.id)
                          .map(notebookRow)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="sidebar-section">
            {sectionHeading(
              TAGS,
              'Tags',
              <Tags size={13} />,
              overview.tags.length,
              <button onClick={() => void newTag()} title="New tag" aria-label="New tag">
                <Plus />
              </button>,
              'tags',
            )}
            {!collapsed[TAGS] && (
              <div className="section-body sidebar-tag-tree">
                {overview.tags.length === 0 ? (
                  <p className="sidebar-empty">Tags you add to notes appear here.</p>
                ) : (
                  tagRows(nestedTags.get(null) ?? [])
                )}
              </div>
            )}
          </section>
        </div>
        <div className="sidebar-footer">
          <button
            className={filter.trashOnly ? 'active' : ''}
            onClick={() => void navigate({ trashOnly: true, includeTrash: true })}
          >
            <Trash2 />
            Trash
            {counts.trash > 0 && <small className="row-count">{counts.trash.toLocaleString()}</small>}
          </button>
          <button onClick={onSettings}>
            <Settings />
            Settings & sync
          </button>
          <div className="local-status">
            <span className="status-dot" />
            Stored locally
          </div>
        </div>
      </aside>
      {menu && (
        <ContextMenu
          position={menu.position}
          items={menu.items}
          label={menu.label}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
