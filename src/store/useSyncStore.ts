import { listen } from '@tauri-apps/api/event';
import { create } from 'zustand';

import { api, isNative } from '../lib/api';
import type { SyncRun, SyncStatus } from '../types';
import { useLibraryStore } from './useLibraryStore';

interface SyncState {
  status: SyncStatus | null;
  starting: boolean;
  initialized: boolean;
  receivedAt: number;
  error: string | null;
  /** The latest runs, newest first, as the library remembers them. */
  runs: SyncRun[];
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;
  applyStatus: (status: SyncStatus) => void;
  start: () => Promise<SyncStatus | null>;
  /** Stops the run that is going. What it transferred stays. */
  stop: () => Promise<void>;
  loadRuns: () => Promise<void>;
  clearError: () => void;
}

let listening = false;
let refreshSequence = 0;
let refreshedRunId = 0;

/** A single subscription survives Settings, navigation, and window visibility. */
export const useSyncStore = create<SyncState>((set, get) => {
  const applyStatus = (status: SyncStatus) => {
    const current = get().status;
    // Native revisions are monotonic. A slower status query can never replace
    // a newer event received while Settings was being opened.
    if (current && status.revision < current.revision) return;
    set({ status, receivedAt: Date.now(), error: null });
    // A run that began or ended has changed the record of runs.
    if (!current || current.running !== status.running) void get().loadRuns();
    if (!status.running && status.lastReport && status.runId !== refreshedRunId) {
      refreshedRunId = status.runId;
      // Notes, notebooks, and the open note may all have changed.
      void useLibraryStore.getState().refreshAfterExternalChange();
    }
  };

  return {
    status: null,
    starting: false,
    initialized: false,
    receivedAt: 0,
    error: null,
    runs: [],
    initialize: async () => {
      if (!isNative) {
        // The demonstration in a browser tells of its runs in the page.
        if (!listening) {
          listening = true;
          window.addEventListener('bever:sync-status', (event) =>
            applyStatus((event as CustomEvent<SyncStatus>).detail),
          );
        }
        await get().loadRuns();
        set({ initialized: true });
        return;
      }
      if (!listening) {
        listening = true;
        try {
          await listen<SyncStatus>('bever:sync-status', (event) => applyStatus(event.payload));
        } catch (error) {
          listening = false;
          set({ error: message(error) });
          return;
        }
      }
      await get().refresh();
      set({ initialized: true });
    },
    refresh: async () => {
      const sequence = ++refreshSequence;
      try {
        const status = await api.syncStatus();
        if (sequence === refreshSequence) applyStatus(status);
      } catch (error) {
        if (sequence === refreshSequence) set({ error: message(error) });
      }
    },
    applyStatus,
    start: async () => {
      if (get().starting || get().status?.running) return get().status;
      set({ starting: true, error: null });
      try {
        const status = await api.syncNow();
        applyStatus(status);
        return status;
      } catch (error) {
        set({ error: message(error) });
        return null;
      } finally {
        set({ starting: false });
      }
    },
    stop: async () => {
      if (!get().status?.running) return;
      try {
        applyStatus(await api.stopSync());
      } catch (error) {
        set({ error: message(error) });
      }
    },
    loadRuns: async () => {
      try {
        set({ runs: await api.syncHistory() });
      } catch {
        // The record is a help; without it everything else works.
      }
    },
    clearError: () => set({ error: null }),
  };
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
