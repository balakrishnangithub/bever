import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { DialogHost } from './components/Dialog';
import { ImportDialog } from './components/ImportDialog';
import { NoteList } from './components/NoteList';
import { NoteWorkspace } from './components/NoteWorkspace';
import { Organizer } from './components/Organizer';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { api, isAndroid, isNative } from './lib/api';
import { editorSession } from './lib/editorSession';
import { useAppLayers } from './lib/useAppLayers';
import { useDrawerGestures } from './lib/useDrawerGestures';
import { onWindowShortened, showFocusedField } from './lib/windowHeight';
import { useLibraryStore } from './store/useLibraryStore';
import { useSyncStore } from './store/useSyncStore';
import type { OcrStatus } from './types';

/** How long a confirmation stays on screen. */
const NOTICE_MS = 6000;
/** Longest a closing window waits for the open note to be saved. */
const CLOSE_SAVE_LIMIT_MS = 4000;

export function App() {
  const initialize = useLibraryStore((state) => state.initialize);
  const createNote = useLibraryStore((state) => state.createNote);
  const error = useLibraryStore((state) => state.error);
  const notice = useLibraryStore((state) => state.notice);
  const clearError = useLibraryStore((state) => state.clearError);
  const clearNotice = useLibraryStore((state) => state.clearNotice);
  const loading = useLibraryStore((state) => state.loading);
  const hasSelectedNote = useLibraryStore((state) => state.selectedNote !== null);
  const { layer, openLayer, closeLayer } = useAppLayers();
  const sidebarOpen = layer === 'sidebar';
  const mobileEditor = layer === 'editor';
  const settingsOpen = layer === 'settings';
  const organizing = layer === 'notebooks' || layer === 'tags' ? layer : null;
  const [theme, setTheme] = useState(() => localStorage.getItem('bever-theme') ?? 'system');
  // The note alone, with the notebooks and the list of notes put away.
  const [focused, setFocused] = useState(() => localStorage.getItem('bever-note-focus') === 'on');
  const toggleFocus = useCallback(() => {
    setFocused((current) => {
      localStorage.setItem('bever-note-focus', current ? 'off' : 'on');
      return !current;
    });
  }, []);
  const syncStatus = useSyncStore((state) => state.status);
  const syncStarting = useSyncStore((state) => state.starting);

  // The on-screen keyboard takes the lower part of the window; a field that
  // was there is brought back into view.
  useEffect(() => onWindowShortened(showFocusedField), []);

  useEffect(() => {
    void initialize();
    void useSyncStore.getState().initialize();
  }, [initialize]);

  // Native events that concern the whole application.
  useEffect(() => {
    if (!isNative) return;
    const subscriptions = [
      listen<OcrStatus>('bever:ocr-status', (event) => useLibraryStore.getState().setOcr(event.payload)),
      // Closing saves the open note first. The native side then decides
      // whether to exit or, while a sync is running, only to hide the window.
      getCurrentWindow().onCloseRequested(async (event) => {
        event.preventDefault();
        await Promise.race([
          editorSession.flush().catch(() => undefined),
          new Promise((resolve) => window.setTimeout(resolve, CLOSE_SAVE_LIMIT_MS)),
        ]);
        await api.finishClose();
      }),
    ];
    return () => {
      void Promise.all(subscriptions).then((unlisteners) => unlisteners.forEach((unlisten) => unlisten()));
    };
  }, []);

  useEffect(() => {
    // Android applies native system-bar padding in MainActivity. Other shells
    // use CSS safe-area insets; avoid applying both on Android.
    document.documentElement.dataset.platform = isAndroid ? 'android' : 'other';
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('bever-theme', theme);
  }, [theme]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(clearNotice, NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice, clearNotice]);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modifier && key === 'n') {
        event.preventDefault();
        void createNote().then(() => openLayer('editor'));
      }
      if (modifier && (key === 'k' || (key === 'f' && event.shiftKey))) {
        event.preventDefault();
        closeLayer('editor');
        if (organizing) closeLayer(organizing);
        // The field of the list of notes, once that is what is showing.
        window.setTimeout(() =>
          document.querySelector<HTMLInputElement>('.notes-panel .search-wrap input')?.focus(),
        );
      }
      if (modifier && key === 'f' && !event.shiftKey && hasSelectedNote) {
        event.preventDefault();
        window.dispatchEvent(new Event('bever:find'));
      }
      if (modifier && event.key === '\\' && hasSelectedNote) {
        event.preventDefault();
        toggleFocus();
      }
      if (event.key === 'Escape') {
        if (settingsOpen) closeLayer('settings');
        else if (sidebarOpen) closeLayer('sidebar');
        // A dialog or a menu over the screen takes Escape for itself first.
        else if (organizing && !document.querySelector('.modal-backdrop, .context-menu'))
          closeLayer(organizing);
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [
    createNote,
    hasSelectedNote,
    settingsOpen,
    sidebarOpen,
    organizing,
    closeLayer,
    openLayer,
    toggleFocus,
  ]);

  const gestures = useDrawerGestures({
    open: sidebarOpen,
    blocked: settingsOpen || Boolean(organizing) || (mobileEditor && hasSelectedNote),
    onOpen: () => openLayer('sidebar'),
    onClose: () => closeLayer('sidebar'),
  });
  const syncActive = syncStarting || Boolean(syncStatus?.running);

  return (
    <div
      className={`app-shell ${mobileEditor && hasSelectedNote ? 'mobile-has-note' : ''} ${focused && hasSelectedNote ? 'note-focus' : ''} ${organizing ? 'organizing' : ''}`}
      {...gestures}
    >
      <Sidebar
        open={sidebarOpen}
        // Going somewhere from the sidebar also leaves the screen of
        // notebooks or of tags that lies over the list of notes.
        onClose={() => {
          closeLayer('sidebar');
          if (organizing) closeLayer(organizing);
        }}
        onOpenNote={() => openLayer('editor')}
        onSettings={() => openLayer('settings')}
        onOrganize={openLayer}
      />
      <NoteList onOpenSidebar={() => openLayer('sidebar')} onOpenNote={() => openLayer('editor')} />
      <NoteWorkspace
        onBack={() => closeLayer('editor')}
        focused={focused && hasSelectedNote}
        onToggleFocus={toggleFocus}
      />
      {organizing && <Organizer key={organizing} kind={organizing} onClose={() => closeLayer(organizing)} />}
      {syncActive && (
        <button
          className="global-sync-indicator"
          onClick={() => openLayer('settings')}
          title="View sync progress"
        >
          <RefreshCw className="spin" />
          <span>{syncStatus?.progress.message ?? 'Preparing synchronization…'}</span>
        </button>
      )}
      {loading && (
        <div className="loading-screen">
          <img className="brand-mark" src="/bever.svg" alt="" />
          <strong>Bever</strong>
          <span className="saving-spinner" />
        </div>
      )}
      <div className="toasts">
        {notice && (
          <div className="toast" role="status">
            <span>{notice}</span>
            <button onClick={clearNotice} aria-label="Dismiss">
              <X />
            </button>
          </div>
        )}
        {error && (
          <div className="toast error-toast" role="alert">
            <span>{error}</span>
            <button onClick={clearError} aria-label="Dismiss">
              <X />
            </button>
          </div>
        )}
      </div>
      {settingsOpen && (
        <SettingsDialog theme={theme} onTheme={setTheme} onClose={() => closeLayer('settings')} />
      )}
      <ImportDialog />
      <DialogHost />
    </div>
  );
}
