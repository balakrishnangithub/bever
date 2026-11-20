import { ChevronRight, Folder, FolderCheck, FolderPlus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../lib/api';
import { dialogs } from '../lib/dialogs';
import {
  DEFAULT_FOLDER,
  folderNameProblem,
  folderTrail,
  freeFolderName,
  joinFolder,
  parentFolder,
  TOP,
} from '../lib/syncFolder';
import { useBackCloses } from '../lib/useBackCloses';
import { message, useLibraryStore } from '../store/useLibraryStore';
import type { PCloudStatus, SyncFolderView } from '../types';

interface Props {
  /** What the storage is called: "pCloud". */
  storage: string;
  /** The folder this library is kept in now, if one was chosen. */
  current: string | null;
  onClose: () => void;
  onChosen: (status: PCloudStatus) => void;
}

type Mode = 'new' | 'existing';

/**
 * Chooses where a library is kept at the storage: a folder that is made
 * for it, or the folder of a library that is there already, which this
 * device then joins. One account can hold several libraries this way,
 * each in a folder of its own.
 */
export function SyncFolderDialog({ storage, current, onClose, onChosen }: Props) {
  const notes = useLibraryStore((state) => state.overview.counts.all + state.overview.counts.trash);
  const [mode, setMode] = useState<Mode>(current ? 'existing' : 'new');
  const [view, setView] = useState<SyncFolderView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The name typed for a new folder; until one is typed, a name that is
  // free where the folder would be made is offered.
  const [typed, setTyped] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const asked = useRef(0);
  const dialog = useRef<HTMLElement>(null);
  useBackCloses(true, onClose);
  // Keys go to this dialog, not to what it was opened from: Escape closes
  // it and leaves Settings open.
  useEffect(() => dialog.current?.focus(), []);

  const open = useCallback(async (path: string) => {
    const mine = ++asked.current;
    setLoading(true);
    setError(null);
    try {
      const found = await api.lookAtSyncFolder(path);
      if (mine === asked.current) setView(found);
    } catch (failure) {
      if (mine === asked.current) setError(message(failure));
    } finally {
      if (mine === asked.current) setLoading(false);
    }
  }, []);

  // A library is looked for first where this one is kept, or where one is
  // kept unless another folder was chosen: the device that is set up is most
  // often another device of a library that is there. Without one, the top.
  useEffect(() => {
    const mine = ++asked.current;
    void api
      .lookAtSyncFolder(current ?? DEFAULT_FOLDER)
      .catch(() => null)
      .then((found) => {
        if (mine !== asked.current) return;
        if (found?.holdsLibrary) {
          setView(found);
          setMode('existing');
          setLoading(false);
        } else {
          void open(TOP);
        }
      });
  }, [current, open]);

  const name = typed ?? freeFolderName(view?.folders ?? []);
  const busy = loading || saving;
  const inUse = Boolean(view?.ours && current === view.path);

  const choose = (next: Mode) => {
    setMode(next);
    setError(null);
    // A new library is not started inside another.
    if (next === 'new' && view?.holdsLibrary) void open(parentFolder(view.path));
  };

  const settle = async (path: string, existing: boolean) => {
    setSaving(true);
    setError(null);
    try {
      onChosen(await api.chooseSyncFolder(path, existing));
    } catch (failure) {
      setError(message(failure));
    } finally {
      setSaving(false);
    }
  };

  const create = async () => {
    if (!view) return;
    const problem = folderNameProblem(name);
    if (problem) {
      setError(problem);
      return;
    }
    const path = joinFolder(view.path, name.trim());
    if (current) {
      const confirmed = await dialogs.confirm({
        title: 'Start a new library?',
        message: (
          <>
            <p>
              This device stops synchronizing with <code>{current}</code> and uploads all its notes to{' '}
              <code>{path}</code>.
            </p>
            <p>Nothing is removed from {current}; other devices go on synchronizing with it.</p>
          </>
        ),
        confirmLabel: 'Start new library',
      });
      if (!confirmed) return;
    }
    await settle(path, false);
  };

  const join = async () => {
    if (!view) return;
    // Two libraries become one, which cannot be taken back.
    if (!view.ours && (notes > 0 || current)) {
      const confirmed = await dialogs.confirm({
        title: 'Join this library?',
        message: (
          <>
            <p>
              The notes in <code>{view.path}</code> come to this device, and the notes of this device are
              added to that library, on every device that synchronizes with it.
            </p>
            <p>
              A note that both have, and have differently, is kept twice. To keep the notes of this device
              apart, start a new library instead.
            </p>
          </>
        ),
        confirmLabel: 'Join library',
      });
      if (!confirmed) return;
    }
    await settle(view.path, true);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        ref={dialog}
        tabIndex={-1}
        className="modal sync-folder-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Folder in ${storage}`}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header>
          <div>
            <p className="eyebrow">{storage}</p>
            <h2>Where this library is kept</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close folder chooser">
            <X />
          </button>
        </header>
        <div className="sync-folder-modes" role="radiogroup" aria-label="What to synchronize with">
          <label className={mode === 'new' ? 'chosen' : ''}>
            <input
              type="radio"
              name="sync-folder-mode"
              checked={mode === 'new'}
              onChange={() => choose('new')}
            />
            <span>
              <strong>Start a new library</strong>
              For notes that are kept apart from any library already in {storage}, such as another person’s. A
              folder is made, and the notes of this device are uploaded to it.
            </span>
          </label>
          <label className={mode === 'existing' ? 'chosen' : ''}>
            <input
              type="radio"
              name="sync-folder-mode"
              checked={mode === 'existing'}
              onChange={() => choose('existing')}
            />
            <span>
              <strong>Join an existing library</strong>
              For another device of a library that is in {storage} already. Its notes come to this device, and
              the notes of this device are added to it.
            </span>
          </label>
        </div>

        <nav className="sync-folder-trail" aria-label="Folder">
          <button type="button" disabled={busy || view?.path === TOP} onClick={() => void open(TOP)}>
            {storage}
          </button>
          {folderTrail(view?.path ?? TOP).map((step, index, trail) => (
            <span key={step.path}>
              <ChevronRight aria-hidden="true" />
              <button
                type="button"
                disabled={busy || index === trail.length - 1}
                aria-current={index === trail.length - 1 ? 'location' : undefined}
                onClick={() => void open(step.path)}
              >
                {step.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="sync-folder-list" aria-busy={loading} aria-label="Folders here">
          {view?.holdsLibrary ? (
            <p className="sync-folder-found" role="status">
              <FolderCheck aria-hidden="true" />
              <span>
                <strong>This folder holds a library.</strong>
                {view.ours
                  ? ' It is the one this device synchronizes with.'
                  : mode === 'new'
                    ? ' A new one cannot be started inside it.'
                    : ''}
              </span>
            </p>
          ) : (
            <>
              {view?.folders.map((folder) => (
                <button
                  type="button"
                  key={folder}
                  disabled={busy}
                  onClick={() => void open(joinFolder(view.path, folder))}
                >
                  <Folder aria-hidden="true" />
                  <span>{folder}</span>
                  <ChevronRight aria-hidden="true" />
                </button>
              ))}
              {view && view.folders.length === 0 && !loading && (
                <p className="sync-folder-none">No folders here.</p>
              )}
            </>
          )}
          {loading && !view && <p className="sync-folder-none">Looking in {storage}…</p>}
        </div>

        {mode === 'new' ? (
          <form
            className="sync-folder-act"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            {view?.holdsLibrary ? (
              <button
                type="button"
                className="secondary-action"
                disabled={busy}
                onClick={() => void open(parentFolder(view.path))}
              >
                Go up a folder
              </button>
            ) : (
              <>
                <label>
                  Name of the new folder
                  <input
                    value={name}
                    maxLength={100}
                    onChange={(event) => {
                      setTyped(event.target.value);
                      setError(null);
                    }}
                  />
                </label>
                {view && !folderNameProblem(name) && (
                  <p className="settings-pending">
                    The library will be kept in <code>{joinFolder(view.path, name.trim())}</code>.
                  </p>
                )}
                <button type="submit" className="primary-action" disabled={busy || !view}>
                  <FolderPlus />
                  {saving ? 'Making the folder…' : 'Start library here'}
                </button>
              </>
            )}
          </form>
        ) : (
          <div className="sync-folder-act">
            {view?.holdsLibrary ? (
              <button className="primary-action" disabled={busy || inUse} onClick={() => void join()}>
                <FolderCheck />
                {saving ? 'Joining…' : inUse ? 'This is the folder in use' : 'Synchronize with this library'}
              </button>
            ) : (
              <p className="settings-pending">
                Open the folder that holds the library. A folder that holds one says so when it is opened.
              </p>
            )}
          </div>
        )}
        {error && (
          <p className="sync-message error" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
