import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { DialogHost } from './components/Dialog';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ImportDialog } from './components/ImportDialog';
import { NoteList } from './components/NoteList';
import { NoteWorkspace } from './components/NoteWorkspace';
import { Organizer } from './components/Organizer';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { api, isAndroid, isNative } from './lib/api';
import { backStack } from './lib/backStack';
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
  const selectedNoteId = useLibraryStore((state) => state.selectedNote?.id ?? null);
  const hasSelectedNote = selectedNoteId !== null;
  // Where one is in the library is the library's to say: the screen of
  // notebooks or of tags, and whether the open note is in front of the list.
  const organizing = useLibraryStore((state) => state.screen);
  const reading = useLibraryStore((state) => state.reading);
  const showScreen = useLibraryStore((state) => state.showScreen);
  const closeNote = useLibraryStore((state) => state.closeNote);
  const { layer, openLayer, closeLayer } = useAppLayers();
  const sidebarOpen = layer === 'sidebar';
  const settingsOpen = layer === 'settings';
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

  // Back goes to where one was, once whatever is open has been closed:
  // Android's button or gesture, and anything else that steps back in the
  // window's history. The library says how many places lie behind.
  useEffect(() => {
    const back = () => void useLibraryStore.getState().goBack();
    // What covers the list where one is: a screen, or the open note in a
    // window that has room for one of the two only. What was opened on the
    // list is under it then, and is not what Back closes first.
    const tell = () => {
      const state = useLibraryStore.getState();
      const phone = window.matchMedia('(max-width: 760px)').matches;
      const front = state.screen ?? (phone && state.reading && state.selectedNote ? 'note' : 'list');
      backStack.places(state.placeAt, back, front);
    };
    tell();
    return useLibraryStore.subscribe((state, before) => {
      if (
        state.placeAt !== before.placeAt ||
        state.screen !== before.screen ||
        state.reading !== before.reading ||
        (state.selectedNote === null) !== (before.selectedNote === null)
      )
        tell();
    });
  }, []);

  // A note that is put out of sight stops playing. Its editor stays where
  // it is, under a screen or beside the list in the phone layout, and a
  // video in it would go on with nothing to stop it by.
  useEffect(() => {
    const phone = window.matchMedia('(max-width: 760px)').matches;
    if (!organizing && !(phone && !reading)) return;
    for (const media of document.querySelectorAll<HTMLMediaElement>(
      '.editor-panel video, .editor-panel audio',
    ))
      media.pause();
  }, [reading, organizing]);

  // The buttons a mouse has for going back and forward.
  useEffect(() => {
    const onMouse = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      const { goBack, goForward } = useLibraryStore.getState();
      void (event.button === 3 ? goBack() : goForward());
    };
    window.addEventListener('mouseup', onMouse);
    return () => window.removeEventListener('mouseup', onMouse);
  }, []);

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
        void createNote();
      }
      if (modifier && (key === 'k' || (key === 'f' && event.shiftKey))) {
        event.preventDefault();
        showScreen(null);
        // Where the note is in front of the list, the list comes forward.
        if (window.matchMedia('(max-width: 760px)').matches) void closeNote();
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
      // Back and forward among the places one has been, as in a browser.
      if (event.altKey && !modifier && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        if (document.querySelector('.modal-backdrop')) return;
        event.preventDefault();
        const { goBack, goForward } = useLibraryStore.getState();
        void (event.key === 'ArrowLeft' ? goBack() : goForward());
      }
      if (event.key === 'Escape') {
        if (settingsOpen) closeLayer('settings');
        else if (sidebarOpen) closeLayer('sidebar');
        // A dialog or a menu over the screen takes Escape for itself first.
        // The store is asked, not what was last drawn: it knows of a screen
        // from the moment it was asked for.
        else if (
          useLibraryStore.getState().screen &&
          !document.querySelector('.modal-backdrop, .context-menu')
        )
          showScreen(null);
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [
    createNote,
    closeNote,
    hasSelectedNote,
    settingsOpen,
    sidebarOpen,
    closeLayer,
    showScreen,
    toggleFocus,
  ]);

  const gestures = useDrawerGestures({
    open: sidebarOpen,
    blocked: settingsOpen || Boolean(organizing) || (reading && hasSelectedNote),
    onOpen: () => openLayer('sidebar'),
    onClose: () => closeLayer('sidebar'),
  });
  const syncActive = syncStarting || Boolean(syncStatus?.running);

  return (
    <div
      className={`app-shell ${reading && hasSelectedNote ? 'mobile-has-note' : ''} ${focused && hasSelectedNote ? 'note-focus' : ''} ${organizing ? 'organizing' : ''}`}
      {...gestures}
    >
      <Sidebar
        open={sidebarOpen}
        onClose={() => closeLayer('sidebar')}
        onSettings={() => openLayer('settings')}
        onOrganize={showScreen}
      />
      <NoteList onOpenSidebar={() => openLayer('sidebar')} />
      {/* A note that cannot be drawn says so, and leaves the lists to go
          on from. Another note is another try. */}
      <ErrorBoundary
        key={selectedNoteId}
        fallback={(error, retry) => (
          <main className="editor-panel empty-workspace" role="alert">
            <h2>This note cannot be shown</h2>
            <p>
              Something in it could not be drawn. The note itself is stored and unchanged; it can still be
              exported.
            </p>
            <pre className="failure-detail">{error.message}</pre>
            <div className="failure-actions">
              <button onClick={() => void closeNote()}>Back to notes</button>
              <button onClick={retry}>Try again</button>
            </div>
          </main>
        )}
      >
        <NoteWorkspace
          onBack={() => void closeNote()}
          focused={focused && hasSelectedNote}
          onToggleFocus={toggleFocus}
        />
      </ErrorBoundary>
      {organizing && <Organizer key={organizing} kind={organizing} onClose={() => showScreen(null)} />}
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
