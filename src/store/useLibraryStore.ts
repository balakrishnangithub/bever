import { create } from 'zustand';

import { api } from '../lib/api';
import { editorSession } from '../lib/editorSession';
import { amended, gone, samePlace, sameView, viewOf, type Place, type Screen } from '../lib/places';
import {
  emptyFilter,
  emptyOverview,
  PAGE_SIZE,
  type AppInfo,
  type ExportScope,
  type Note,
  type NoteFilter,
  type NoteOrganizationAction,
  type NoteSort,
  type NoteSummary,
  type OcrStatus,
  type Overview,
  type SaveNote,
  type SavedNote,
  type SettingKey,
  type Settings,
  type ShortcutTarget,
} from '../types';

const SEARCH_DELAY_MS = 160;

interface LibraryState {
  overview: Overview;
  /**
   * The current listing: a place for each of its notes, in order. A note is
   * in its place once the part of the listing it is in has been in view;
   * until then the place is empty.
   */
  rows: (NoteSummary | undefined)[];
  /** How many notes the listing has. */
  total: number;
  /** A listing was asked for and has not arrived: it is not known to be empty. */
  listLoading: boolean;
  /**
   * Counts the listings that have arrived, so that what is worked out from
   * a whole listing (the tags its notes have) is worked out again.
   */
  listed: number;
  /** The search as it was understood, when it was answered by another spelling. */
  corrected: string | null;
  selectedNote: Note | null;
  filter: NoteFilter;
  loading: boolean;
  busy: boolean;
  error: string | null;
  /** A short confirmation shown briefly, such as "3 notes moved to Trash". */
  notice: string | null;
  settings: Settings;
  ocr: OcrStatus | null;
  appInfo: AppInfo | null;
  /** Whether a note opened from a search shows what the search found. */
  highlightSearch: boolean;
  setHighlightSearch: (enabled: boolean) => void;
  /**
   * Whether a note opens for reading only, until it is unlocked: a guard
   * against changing a note without meaning to. A choice of this device.
   */
  openReadOnly: boolean;
  setOpenReadOnly: (enabled: boolean) => void;
  /** The note made last, which opens for writing whatever the choice above. */
  createdNoteId: string | null;

  /** Where one has been, for going back and forward; see `places`. */
  places: Place[];
  /** Which of the places one is at. */
  placeAt: number;
  /** The screen of all notebooks, or of all tags, when one is showing. */
  screen: Screen | null;
  /** Counts the steps back and forward, for what has to follow one. */
  steps: number;
  /** Lists other notes: a notebook, a tag, a search. A new place. */
  openView: (view: Partial<NoteFilter>) => Promise<void>;
  /** Shows the screen of all notebooks or of all tags, or leaves it. */
  showScreen: (screen: Screen | null) => void;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;

  initialize: () => Promise<void>;
  /** Loads again the part of the listing that is in view. */
  refreshNotes: () => Promise<void>;
  /** Says which places of the listing are in view, so that their notes are loaded. */
  showRows: (first: number, last: number) => Promise<void>;
  refreshOverview: () => Promise<void>;
  /** Reloads everything after synchronization or an import changed the library. */
  refreshAfterExternalChange: () => Promise<void>;
  selectNote: (id: string | null) => Promise<void>;
  setSelectedNote: (note: Note) => void;
  setFilter: (filter: Partial<NoteFilter>) => Promise<void>;
  /** Updates the search box at once and the results shortly after typing stops. */
  setQuery: (query: string) => void;
  createNote: () => Promise<void>;
  /**
   * Saves the open note. `beforeApply` runs with the stored note before it
   * becomes `selectedNote`, so the editor can record the new revision first.
   */
  saveNote: (input: SaveNote, beforeApply?: (note: Note) => void) => Promise<SavedNote>;
  createNotebook: (name: string, stackId?: string | null) => Promise<boolean>;
  renameNotebook: (id: string, name: string) => Promise<boolean>;
  deleteNotebook: (id: string) => Promise<boolean>;
  setNotebookStack: (notebookId: string, stackId: string | null) => Promise<boolean>;
  createStack: (name: string) => Promise<boolean>;
  renameStack: (id: string, name: string) => Promise<boolean>;
  deleteStack: (id: string) => Promise<boolean>;
  createTag: (name: string, parentId?: string | null) => Promise<boolean>;
  /** Places a tag under another, or at the top. */
  setTagParent: (id: string, parentId: string | null) => Promise<boolean>;
  renameTag: (id: string, name: string) => Promise<boolean>;
  deleteTag: (id: string) => Promise<boolean>;
  toggleShortcut: (targetType: ShortcutTarget, targetId: string, label: string) => Promise<void>;
  /** Pins notes to the top of the notebook each is in, or takes them down. */
  pinNotes: (ids: string[], pinned: boolean) => Promise<void>;
  trashNotes: (ids: string[]) => Promise<void>;
  restoreNotes: (ids: string[]) => Promise<void>;
  deleteNotes: (ids: string[]) => Promise<void>;
  emptyTrash: () => Promise<void>;
  organizeNotes: (
    noteIds: string[],
    action: NoteOrganizationAction,
    notebookId: string | null,
    tags: string[],
  ) => Promise<number>;
  exportNotes: (scope: ExportScope, suggestedName: string) => Promise<void>;
  setSetting: (key: SettingKey, enabled: boolean) => Promise<void>;
  setOcr: (status: OcrStatus) => void;
  showNotice: (notice: string) => void;
  showError: (error: unknown) => void;
  clearNotice: () => void;
  clearError: () => void;
}

// A slow response must never replace a newer one. Each kind of request has a
// counter; a response is applied only if no later request of its kind began.
let listSequence = 0;
let selectSequence = 0;
/** The places of the listing that are in view. */
let inView = { first: 0, last: PAGE_SIZE - 1 };
/** Pages being fetched, each with the listing it is for. */
const fetching = new Set<string>();

const pageOf = (row: number) => Math.floor(Math.max(0, row) / PAGE_SIZE);

/** `rows` as a listing of `total` notes with `notes` in the places of `page`. */
function withPage(
  rows: (NoteSummary | undefined)[],
  total: number,
  page: number,
  notes: NoteSummary[],
): (NoteSummary | undefined)[] {
  const next = Array.from({ length: total }, (_, index) => rows[index]);
  notes.forEach((note, index) => {
    if (page * PAGE_SIZE + index < total) next[page * PAGE_SIZE + index] = note;
  });
  return next;
}
let queryTimer: ReturnType<typeof setTimeout> | undefined;

const HIGHLIGHT_KEY = 'bever.highlightSearch';
const SORT_KEY = 'bever.noteSort';
const READ_ONLY_KEY = 'bever.openReadOnly';

/** A choice this device remembers; null when it has none or cannot say. */
function remembered(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not remembered, then; it still applies until the application closes.
  }
}

const SORTS: NoteSort[] = ['updatedDesc', 'updatedAsc', 'createdDesc', 'createdAsc', 'titleAsc', 'titleDesc'];

/** The order the list of notes was last given on this device. */
function rememberedSort(): NoteSort {
  const sort = remembered(SORT_KEY) as NoteSort | null;
  return sort && SORTS.includes(sort) ? sort : 'updatedDesc';
}

const firstFilter = (): NoteFilter => ({ ...emptyFilter, sort: rememberedSort() });

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export const useLibraryStore = create<LibraryState>((set, get) => {
  /** Runs an operation that returns the new overview and reports failure. */
  const changeOverview = async (operation: () => Promise<Overview>): Promise<boolean> => {
    try {
      set({ overview: await operation(), error: null });
      return true;
    } catch (error) {
      set({ error: message(error) });
      return false;
    }
  };

  /** Where one is now. */
  const here = (): Place => ({
    view: viewOf(get().filter),
    noteId: get().selectedNote?.id ?? null,
    screen: get().screen,
  });
  /** One has gone somewhere else: another listing, another note, a screen. */
  const arrive = () =>
    set((state) => {
      const trail = gone({ places: state.places, at: state.placeAt }, here());
      return { places: trail.places, placeAt: trail.at };
    });
  /** The place one is at changed in itself: its search, its filters, its note went away. */
  const amend = () =>
    set((state) => {
      const current = state.places[state.placeAt];
      const place = here();
      if (current && samePlace(current, place)) return {};
      return { places: amended({ places: state.places, at: state.placeAt }, place).places };
    });

  /** Brings the open note in line with the library after a change elsewhere. */
  const reloadSelectedNote = async () => {
    const selected = get().selectedNote;
    if (!selected) return;
    try {
      const fresh = await api.getNote(selected.id);
      if (get().selectedNote?.id === fresh.id) set({ selectedNote: fresh });
    } catch {
      // The note is not there any more.
      if (get().selectedNote?.id === selected.id) {
        set({ selectedNote: null });
        amend();
      }
    }
  };

  /**
   * Opens a note, or none. `quiet` is for a step back or forward: it is not
   * a new place, and a note that has gone since is simply not opened.
   */
  const open = async (id: string | null, quiet: boolean) => {
    const sequence = ++selectSequence;
    // Whatever was typed in the open note is stored before it is replaced.
    await editorSession.flush().catch(() => undefined);
    if (sequence !== selectSequence) return;
    if (!id) {
      set({ selectedNote: null });
      if (!quiet) arrive();
      return;
    }
    try {
      const note = await api.getNote(id);
      if (sequence !== selectSequence) return;
      if (quiet) set({ selectedNote: note, error: null });
      else {
        set({ selectedNote: note, error: null, screen: null });
        arrive();
      }
    } catch (error) {
      if (sequence !== selectSequence) return;
      if (quiet) set({ selectedNote: null });
      else set({ error: message(error) });
    }
  };

  /** Lists the notes of `filter` from their beginning. */
  const list = (filter: NoteFilter) => {
    clearTimeout(queryTimer);
    inView = { first: 0, last: PAGE_SIZE - 1 };
    set({ filter: { ...filter, offset: 0 }, rows: [], total: 0, listLoading: true });
  };

  /** Goes to a place one has been at. */
  const step = async (to: number) => {
    const place = get().places[to];
    if (!place) return;
    set({ placeAt: to });
    let listing: Promise<void> | undefined;
    if (!sameView(viewOf(get().filter), place.view)) {
      list({
        ...get().filter,
        ...place.view,
        sort: place.view.query ? 'relevance' : rememberedSort(),
      });
      listing = get().refreshNotes();
    }
    if ((get().selectedNote?.id ?? null) !== place.noteId) await open(place.noteId, true);
    set((state) => ({ screen: place.screen, steps: state.steps + 1 }));
    await listing;
  };

  return {
    overview: emptyOverview,
    rows: [],
    total: 0,
    listLoading: true,
    listed: 0,
    corrected: null,
    selectedNote: null,
    filter: firstFilter(),
    loading: true,
    busy: false,
    error: null,
    notice: null,
    settings: { ocrEnabled: false, loadRemoteImages: false },
    ocr: null,
    appInfo: null,
    highlightSearch: remembered(HIGHLIGHT_KEY) !== 'off',
    setHighlightSearch: (highlightSearch) => {
      set({ highlightSearch });
      remember(HIGHLIGHT_KEY, highlightSearch ? 'on' : 'off');
    },
    openReadOnly: remembered(READ_ONLY_KEY) === 'on',
    setOpenReadOnly: (openReadOnly) => {
      set({ openReadOnly });
      remember(READ_ONLY_KEY, openReadOnly ? 'on' : 'off');
    },
    createdNoteId: null,

    places: [{ view: viewOf(firstFilter()), noteId: null, screen: null }],
    placeAt: 0,
    screen: null,
    steps: 0,
    openView: async (view) => {
      list({
        ...emptyFilter,
        ...view,
        sort: view.sort ?? (view.query ? 'relevance' : rememberedSort()),
      });
      set({ screen: null });
      arrive();
      await get().refreshNotes();
    },
    showScreen: (screen) => {
      if (get().screen === screen) return;
      const { places, placeAt } = get();
      set({ screen });
      // Leaving a screen is going back to where it was opened from, when
      // that is where one then is; the screen stays ahead, to return to.
      const before = places[placeAt - 1];
      if (!screen && before && samePlace(before, here())) set({ placeAt: placeAt - 1 });
      else arrive();
    },
    goBack: () => step(get().placeAt - 1),
    goForward: () => step(get().placeAt + 1),

    initialize: async () => {
      try {
        const overview = await api.bootstrap();
        set({ overview, loading: false });
        await get().refreshNotes();
        // Not needed to show the library, so they must not delay or fail it.
        void api
          .getSettings()
          .then((settings) => set({ settings }))
          .catch(() => undefined);
        void api
          .ocrStatus()
          .then((ocr) => set({ ocr }))
          .catch(() => undefined);
        void api
          .appInfo()
          .then((appInfo) => set({ appInfo }))
          .catch(() => undefined);
      } catch (error) {
        set({ loading: false, error: message(error) });
      }
    },

    refreshNotes: async () => {
      const sequence = ++listSequence;
      // What is in view is loaded again, where it is, so the list does not
      // jump; the rest is loaded when it comes into view.
      const pages: number[] = [];
      for (let page = pageOf(inView.first); page <= pageOf(inView.last); page += 1) pages.push(page);
      try {
        const answers = await Promise.all(
          pages.map((page) => api.listNotes({ ...get().filter, offset: page * PAGE_SIZE, limit: PAGE_SIZE })),
        );
        if (sequence !== listSequence) return;
        const total = answers.at(-1)?.total ?? 0;
        let rows: (NoteSummary | undefined)[] = [];
        answers.forEach((answer, index) => {
          rows = withPage(rows, total, pages[index] ?? 0, answer.notes);
        });
        if (!answers.length) rows = withPage(rows, total, 0, []);
        set({
          rows,
          total,
          listLoading: false,
          listed: get().listed + 1,
          corrected: answers.at(-1)?.corrected ?? null,
          error: null,
        });
      } catch (error) {
        if (sequence === listSequence) set({ listLoading: false, error: message(error) });
      }
    },

    showRows: async (first, last) => {
      inView = { first, last };
      const sequence = listSequence;
      const { rows, total, filter } = get();
      const wanted: number[] = [];
      for (let page = pageOf(first); page <= pageOf(last); page += 1) {
        const from = page * PAGE_SIZE;
        const to = Math.min(from + PAGE_SIZE, total);
        let missing = false;
        for (let row = from; row < to && !missing; row += 1) missing = rows[row] === undefined;
        if (missing && !fetching.has(`${sequence}:${page}`)) wanted.push(page);
      }
      await Promise.all(
        wanted.map(async (page) => {
          const key = `${sequence}:${page}`;
          fetching.add(key);
          try {
            const answer = await api.listNotes({ ...filter, offset: page * PAGE_SIZE, limit: PAGE_SIZE });
            // A refresh or another listing began meanwhile; this page is stale.
            if (sequence !== listSequence) return;
            set((state) => ({
              rows: withPage(state.rows, answer.total, page, answer.notes),
              total: answer.total,
            }));
          } catch (error) {
            if (sequence === listSequence) set({ error: message(error) });
          } finally {
            fetching.delete(key);
          }
        }),
      );
    },

    refreshOverview: async () => {
      await changeOverview(api.bootstrap);
    },

    refreshAfterExternalChange: async () => {
      await Promise.all([get().refreshOverview(), get().refreshNotes()]);
      // An editor with unsaved changes keeps them; saving then preserves the
      // version that arrived as a conflict copy instead of overwriting it.
      if (!editorSession.isDirty()) await reloadSelectedNote();
    },

    selectNote: (id) => open(id, false),

    setSelectedNote: (note) => {
      if (get().selectedNote?.id === note.id) set({ selectedNote: note });
    },

    setFilter: async (partial) => {
      // The order chosen for the list is this device's from then on.
      if (partial.sort && partial.sort !== 'relevance') remember(SORT_KEY, partial.sort);
      list({ ...get().filter, ...partial });
      amend();
      await get().refreshNotes();
    },

    setQuery: (query) => {
      set((state) => ({
        filter: {
          ...state.filter,
          query,
          // Searching ranks by relevance; clearing the box restores the order.
          sort: query
            ? 'relevance'
            : state.filter.sort === 'relevance'
              ? rememberedSort()
              : state.filter.sort,
          offset: 0,
        },
        // What was found so far stays until the new answer is there.
        listLoading: true,
      }));
      amend();
      clearTimeout(queryTimer);
      queryTimer = setTimeout(() => {
        inView = { first: 0, last: PAGE_SIZE - 1 };
        void get().refreshNotes();
      }, SEARCH_DELAY_MS);
    },

    createNote: async () => {
      const sequence = ++selectSequence;
      await editorSession.flush().catch(() => undefined);
      try {
        const note = await api.createNote(get().filter.notebookId);
        await Promise.all([get().refreshNotes(), get().refreshOverview()]);
        if (sequence === selectSequence) {
          set({ selectedNote: note, createdNoteId: note.id, screen: null });
          arrive();
        }
      } catch (error) {
        set({ error: message(error) });
      }
    },

    saveNote: async (input, beforeApply) => {
      try {
        const saved = await api.saveNote(input);
        beforeApply?.(saved.note);
        // The user may have opened another note while this one was saving.
        if (get().selectedNote?.id === saved.note.id) set({ selectedNote: saved.note });
        set({ error: null });
        if (saved.conflictCopy) {
          set({
            notice: `This note also changed elsewhere. Your version was saved, and the other one was kept as “${saved.conflictCopy}”.`,
          });
        }
        void Promise.all([get().refreshNotes(), get().refreshOverview()]);
        return saved;
      } catch (error) {
        set({ error: message(error) });
        throw error;
      }
    },

    createNotebook: (name, stackId = null) => changeOverview(() => api.createNotebook(name, stackId)),
    renameNotebook: async (id, name) => {
      const renamed = await changeOverview(() => api.renameNotebook(id, name));
      if (renamed) void get().refreshNotes();
      return renamed;
    },
    deleteNotebook: async (id) => {
      await editorSession.flush().catch(() => undefined);
      const deleted = await changeOverview(() => api.deleteNotebook(id));
      if (!deleted) return false;
      if (get().filter.notebookId === id) await get().openView({});
      else await get().refreshNotes();
      // Its notes moved to the trash, possibly including the open one.
      await reloadSelectedNote();
      return true;
    },
    setNotebookStack: (notebookId, stackId) =>
      changeOverview(() => api.setNotebookStack(notebookId, stackId)),
    createStack: (name) => changeOverview(() => api.createStack(name)),
    renameStack: (id, name) => changeOverview(() => api.renameStack(id, name)),
    deleteStack: async (id) => {
      const deleted = await changeOverview(() => api.deleteStack(id));
      if (deleted && get().filter.stackId === id) await get().openView({});
      return deleted;
    },
    createTag: (name, parentId = null) => changeOverview(() => api.createTag(name, parentId)),
    setTagParent: (id, parentId) => changeOverview(() => api.setTagParent(id, parentId)),
    renameTag: async (id, name) => {
      await editorSession.flush().catch(() => undefined);
      const renamed = await changeOverview(() => api.renameTag(id, name));
      if (renamed) await Promise.all([get().refreshNotes(), reloadSelectedNote()]);
      return renamed;
    },
    deleteTag: async (id) => {
      await editorSession.flush().catch(() => undefined);
      const deleted = await changeOverview(() => api.deleteTag(id));
      if (!deleted) return false;
      if (get().filter.tagIds.includes(id)) {
        await get().setFilter({ tagIds: get().filter.tagIds.filter((tag) => tag !== id) });
      } else {
        await get().refreshNotes();
      }
      await reloadSelectedNote();
      return true;
    },
    toggleShortcut: async (targetType, targetId, label) => {
      if (await changeOverview(() => api.toggleShortcut(targetType, targetId, label))) {
        void get().refreshNotes();
      }
    },
    pinNotes: async (ids, pinned) => {
      try {
        // The open note may be among them; what is typed in it is stored
        // first, so that the pin is not written over.
        await editorSession.flush().catch(() => undefined);
        const changed = await api.setNotesPinned(ids, pinned);
        if (changed === 0) return;
        await Promise.all([get().refreshNotes(), reloadSelectedNote()]);
        const where = ids.length === 1 ? 'its notebook' : 'their notebooks';
        set({
          notice: pinned
            ? `${plural(changed, 'note')} pinned to the top of ${where}.`
            : `${plural(changed, 'note')} no longer pinned.`,
        });
      } catch (error) {
        set({ error: message(error) });
      }
    },

    trashNotes: async (ids) => {
      if (!ids.length) return;
      try {
        await editorSession.flush().catch(() => undefined);
        const changed = await api.setNotesTrashed(ids, true);
        if (get().selectedNote && ids.includes(get().selectedNote!.id)) set({ selectedNote: null });
        amend();
        set({ notice: `${plural(changed, 'note')} moved to Trash.` });
        await Promise.all([get().refreshNotes(), get().refreshOverview()]);
      } catch (error) {
        set({ error: message(error) });
      }
    },
    restoreNotes: async (ids) => {
      if (!ids.length) return;
      try {
        const changed = await api.setNotesTrashed(ids, false);
        set({ notice: `${plural(changed, 'note')} restored.` });
        await Promise.all([get().refreshNotes(), get().refreshOverview(), reloadSelectedNote()]);
      } catch (error) {
        set({ error: message(error) });
      }
    },
    deleteNotes: async (ids) => {
      if (!ids.length) return;
      try {
        const deleted = await api.deleteNotesPermanently(ids);
        if (get().selectedNote && ids.includes(get().selectedNote!.id)) set({ selectedNote: null });
        amend();
        set({ notice: `${plural(deleted, 'note')} deleted permanently.` });
        await Promise.all([get().refreshNotes(), get().refreshOverview()]);
      } catch (error) {
        set({ error: message(error) });
      }
    },
    emptyTrash: async () => {
      try {
        const deleted = await api.emptyTrash();
        if (get().selectedNote?.deletedAt) set({ selectedNote: null });
        amend();
        set({ notice: `Trash emptied: ${plural(deleted, 'note')} deleted permanently.` });
        await Promise.all([get().refreshNotes(), get().refreshOverview()]);
      } catch (error) {
        set({ error: message(error) });
      }
    },

    organizeNotes: async (noteIds, action, notebookId, tags) => {
      set({ busy: true, error: null });
      try {
        // The open note may be among them; store its pending changes first.
        await editorSession.flush().catch(() => undefined);
        const changed = await api.organizeNotes(noteIds, action, notebookId, tags);
        await Promise.all([get().refreshOverview(), get().refreshNotes()]);
        if (action !== 'copy') await reloadSelectedNote();
        set({ busy: false });
        return changed;
      } catch (error) {
        set({ busy: false, error: message(error) });
        throw error;
      }
    },

    exportNotes: async (scope, suggestedName) => {
      set({ busy: true, error: null });
      try {
        await editorSession.flush().catch(() => undefined);
        const written = await api.exportNotes(scope, suggestedName);
        set({ busy: false });
        if (written !== null) set({ notice: `${plural(written, 'note')} exported.` });
      } catch (error) {
        set({ busy: false, error: message(error) });
      }
    },

    setSetting: async (key, enabled) => {
      try {
        set({ settings: await api.setSetting(key, enabled) });
      } catch (error) {
        set({ error: message(error) });
      }
    },
    setOcr: (ocr) => set({ ocr }),
    showNotice: (notice) => set({ notice }),
    showError: (error) => set({ error: message(error) }),
    clearNotice: () => set({ notice: null }),
    clearError: () => set({ error: null }),
  };
});

export function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Native errors arrive as "invalid data: …"; the category helps nobody.
  const cleaned = text.replace(/^(invalid data|remote sync error|network error): /, '');
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
