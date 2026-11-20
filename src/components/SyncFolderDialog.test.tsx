import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../lib/api';
import { useDialogStore } from '../lib/dialogs';
import { useLibraryStore } from '../store/useLibraryStore';
import type { PCloudStatus, SyncFolderView } from '../types';
import { SyncFolderDialog } from './SyncFolderDialog';

const folder = (path: string, rest: Partial<SyncFolderView> = {}): SyncFolderView => ({
  path,
  folders: [],
  empty: false,
  holdsLibrary: false,
  ours: false,
  ...rest,
});
const status = (path: string): PCloudStatus => ({
  connected: true,
  email: null,
  hostname: 'api.pcloud.com',
  lastSyncAt: null,
  authorizationPending: false,
  folder: path,
});

describe('choosing where a library is kept', () => {
  let host: HTMLElement;
  let root: Root;
  let there: Record<string, SyncFolderView>;
  const chosen = vi.fn<(status: PCloudStatus) => void>();

  /** Lets what was asked of the storage be answered and drawn. */
  const settled = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const draw = async (current: string | null) => {
    act(() =>
      root.render(
        <SyncFolderDialog storage="pCloud" current={current} onClose={() => undefined} onChosen={chosen} />,
      ),
    );
    await settled();
  };
  const button = (name: string | RegExp) => {
    const found = [...host.querySelectorAll('button')].find((candidate) =>
      typeof name === 'string'
        ? candidate.textContent?.trim() === name
        : name.test(candidate.textContent ?? ''),
    );
    if (!found) throw new Error(`no button ${String(name)} in: ${host.textContent}`);
    return found;
  };
  const press = async (name: string | RegExp) => {
    act(() => button(name).click());
    await settled();
  };
  const mode = async (label: RegExp) => {
    const radio = [...host.querySelectorAll('label')].find((candidate) =>
      label.test(candidate.textContent ?? ''),
    );
    act(() => radio?.querySelector('input')?.click());
    await settled();
  };
  const trail = () => host.querySelector('.sync-folder-trail')?.textContent;
  const newName = () => host.querySelector<HTMLInputElement>('.sync-folder-act input')?.value;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    chosen.mockClear();
    there = {
      '/': folder('/', { folders: ['Bever', 'Family'] }),
      '/Bever': folder('/Bever', { holdsLibrary: true }),
      '/Family': folder('/Family', { folders: ['Recipes'], empty: false }),
      '/Family/Recipes': folder('/Family/Recipes', { empty: true }),
    };
    vi.spyOn(api, 'lookAtSyncFolder').mockImplementation((path) =>
      there[path] ? Promise.resolve(there[path]) : Promise.reject(new Error(`there is no folder ${path}`)),
    );
    vi.spyOn(api, 'chooseSyncFolder').mockImplementation((path) => Promise.resolve(status(path)));
    useLibraryStore.setState((state) => ({
      overview: { ...state.overview, counts: { ...state.overview.counts, all: 0, trash: 0 } },
    }));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it('offers the library that is there to a device that has none, and joins it', async () => {
    await draw(null);
    // Looked for where libraries are kept unless told otherwise, and found.
    expect(trail()).toBe('pCloudBever');
    expect(host.textContent).toContain('This folder holds a library.');
    expect(
      host.querySelector<HTMLInputElement>('input[type=radio]:checked')?.parentElement?.textContent,
    ).toMatch(/Join an existing library/);
    // A device with no notes of its own has nothing to be asked about.
    await press('Synchronize with this library');
    expect(api.chooseSyncFolder).toHaveBeenCalledWith('/Bever', true);
    expect(chosen).toHaveBeenCalledWith(status('/Bever'));
  });

  it('starts a new library beside the one that is there, under a name that is free', async () => {
    await draw(null);
    await mode(/Start a new library/);
    // Not inside the other: where that one is, and not under its name.
    expect(trail()).toBe('pCloud');
    expect(newName()).toBe('Bever 2');
    expect(host.textContent).toContain('The library will be kept in /Bever 2.');
    // Further in, the name is free again.
    await press('Family');
    expect(trail()).toBe('pCloudFamily');
    expect(newName()).toBe('Bever');
    await press('Start library here');
    expect(api.chooseSyncFolder).toHaveBeenCalledWith('/Family/Bever', false);
    expect(chosen).toHaveBeenCalledWith(status('/Family/Bever'));
  });

  it('asks before two libraries become one, and says what the storage refused', async () => {
    useLibraryStore.setState((state) => ({
      overview: { ...state.overview, counts: { ...state.overview.counts, all: 12 } },
    }));
    await draw(null);
    await press('Synchronize with this library');
    const asked = useDialogStore.getState().request;
    expect(asked?.kind).toBe('confirm');
    expect(asked?.options.title).toBe('Join this library?');
    act(() => asked?.kind === 'confirm' && asked.resolve(false));
    await settled();
    expect(api.chooseSyncFolder).not.toHaveBeenCalled();

    // A name that cannot be one is said before anything is asked,
    await mode(/Start a new library/);
    const name = host.querySelector<HTMLInputElement>('.sync-folder-act input');
    const type = (value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, value);
        name?.dispatchEvent(new Event('input', { bubbles: true }));
      });
    type('a/b');
    await press('Start library here');
    expect(host.querySelector('[role=alert]')?.textContent).toMatch(/cannot have \//);
    expect(api.chooseSyncFolder).not.toHaveBeenCalled();
    // and what the storage refuses is said in its words; the dialog stays.
    vi.mocked(api.chooseSyncFolder).mockRejectedValueOnce(
      new Error('invalid data: /Family has other things in it. A library needs a folder of its own.'),
    );
    type('Family');
    await press('Start library here');
    expect(api.chooseSyncFolder).toHaveBeenCalledWith('/Family', false);
    expect(host.querySelector('[role=alert]')?.textContent).toBe(
      '/Family has other things in it. A library needs a folder of its own.',
    );
    expect(chosen).not.toHaveBeenCalled();
  });

  it('shows the folder in use to a library that has one, and asks before leaving it', async () => {
    there['/Bever'] = folder('/Bever', { holdsLibrary: true, ours: true });
    await draw('/Bever');
    expect(host.textContent).toContain('It is the one this device synchronizes with.');
    expect(button('This is the folder in use').disabled).toBe(true);

    await mode(/Start a new library/);
    await press('Start library here');
    const asked = useDialogStore.getState().request;
    expect(asked?.options.title).toBe('Start a new library?');
    act(() => asked?.kind === 'confirm' && asked.resolve(true));
    await settled();
    expect(api.chooseSyncFolder).toHaveBeenCalledWith('/Bever 2', false);
  });
});
