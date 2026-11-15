import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Copy,
  Download,
  FolderInput,
  Menu,
  Paperclip,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Star,
  Tag,
  Tags,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { isNative, thumbnailUrl } from '../lib/api';
import { dialogs } from '../lib/dialogs';
import { snippetParts } from '../lib/snippet';
import { useLibraryStore } from '../store/useLibraryStore';
import type { NoteOrganizationAction, NoteSummary } from '../types';
import { FilterPanel } from './FilterPanel';
import { ListScroller } from './ListScroller';
import { OrganizationDialog } from './OrganizationDialog';

/** The height a note takes in the list, with the space under it. */
const ROW_HEIGHT = 138;
/**
 * How long the rows in view stay the same before their notes are asked
 * for, in milliseconds: a list dragged from top to bottom by its scroll bar
 * passes thousands of rows that nobody stops to read.
 */
const SETTLE_MS = 70;
/** Empty rows shown while a listing is on its way. */
const PLACEHOLDERS = 7;

export function NoteList({
  onOpenSidebar,
  onOpenNote,
}: {
  onOpenSidebar: () => void;
  onOpenNote: () => void;
}) {
  const rows = useLibraryStore((state) => state.rows);
  const total = useLibraryStore((state) => state.total);
  const listLoading = useLibraryStore((state) => state.listLoading);
  const corrected = useLibraryStore((state) => state.corrected);
  const selectedNote = useLibraryStore((state) => state.selectedNote);
  const filter = useLibraryStore((state) => state.filter);
  const overview = useLibraryStore((state) => state.overview);
  const busy = useLibraryStore((state) => state.busy);
  const selectNote = useLibraryStore((state) => state.selectNote);
  const setFilter = useLibraryStore((state) => state.setFilter);
  const setQuery = useLibraryStore((state) => state.setQuery);
  const showRows = useLibraryStore((state) => state.showRows);
  const createNote = useLibraryStore((state) => state.createNote);
  const trashNotes = useLibraryStore((state) => state.trashNotes);
  const restoreNotes = useLibraryStore((state) => state.restoreNotes);
  const pinNotes = useLibraryStore((state) => state.pinNotes);
  const deleteNotes = useLibraryStore((state) => state.deleteNotes);
  const emptyTrash = useLibraryStore((state) => state.emptyTrash);
  const exportNotes = useLibraryStore((state) => state.exportNotes);
  const toggleShortcut = useLibraryStore((state) => state.toggleShortcut);
  // A search can be kept among the shortcuts, by its words.
  const searched = filter.query.trim();
  const searchKept = overview.shortcuts.some(
    (item) => item.targetType === 'search' && item.targetId === searched,
  );

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [organizationAction, setOrganizationAction] = useState<NoteOrganizationAction | null>(null);
  const [organizationMessage, setOrganizationMessage] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The list is as long as the listing, whatever part of it is loaded: its
  // scroll bar shows where in the whole one is, and moved to the end shows
  // the last note.
  // TanStack Virtual intentionally exposes a mutable virtualizer instance.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  const visible = virtualizer.getVirtualItems();
  const firstVisible = visible[0]?.index ?? 0;
  const lastVisible = visible.at(-1)?.index ?? 0;

  // The notes of the rows in view are loaded once the list has come to rest
  // on them. `rows` is among what this follows, so that a listing that has
  // just arrived is asked for the part of it that is in view.
  useEffect(() => {
    const timer = window.setTimeout(() => void showRows(firstVisible, lastVisible), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [firstVisible, lastVisible, rows, showRows]);

  const notes = useMemo(() => rows.filter((row): row is NoteSummary => row !== undefined), [rows]);

  // A different listing starts at its top.
  const listingKey = `${filter.notebookId}|${filter.stackId}|${filter.tagIds.join(',')}|${filter.trashOnly}|${filter.sort}`;
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [listingKey]);

  const title = filter.trashOnly
    ? 'Trash'
    : filter.notebookId
      ? overview.notebooks.find((item) => item.id === filter.notebookId)?.name
      : filter.stackId
        ? overview.stacks.find((item) => item.id === filter.stackId)?.name
        : filter.tagIds.length
          ? overview.tags
              .filter((tag) => filter.tagIds.includes(tag.id))
              .map((tag) => tag.name)
              .join(' + ')
          : 'All notes';
  // Until a listing has arrived it is not known to be empty.
  const waiting = listLoading && total === 0;
  const filterCount =
    [filter.contains, filter.createdFrom, filter.createdTo, filter.updatedFrom, filter.updatedTo].filter(
      Boolean,
    ).length + filter.tagIds.length;
  const selectedNoteIds = useMemo(
    () => notes.filter((note) => checkedIds.has(note.id)).map((note) => note.id),
    [notes, checkedIds],
  );
  const allLoadedSelected = notes.length > 0 && selectedNoteIds.length === notes.length;
  // Whether every selected note is pinned: then the selection can be taken
  // down, and otherwise pinned.
  const selectedPinned =
    selectedNoteIds.length > 0 &&
    selectedNoteIds.every((id) => notes.find((note) => note.id === id)?.pinned === true);
  const selectionInTrash =
    selectedNoteIds.length > 0 &&
    notes.filter((note) => checkedIds.has(note.id)).every((note) => note.deletedAt !== null);

  const toggleChecked = (id: string, checked: boolean) => {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
    setOrganizationMessage(null);
  };
  const clearSelection = () => setCheckedIds(new Set());
  const noun = (count: number) => (count === 1 ? 'note' : 'notes');

  const deleteSelected = async () => {
    const count = selectedNoteIds.length;
    const confirmed = await dialogs.confirm({
      title: `Delete ${count} ${noun(count)} permanently?`,
      message:
        'The notes and their attachments will be deleted from this device and, after the next sync, from your other devices. This cannot be undone.',
      confirmLabel: 'Delete permanently',
      danger: true,
    });
    if (!confirmed) return;
    await deleteNotes(selectedNoteIds);
    clearSelection();
  };
  const emptyTheTrash = async () => {
    const confirmed = await dialogs.confirm({
      title: 'Empty Trash?',
      message: `All ${total} ${noun(total)} in Trash and their attachments will be deleted permanently. This cannot be undone.`,
      confirmLabel: 'Empty Trash',
      danger: true,
    });
    if (!confirmed) return;
    await emptyTrash();
    clearSelection();
  };

  return (
    <section className="notes-panel">
      <header className="notes-header">
        <button className="icon-button mobile-menu" onClick={onOpenSidebar} aria-label="Open navigation">
          <Menu />
        </button>
        <div>
          <p className="eyebrow">Library</p>
          <h1>
            {filter.tagIds.length > 0 && !filter.trashOnly && !filter.notebookId && !filter.stackId && (
              <Tag className="title-icon" aria-label="Tag" />
            )}
            {title ?? 'Notes'}{' '}
            {!waiting && <span aria-label={`${total} notes`}>{total.toLocaleString()}</span>}
          </h1>
        </div>
        {filter.trashOnly ? (
          <button
            className="text-action danger"
            disabled={total === 0}
            onClick={() => void emptyTheTrash()}
            title="Delete everything in Trash permanently"
          >
            Empty Trash
          </button>
        ) : (
          <button
            className="icon-button mobile-new"
            onClick={() => void createNote().then(onOpenNote)}
            aria-label="New note"
          >
            <Plus />
          </button>
        )}
      </header>
      <div className="search-wrap">
        <Search aria-hidden="true" />
        <input
          aria-label="Search notes"
          placeholder="Search title, content, tags…"
          value={filter.query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && filter.query) {
              event.stopPropagation();
              setQuery('');
            }
          }}
        />
        {searched && (
          <button
            className={`search-clear search-star ${searchKept ? 'is-starred' : ''}`}
            title={searchKept ? 'Remove this search from the shortcuts' : 'Add this search to the shortcuts'}
            aria-label={searchKept ? 'Remove search shortcut' : 'Add search shortcut'}
            aria-pressed={searchKept}
            onClick={() => void toggleShortcut('search', searched, searched)}
          >
            <Star />
          </button>
        )}
        {filter.query ? (
          <button className="search-clear" onClick={() => setQuery('')} aria-label="Clear search">
            <X />
          </button>
        ) : (
          <kbd>Ctrl K</kbd>
        )}
      </div>
      {corrected && filter.query.trim() && (
        <p className="search-corrected" role="status">
          Nothing for “{filter.query.trim()}”. Showing notes for <strong>{corrected}</strong>.
        </p>
      )}
      <div className="notes-tools">
        <button
          className={filtersOpen || filterCount ? 'active' : ''}
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((value) => !value)}
        >
          <SlidersHorizontal />
          Filters{filterCount > 0 && <span>{filterCount}</span>}
        </button>
        <select
          aria-label="Sort notes"
          value={filter.sort}
          onChange={(event) => void setFilter({ sort: event.target.value as typeof filter.sort })}
        >
          <option value="updatedDesc">Recently updated</option>
          <option value="updatedAsc">Least recently updated</option>
          <option value="createdDesc">Newest created</option>
          <option value="createdAsc">Oldest created</option>
          <option value="titleAsc">Title A–Z</option>
          <option value="titleDesc">Title Z–A</option>
          {filter.query && <option value="relevance">Relevance</option>}
        </select>
      </div>
      {selectedNoteIds.length > 0 && (
        <div className="bulk-toolbar" role="toolbar" aria-label="Selected note actions">
          <label title="Select or clear all loaded notes">
            <input
              type="checkbox"
              aria-label="Select all loaded notes"
              checked={allLoadedSelected}
              onChange={(event) => {
                setCheckedIds(event.target.checked ? new Set(notes.map((note) => note.id)) : new Set());
                setOrganizationMessage(null);
              }}
            />
            <span>{selectedNoteIds.length} selected</span>
          </label>
          <button className="icon-button" onClick={clearSelection} aria-label="Clear note selection">
            <X />
          </button>
          <div className="bulk-actions">
            {selectionInTrash ? (
              <>
                <button
                  onClick={() => void restoreNotes(selectedNoteIds).then(clearSelection)}
                  title="Restore selected notes"
                >
                  <RotateCcw />
                  Restore
                </button>
                <button className="danger" onClick={() => void deleteSelected()} title="Delete permanently">
                  <Trash2 />
                  Delete
                </button>
              </>
            ) : (
              <>
                <button onClick={() => setOrganizationAction('move')} title="Move selected notes">
                  <FolderInput />
                  Move
                </button>
                <button onClick={() => setOrganizationAction('copy')} title="Copy selected notes">
                  <Copy />
                  Copy
                </button>
                <button onClick={() => setOrganizationAction('addTags')} title="Add tags to selected notes">
                  <Tags />
                  Tag
                </button>
                <button
                  onClick={() => setOrganizationAction('removeTags')}
                  title="Remove tags from selected notes"
                >
                  <Tags />
                  Untag
                </button>
                {selectedPinned ? (
                  <button
                    onClick={() => void pinNotes(selectedNoteIds, false)}
                    title="Take the selected notes down from the top of their notebooks"
                  >
                    <PinOff />
                    Unpin
                  </button>
                ) : (
                  <button
                    onClick={() => void pinNotes(selectedNoteIds, true)}
                    title="Pin the selected notes to the top of their notebooks"
                  >
                    <Pin />
                    Pin
                  </button>
                )}
                {isNative && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void exportNotes({ kind: 'notes', noteIds: selectedNoteIds }, title ?? 'Bever notes')
                    }
                    title="Export selected notes as ENEX"
                  >
                    <Download />
                    Export
                  </button>
                )}
                <button
                  onClick={() => void trashNotes(selectedNoteIds).then(clearSelection)}
                  title="Move selected notes to Trash"
                >
                  <Trash2 />
                  Trash
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {organizationMessage && (
        <p className="organization-status" role="status">
          {organizationMessage}
        </p>
      )}
      {filtersOpen && <FilterPanel onClose={() => setFiltersOpen(false)} />}
      {organizationAction && (
        <OrganizationDialog
          action={organizationAction}
          noteIds={selectedNoteIds}
          onClose={() => setOrganizationAction(null)}
          onComplete={(message) => {
            clearSelection();
            setOrganizationMessage(message);
          }}
        />
      )}
      <div className="note-list-frame">
        <div className="note-list" ref={scrollRef} tabIndex={0} aria-label="Notes" aria-busy={listLoading}>
          {waiting ? (
            <div className="note-placeholders" role="status" aria-label="Loading notes">
              {Array.from({ length: PLACEHOLDERS }, (_, index) => (
                <div className="note-card placeholder" key={index} />
              ))}
            </div>
          ) : total === 0 ? (
            <div className="empty-list">
              <span>⌁</span>
              <h2>{filter.trashOnly ? 'Trash is empty' : 'No notes here'}</h2>
              <p>
                {filter.query || filterCount
                  ? 'Try another search or clear a filter.'
                  : filter.trashOnly
                    ? 'Notes you delete stay here until you empty the Trash.'
                    : 'Create a note and make this space yours.'}
              </p>
              {!filter.query && !filterCount && !filter.trashOnly && (
                <button onClick={() => void createNote().then(onOpenNote)}>
                  <Plus />
                  New note
                </button>
              )}
            </div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {visible.map((row) => {
                const note = rows[row.index];
                const place = {
                  position: 'absolute' as const,
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${row.start}px)`,
                };
                // A note that is not loaded yet keeps its place.
                if (!note) return <div key={row.index} className="note-card placeholder" style={place} />;
                return (
                  <div
                    key={note.id}
                    className={`note-card ${selectedNote?.id === note.id ? 'selected' : ''} ${
                      checkedIds.has(note.id) ? 'checked' : ''
                    } ${note.pinned ? 'pinned' : ''}`}
                    style={place}
                  >
                    <label className="note-select" title={`Select ${note.title || 'Untitled'}`}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${note.title || 'Untitled'}`}
                        checked={checkedIds.has(note.id)}
                        onChange={(event) => toggleChecked(note.id, event.target.checked)}
                      />
                    </label>
                    <button
                      className={`note-open ${note.thumbnail ? 'with-thumbnail' : ''}`}
                      aria-label={`Open note ${note.title || 'Untitled'}`}
                      aria-current={selectedNote?.id === note.id}
                      onClick={() => {
                        void selectNote(note.id);
                        onOpenNote();
                      }}
                    >
                      {note.thumbnail && (
                        <img
                          className="note-thumbnail"
                          src={thumbnailUrl(note.thumbnail)}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          // A picture that cannot be shown small is left out.
                          onError={(event) => {
                            event.currentTarget.hidden = true;
                          }}
                        />
                      )}
                      <div className="note-card-top">
                        <h2>{note.title || 'Untitled'}</h2>
                        {note.pinned && (
                          <span className="pinned-mark" title="Pinned to its notebook">
                            <Pin aria-label="Pinned to its notebook" />
                          </span>
                        )}
                        {note.isShortcut && <Star className="shortcut-star" />}
                      </div>
                      <p>
                        {note.snippet
                          ? snippetParts(note.snippet).map((part, index) =>
                              part.match ? <mark key={index}>{part.text}</mark> : part.text,
                            )
                          : 'No additional text'}
                      </p>
                      <div className="note-card-meta">
                        <time>{formatDate(note.updatedAt)}</time>
                        <span>{note.notebookName}</span>
                        {note.hasAttachments && <Paperclip />}
                      </div>
                      {note.tags.length > 0 && (
                        <div className="note-card-tags">
                          {note.tags.slice(0, 3).map((tag) => (
                            <span key={tag}>
                              <Tag aria-hidden="true" />
                              {tag}
                            </span>
                          ))}
                          {note.tags.length > 3 && <span>+{note.tags.length - 3}</span>}
                        </div>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <ListScroller scroller={scrollRef} rowHeight={ROW_HEIGHT} total={total} />
      </div>
    </section>
  );
}

function formatDate(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString())
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}
