import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../lib/api';
import { editorSession } from '../lib/editorSession';
import {
  emptyFilter,
  emptyOverview,
  PAGE_SIZE,
  type Note,
  type NoteFilter,
  type NoteSummary,
} from '../types';
import { message, useLibraryStore } from './useLibraryStore';

vi.mock('../lib/api', () => ({
  isNative: false,
  isAndroid: false,
  api: {
    bootstrap: vi.fn(),
    listNotes: vi.fn(),
    getNote: vi.fn(),
    saveNote: vi.fn(),
    setNotesTrashed: vi.fn(),
    deleteNotebook: vi.fn(),
  },
}));

const summary = (index: number): NoteSummary => ({
  id: `note-${index}`,
  notebookId: 'inbox',
  notebookName: 'Inbox',
  title: `Note ${index}`,
  snippet: '',
  createdAt: index,
  updatedAt: index,
  deletedAt: null,
  tags: [],
  hasAttachments: false,
  isShortcut: false,
  thumbnail: null,
});

const note = (id: string, overrides: Partial<Note> = {}): Note => ({
  id,
  notebookId: 'inbox',
  title: id,
  contentHtml: '<p></p>',
  originalEnml: null,
  plainText: '',
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  attributes: {},
  evernoteGuid: null,
  revision: 1,
  tags: [],
  resources: [],
  ...overrides,
});

/** A library of `count` notes, answering like the native listing. */
function libraryOf(count: number) {
  const all = Array.from({ length: count }, (_, index) => summary(index));
  vi.mocked(api.listNotes).mockImplementation((filter: NoteFilter) =>
    Promise.resolve({ notes: all.slice(filter.offset, filter.offset + filter.limit), total: all.length }),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('library store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.bootstrap).mockResolvedValue(emptyOverview);
    useLibraryStore.setState({
      rows: [],
      total: 0,
      listLoading: false,
      selectedNote: null,
      filter: { ...emptyFilter },
      error: null,
      notice: null,
    });
  });

  /** The ids of the notes that are loaded, with their places in the listing. */
  const loaded = () =>
    useLibraryStore.getState().rows.flatMap((row, index) => (row ? [`${index}:${row.id}`] : []));

  it('has a place for every note and loads the part that is in view', async () => {
    const count = PAGE_SIZE * 3 + 30;
    libraryOf(count);
    const store = useLibraryStore.getState();
    await store.setFilter({});
    // The listing is as long as it is, with its beginning loaded.
    expect(useLibraryStore.getState().rows).toHaveLength(count);
    expect(useLibraryStore.getState().total).toBe(count);
    expect(loaded()).toHaveLength(PAGE_SIZE);
    expect(vi.mocked(api.listNotes)).toHaveBeenCalledTimes(1);

    // Moved to the end, as by its scroll bar: the last notes are loaded,
    // and nothing of what was passed over.
    await store.showRows(count - 12, count - 1);
    expect(useLibraryStore.getState().rows.at(-1)?.id).toBe(`note-${count - 1}`);
    expect(useLibraryStore.getState().rows[PAGE_SIZE]).toBeUndefined();
    expect(loaded()).toHaveLength(PAGE_SIZE + 30);
    expect(vi.mocked(api.listNotes)).toHaveBeenCalledTimes(2);

    // What is loaded is not asked for again.
    await store.showRows(count - 20, count - 5);
    await store.showRows(3, 9);
    expect(vi.mocked(api.listNotes)).toHaveBeenCalledTimes(2);
    // Rows across two pages ask for both.
    await store.showRows(PAGE_SIZE * 2 - 3, PAGE_SIZE * 2 + 3);
    expect(vi.mocked(api.listNotes)).toHaveBeenCalledTimes(4);
    expect(useLibraryStore.getState().rows[PAGE_SIZE * 2]?.id).toBe(`note-${PAGE_SIZE * 2}`);
  });

  it('asks once for a page that is already on its way', async () => {
    libraryOf(PAGE_SIZE * 2);
    await useLibraryStore.getState().setFilter({});
    const first = useLibraryStore.getState().showRows(PAGE_SIZE, PAGE_SIZE + 5);
    const second = useLibraryStore.getState().showRows(PAGE_SIZE + 2, PAGE_SIZE + 9);
    await Promise.all([first, second]);
    expect(vi.mocked(api.listNotes)).toHaveBeenCalledTimes(2);
    expect(loaded()).toHaveLength(PAGE_SIZE * 2);
  });

  it('loads what is in view again, where it is, when the listing is refreshed', async () => {
    libraryOf(PAGE_SIZE * 3);
    const store = useLibraryStore.getState();
    await store.setFilter({});
    await store.showRows(PAGE_SIZE * 2 + 10, PAGE_SIZE * 2 + 20);
    await store.refreshNotes();
    const rows = useLibraryStore.getState().rows;
    expect(rows).toHaveLength(PAGE_SIZE * 3);
    expect(rows[PAGE_SIZE * 2 + 15]?.id).toBe(`note-${PAGE_SIZE * 2 + 15}`);
    // The beginning is loaded again when it comes back into view.
    expect(rows[0]).toBeUndefined();
    await store.showRows(0, 8);
    expect(useLibraryStore.getState().rows[0]?.id).toBe('note-0');
  });

  it('does not call a listing empty while it is on its way', async () => {
    const slow = deferred<{ notes: NoteSummary[]; total: number }>();
    vi.mocked(api.listNotes).mockReturnValueOnce(slow.promise);
    const loading = useLibraryStore.getState().setFilter({ notebookId: 'other' });
    expect(useLibraryStore.getState().listLoading).toBe(true);
    expect(useLibraryStore.getState().total).toBe(0);
    slow.resolve({ notes: [], total: 0 });
    await loading;
    expect(useLibraryStore.getState().listLoading).toBe(false);
  });

  it('keeps what a search found until the next answer is there', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(api.listNotes).mockResolvedValueOnce({ notes: [summary(1), summary(2)], total: 2 });
      await useLibraryStore.getState().setFilter({ query: 'gard' });
      const next = deferred<{ notes: NoteSummary[]; total: number }>();
      vi.mocked(api.listNotes).mockReturnValueOnce(next.promise);
      useLibraryStore.getState().setQuery('garden');
      // While it is typed, and while it is looked for, the list stays.
      expect(loaded()).toEqual(['0:note-1', '1:note-2']);
      expect(useLibraryStore.getState().listLoading).toBe(true);
      await vi.advanceTimersByTimeAsync(400);
      expect(loaded()).toEqual(['0:note-1', '1:note-2']);
      next.resolve({ notes: [summary(2)], total: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(loaded()).toEqual(['0:note-2']);
      expect(useLibraryStore.getState().listLoading).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores the answer to a search that has since been replaced', async () => {
    const slow = deferred<{ notes: NoteSummary[]; total: number }>();
    vi.mocked(api.listNotes)
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce({ notes: [summary(2)], total: 1 });
    const first = useLibraryStore.getState().setFilter({ query: 'old' });
    await useLibraryStore.getState().setFilter({ query: 'new' });
    slow.resolve({ notes: [summary(1)], total: 1 });
    await first;
    expect(loaded()).toEqual(['0:note-2']);
  });

  it('drops a page that belongs to a listing no longer shown', async () => {
    libraryOf(PAGE_SIZE * 2);
    await useLibraryStore.getState().setFilter({});
    const page = deferred<{ notes: NoteSummary[]; total: number }>();
    vi.mocked(api.listNotes).mockReturnValueOnce(page.promise);
    const loading = useLibraryStore.getState().showRows(PAGE_SIZE, PAGE_SIZE + 5);
    vi.mocked(api.listNotes).mockResolvedValueOnce({ notes: [summary(900)], total: 1 });
    await useLibraryStore.getState().setFilter({ notebookId: 'other' });
    page.resolve({ notes: [summary(150)], total: PAGE_SIZE * 2 });
    await loading;
    expect(loaded()).toEqual(['0:note-900']);
  });

  it('saves the open note before another one is opened', async () => {
    const order: string[] = [];
    const unregister = editorSession.register({
      noteId: 'first',
      isDirty: () => true,
      flush: async () => {
        await Promise.resolve();
        order.push('saved first');
      },
    });
    vi.mocked(api.getNote).mockImplementation((id: string) => {
      order.push(`loaded ${id}`);
      return Promise.resolve(note(id));
    });
    await useLibraryStore.getState().selectNote('second');
    unregister();
    expect(order).toEqual(['saved first', 'loaded second']);
    expect(useLibraryStore.getState().selectedNote?.id).toBe('second');
  });

  it('opens the note chosen last when choices overlap', async () => {
    const slow = deferred<Note>();
    vi.mocked(api.getNote).mockImplementation((id: string) =>
      id === 'slow' ? slow.promise : Promise.resolve(note(id)),
    );
    const first = useLibraryStore.getState().selectNote('slow');
    await useLibraryStore.getState().selectNote('fast');
    slow.resolve(note('slow'));
    await first;
    expect(useLibraryStore.getState().selectedNote?.id).toBe('fast');
  });

  it('does not reopen a note whose save finishes after another was opened', async () => {
    libraryOf(1);
    useLibraryStore.setState({ selectedNote: note('second') });
    vi.mocked(api.saveNote).mockResolvedValue({ note: note('first', { revision: 2 }), conflictCopy: null });
    const seen: number[] = [];
    await useLibraryStore.getState().saveNote(
      {
        id: 'first',
        notebookId: 'inbox',
        title: 'first',
        contentHtml: '',
        attributes: {},
        tags: [],
        baseRevision: 1,
      },
      (stored) => seen.push(stored.revision),
    );
    expect(seen).toEqual([2]);
    expect(useLibraryStore.getState().selectedNote?.id).toBe('second');
  });

  it('says so when a save had to keep another version as a conflict copy', async () => {
    libraryOf(1);
    useLibraryStore.setState({ selectedNote: note('first') });
    vi.mocked(api.saveNote).mockResolvedValue({
      note: note('first', { revision: 9 }),
      conflictCopy: 'first (conflict copy)',
    });
    await useLibraryStore.getState().saveNote({
      id: 'first',
      notebookId: 'inbox',
      title: 'first',
      contentHtml: '',
      attributes: {},
      tags: [],
      baseRevision: 1,
    });
    expect(useLibraryStore.getState().notice).toContain('first (conflict copy)');
  });

  it('closes the open note when it is moved to Trash', async () => {
    libraryOf(0);
    useLibraryStore.setState({ selectedNote: note('gone') });
    vi.mocked(api.setNotesTrashed).mockResolvedValue(2);
    await useLibraryStore.getState().trashNotes(['gone', 'other']);
    expect(useLibraryStore.getState().selectedNote).toBeNull();
    expect(useLibraryStore.getState().notice).toBe('2 notes moved to Trash.');
  });

  it('leaves a notebook that was deleted and reloads the open note', async () => {
    libraryOf(0);
    useLibraryStore.setState({
      filter: { ...emptyFilter, notebookId: 'doomed' },
      selectedNote: note('inside', { notebookId: 'doomed' }),
    });
    vi.mocked(api.deleteNotebook).mockResolvedValue(emptyOverview);
    vi.mocked(api.getNote).mockResolvedValue(note('inside', { notebookId: 'inbox', deletedAt: 5 }));
    expect(await useLibraryStore.getState().deleteNotebook('doomed')).toBe(true);
    expect(useLibraryStore.getState().filter.notebookId).toBeNull();
    expect(useLibraryStore.getState().selectedNote?.deletedAt).toBe(5);
  });

  it('shows native errors without their internal category', () => {
    expect(message('invalid data: a notebook named “Work” already exists')).toBe(
      'A notebook named “Work” already exists',
    );
    expect(message(new Error('network error: connection reset'))).toBe('Connection reset');
    expect(message('not found: note 123')).toBe('Not found: note 123');
  });
});
