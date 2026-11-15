import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../lib/api';
import type { SyncStatus } from '../types';
import { useLibraryStore } from './useLibraryStore';
import { useSyncStore } from './useSyncStore';

vi.mock('../lib/api', () => ({
  isNative: false,
  api: {
    syncNow: vi.fn(),
    syncStatus: vi.fn(),
    stopSync: vi.fn(),
    syncHistory: vi.fn(),
  },
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

function status(revision: number, running = true): SyncStatus {
  return {
    revision,
    runId: 1,
    running,
    stopping: false,
    stopped: false,
    progress: {
      retries: 0,
      phase: running ? 'pushing' : 'complete',
      message: running ? `Uploading revision ${revision}` : 'Synchronization complete',
      current: revision,
      total: 20,
      elapsedMs: revision * 100,
      networkMs: 30,
      remoteRequests: revision,
      bytesUploaded: 100,
      bytesDownloaded: 50,
    },
    lastReport: running
      ? null
      : {
          pushed: 2,
          pulled: 1,
          conflicts: 0,
          blobsUploaded: 0,
          blobsDownloaded: 0,
          syncedAt: 123,
          durationMs: 500,
          networkMs: 300,
          remoteRequests: 5,
          bytesUploaded: 100,
          bytesDownloaded: 50,
          warnings: [],
          retries: 0,
          throttled: 0,
        },
    error: null,
  };
}

describe('app-wide sync state', () => {
  beforeEach(() => {
    useSyncStore.setState({
      status: null,
      starting: false,
      initialized: false,
      receivedAt: 0,
      error: null,
      runs: [],
    });
    vi.clearAllMocks();
    vi.mocked(api.syncHistory).mockResolvedValue([]);
  });

  it('stops the run that is going, and only a run that is going', async () => {
    await useSyncStore.getState().stop();
    expect(api.stopSync).not.toHaveBeenCalled();

    useSyncStore.getState().applyStatus(status(1));
    vi.mocked(api.stopSync).mockResolvedValue({ ...status(2), stopping: true });
    await useSyncStore.getState().stop();
    expect(api.stopSync).toHaveBeenCalledTimes(1);
    expect(useSyncStore.getState().status).toMatchObject({ running: true, stopping: true });

    // The run ends as stopped: not an error, and no report.
    useSyncStore.getState().applyStatus({ ...status(3, false), lastReport: null, stopped: true });
    expect(useSyncStore.getState().status).toMatchObject({ running: false, stopped: true, error: null });
    await useSyncStore.getState().stop();
    expect(api.stopSync).toHaveBeenCalledTimes(1);
  });

  it('reads the record of runs when a run begins and when it ends, not at every step', async () => {
    const run = {
      startedAt: 1,
      activeAt: 2,
      endedAt: 2,
      outcome: 'failed' as const,
      message: 'network error: lost',
      pushed: 3,
      pulled: 0,
      blobsUploaded: 0,
      blobsDownloaded: 0,
      bytesUploaded: 0,
      bytesDownloaded: 0,
      heldBack: 0,
      retries: 0,
      throttled: 0,
    };
    vi.mocked(api.syncHistory).mockResolvedValue([run]);
    useSyncStore.getState().applyStatus(status(1));
    useSyncStore.getState().applyStatus(status(2));
    useSyncStore.getState().applyStatus(status(3));
    expect(api.syncHistory).toHaveBeenCalledTimes(1);
    useSyncStore
      .getState()
      .applyStatus({ ...status(4, false), lastReport: null, error: 'network error: lost' });
    expect(api.syncHistory).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(useSyncStore.getState().runs).toEqual([run]));
  });

  it('guards rapid duplicate clicks before the native call resolves', async () => {
    let resolve: ((value: SyncStatus) => void) | undefined;
    vi.mocked(api.syncNow).mockImplementation(
      () =>
        new Promise<SyncStatus>((done) => {
          resolve = done;
        }),
    );
    const first = useSyncStore.getState().start();
    const duplicate = useSyncStore.getState().start();
    expect(api.syncNow).toHaveBeenCalledTimes(1);
    resolve?.(status(1));
    expect(await first).toMatchObject({ runId: 1, running: true });
    expect(await duplicate).toBeNull();
  });

  it('restores live progress after Settings reopens without accepting stale queries', async () => {
    useSyncStore.getState().applyStatus(status(4));
    vi.mocked(api.syncStatus).mockResolvedValue(status(3));
    await useSyncStore.getState().refresh();
    expect(useSyncStore.getState().status?.progress.message).toBe('Uploading revision 4');
    vi.mocked(api.syncStatus).mockResolvedValue(status(5));
    await useSyncStore.getState().refresh();
    expect(useSyncStore.getState().status?.progress.message).toBe('Uploading revision 5');
  });

  it('keeps terminal reports and refreshes the library once', async () => {
    const refresh = vi.spyOn(useLibraryStore.getState(), 'refreshAfterExternalChange').mockResolvedValue();
    useSyncStore.getState().applyStatus(status(2, false));
    expect(useSyncStore.getState().status?.lastReport?.pushed).toBe(2);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    useSyncStore.getState().applyStatus(status(2, false));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
