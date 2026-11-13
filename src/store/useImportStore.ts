import { listen } from '@tauri-apps/api/event';
import { create } from 'zustand';

import { api, canImportFromEvernote } from '../lib/api';
import {
  emptyFilter,
  type EvernoteAccount,
  type ImportOutcome,
  type ImportProgress,
  type PickedFile,
} from '../types';
import { message, useLibraryStore } from './useLibraryStore';

/** How often the note list is refreshed while notes are arriving. */
const REFRESH_INTERVAL_MS = 1200;

/**
 * `source` asks where the notes are to come from, `evernote` shows the
 * notebooks the Evernote application has, and `review` the chosen files.
 */
type Phase = 'idle' | 'source' | 'evernote' | 'review' | 'running' | 'done';

interface ImportState {
  phase: Phase;
  /** Whether the import dialog is showing. An import keeps running when it is not. */
  open: boolean;
  files: PickedFile[];
  /** Notebook name chosen for each file, by token. */
  names: Record<string, string>;
  progress: ImportProgress | null;
  outcomes: ImportOutcome[];
  cancelling: boolean;
  error: string | null;
  /** What the Evernote application keeps on this computer; null while it is being looked at. */
  accounts: EvernoteAccount[] | null;
  /** Which of the accounts is shown. */
  account: number;
  /** The notebooks of that account that are to be imported, by id. */
  selected: string[];
  /** Whether notes are imported without the attachments Evernote does not have. */
  withoutMissing: boolean;
  /** Starts an import: asks for its source where there is a choice. */
  choose: () => Promise<void>;
  /** Lets the user choose export files and shows them for review. */
  chooseFiles: () => Promise<void>;
  /** Looks at what the Evernote application has and shows its notebooks. */
  chooseEvernote: () => Promise<void>;
  setAccount: (index: number) => void;
  setSelected: (ids: string[]) => void;
  setWithoutMissing: (on: boolean) => void;
  startEvernote: () => Promise<void>;
  setName: (token: string, name: string) => void;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  show: () => void;
  hide: () => void;
  /** Closes the dialog and forgets a finished or unstarted import. */
  dismiss: () => void;
}

/**
 * An ENEX import from choosing files to its summary. It lives in a store,
 * not in the dialog, so that the dialog can be closed while a long import
 * continues and the sidebar can show its progress.
 */
export const useImportStore = create<ImportState>((set, get) => ({
  phase: 'idle',
  open: false,
  files: [],
  names: {},
  progress: null,
  outcomes: [],
  cancelling: false,
  error: null,
  accounts: null,
  account: 0,
  selected: [],
  withoutMissing: false,

  choose: async () => {
    if (get().phase !== 'idle' && get().phase !== 'done') {
      set({ open: true });
      return;
    }
    if (!canImportFromEvernote) {
      await get().chooseFiles();
      return;
    }
    set({ phase: 'source', open: true, progress: null, outcomes: [], cancelling: false, error: null });
  },

  chooseEvernote: async () => {
    set({
      phase: 'evernote',
      open: true,
      accounts: null,
      account: 0,
      selected: [],
      withoutMissing: false,
      error: null,
    });
    try {
      const accounts = await api.evernoteAccounts();
      // Everything that can be imported is chosen to begin with.
      set({
        accounts,
        selected: (accounts[0]?.notebooks ?? [])
          .filter((notebook) => notebook.notes > 0)
          .map((notebook) => notebook.id),
      });
    } catch (error) {
      set({ accounts: [], error: message(error) });
    }
  },

  setAccount: (index) =>
    set((state) => ({
      account: index,
      selected: (state.accounts?.[index]?.notebooks ?? [])
        .filter((notebook) => notebook.notes > 0)
        .map((notebook) => notebook.id),
    })),

  setSelected: (ids) => set({ selected: ids }),
  setWithoutMissing: (on) => set({ withoutMissing: on }),

  startEvernote: async () => {
    const { accounts, account, selected, phase, withoutMissing } = get();
    const chosen = accounts?.[account];
    if (phase !== 'evernote' || !chosen || !selected.length) return;
    const library = useLibraryStore.getState;
    const importId = crypto.randomUUID();
    set({ phase: 'running', progress: null, outcomes: [], cancelling: false, error: null });
    let lastRefresh = 0;
    let shownNotebook = false;
    const unlisten = await listen<ImportProgress>('bever:import-progress', (event) => {
      const progress = event.payload;
      if (progress.importId !== importId) return;
      set({ progress });
      if (progress.phase === 'notebookReady' && !shownNotebook) {
        shownNotebook = true;
        lastRefresh = Date.now();
        void library()
          .refreshOverview()
          .then(() => library().setFilter({ ...emptyFilter, notebookId: progress.notebookId }));
      } else if (Date.now() - lastRefresh >= REFRESH_INTERVAL_MS) {
        lastRefresh = Date.now();
        void library().refreshNotes();
        void library().refreshOverview();
      }
    }).catch(() => () => undefined);
    try {
      const all = selected.length === chosen.notebooks.length;
      const report = await api.importEvernote(importId, chosen.userId, all ? null : selected, withoutMissing);
      set({
        outcomes: [
          {
            fileName: 'Evernote on this computer',
            notebookName: '',
            notebooks: report.notebooks,
            report: { ...report, notebookId: '' },
            error: null,
          },
        ],
        phase: 'done',
        open: true,
      });
    } catch (error) {
      set({ error: message(error), phase: 'done', open: true });
    } finally {
      unlisten();
      set({ cancelling: false });
      await library().refreshAfterExternalChange();
      void api
        .ocrStatus()
        .then((status) => library().setOcr(status))
        .catch(() => undefined);
    }
  },

  chooseFiles: async () => {
    if (get().phase === 'running' || get().phase === 'review') {
      set({ open: true });
      return;
    }
    try {
      const files = await api.pickEnexFiles();
      if (!files.length) return;
      set({
        phase: 'review',
        open: true,
        files,
        names: Object.fromEntries(files.map((file) => [file.token, file.notebookName])),
        progress: null,
        outcomes: [],
        cancelling: false,
        error: null,
      });
    } catch (error) {
      useLibraryStore.getState().showError(error);
    }
  },

  setName: (token, name) => set((state) => ({ names: { ...state.names, [token]: name } })),

  start: async () => {
    const { files, names, phase } = get();
    if (phase !== 'review') return;
    const library = useLibraryStore.getState;
    const importId = crypto.randomUUID();
    set({ phase: 'running', progress: null, outcomes: [], cancelling: false, error: null });

    let lastRefresh = 0;
    let shownNotebook = false;
    const unlisten = await listen<ImportProgress>('bever:import-progress', (event) => {
      const progress = event.payload;
      if (progress.importId !== importId) return;
      set({ progress });
      if (progress.phase === 'notebookReady' && !shownNotebook) {
        // Show the first notebook at once, so notes are seen arriving.
        shownNotebook = true;
        lastRefresh = Date.now();
        void library()
          .refreshOverview()
          .then(() => library().setFilter({ ...emptyFilter, notebookId: progress.notebookId }));
      } else if (Date.now() - lastRefresh >= REFRESH_INTERVAL_MS) {
        lastRefresh = Date.now();
        void library().refreshNotes();
        void library().refreshOverview();
      }
    }).catch(() => () => undefined);

    try {
      const outcomes = await api.importEnex(
        importId,
        files.map((file) => ({
          token: file.token,
          notebookName: names[file.token]?.trim() || file.notebookName,
        })),
      );
      set({ outcomes, phase: 'done', open: true });
    } catch (error) {
      set({ error: message(error), phase: 'done', open: true });
    } finally {
      unlisten();
      set({ cancelling: false });
      await library().refreshAfterExternalChange();
      void api
        .ocrStatus()
        .then((status) => library().setOcr(status))
        .catch(() => undefined);
    }
  },

  cancel: async () => {
    if (get().phase !== 'running') return;
    set({ cancelling: true });
    await api.cancelImport().catch(() => undefined);
  },

  show: () => set({ open: true }),
  hide: () => set({ open: false }),
  dismiss: () => {
    if (get().phase === 'running') set({ open: false });
    else {
      set({
        phase: 'idle',
        open: false,
        files: [],
        names: {},
        progress: null,
        outcomes: [],
        error: null,
        accounts: null,
        selected: [],
        withoutMissing: false,
      });
    }
  },
}));
