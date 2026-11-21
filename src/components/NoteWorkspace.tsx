import {
  ArrowLeft,
  Check,
  Download,
  Highlighter,
  Info,
  Keyboard,
  Lock,
  LockOpen,
  Maximize2,
  Minimize2,
  Pin,
  Plus,
  RotateCcw,
  Star,
  Tag,
  TextSearch,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { DraftController } from '../editor/draftController';
import { RichEditor } from '../editor/RichEditor';
import { api, isNative } from '../lib/api';
import { dialogs } from '../lib/dialogs';
import { editorSession } from '../lib/editorSession';
import { searchTerms } from '../lib/searchTerms';
import { useBackCloses } from '../lib/useBackCloses';
import { message, useLibraryStore } from '../store/useLibraryStore';
import {
  isPinned,
  thumbnailChoice,
  type Attributes,
  type Note,
  type NoteVersion,
  type Resource,
  type ThumbnailChoice,
} from '../types';

interface WorkspaceProps {
  onBack: () => void;
  /** Whether the notebooks and the list of notes are put away. */
  focused: boolean;
  onToggleFocus: () => void;
}

export function NoteWorkspace(props: WorkspaceProps) {
  const note = useLibraryStore((state) => state.selectedNote);
  if (!note) return <EmptyWorkspace />;
  // A new editor, and a new draft, for every note.
  return <NoteEditor key={note.id} note={note} {...props} />;
}

function NoteEditor({ note, onBack, focused, onToggleFocus }: WorkspaceProps & { note: Note }) {
  const notebooks = useLibraryStore((state) => state.overview.notebooks);
  const allTags = useLibraryStore((state) => state.overview.tags);
  const shortcuts = useLibraryStore((state) => state.overview.shortcuts);
  const saveNote = useLibraryStore((state) => state.saveNote);
  const setSelectedNote = useLibraryStore((state) => state.setSelectedNote);
  const refreshNotes = useLibraryStore((state) => state.refreshNotes);
  const refreshOverview = useLibraryStore((state) => state.refreshOverview);
  const toggleShortcut = useLibraryStore((state) => state.toggleShortcut);
  const pinNotes = useLibraryStore((state) => state.pinNotes);
  const trashNotes = useLibraryStore((state) => state.trashNotes);
  const restoreNotes = useLibraryStore((state) => state.restoreNotes);
  const deleteNotes = useLibraryStore((state) => state.deleteNotes);
  const exportNotes = useLibraryStore((state) => state.exportNotes);
  const showError = useLibraryStore((state) => state.showError);
  const showNotice = useLibraryStore((state) => state.showNotice);
  // What was found is what is marked: the other spelling, when the search
  // was answered by one.
  const query = useLibraryStore((state) => state.corrected ?? state.filter.query);
  const highlightSearch = useLibraryStore((state) => state.highlightSearch);
  const setHighlightSearch = useLibraryStore((state) => state.setHighlightSearch);
  // What the library is searched for, as far as a note's content can show it.
  const searched = useMemo(() => searchTerms(query), [query]);
  const highlight = useMemo(() => (highlightSearch ? searched : []), [highlightSearch, searched]);

  // The note as it was is kept before this visit's first change is saved,
  // so that changes made by mistake can be taken back although they are
  // saved like any others. What stands for that form is remembered here.
  const [keptVersion, setKeptVersion] = useState<number | null>(null);
  const [controller] = useState(
    () =>
      new DraftController(note, saveNote, undefined, async () =>
        setKeptVersion(await api.keepNoteVersion(note.id)),
      ),
  );
  // A note opens for writing, or for reading only where that is this
  // device's choice; the padlock changes it for this visit. A note just
  // made is for writing in.
  const [locked, setLocked] = useState(() => {
    const { openReadOnly, createdNoteId } = useLibraryStore.getState();
    return openReadOnly && createdNoteId !== note.id;
  });
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const { draft, saveState, contentVersion } = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useBackCloses(metadataOpen, () => setMetadataOpen(false));
  useBackCloses(shortcutsOpen, () => setShortcutsOpen(false));
  const [tagInput, setTagInput] = useState('');
  const tagListId = useId();
  const titleInput = useRef<HTMLTextAreaElement>(null);
  const trashed = note.deletedAt !== null;
  const readOnly = trashed || locked;
  const isShortcut = shortcuts.some((item) => item.targetType === 'note' && item.targetId === note.id);
  const pinned = isPinned(note);

  // The stored note changed: by this editor's save, or by something else.
  useEffect(() => controller.noteChanged(note), [controller, note]);

  // While this editor is open, the rest of the application can ask it to
  // save; it also saves when the window is hidden and when it goes away.
  useEffect(() => {
    const save = () => void controller.flush().catch(() => undefined);
    const unregister = editorSession.register({
      noteId: controller.noteId,
      flush: () => controller.flush(),
      isDirty: () => controller.isDirty,
    });
    const onHidden = () => {
      if (document.visibilityState === 'hidden') save();
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      unregister();
      save();
      controller.dispose();
    };
  }, [controller]);

  // A long title wraps; the field grows to show all of it. How it wraps
  // depends on its width too, which changes with the window and its panels.
  useEffect(() => {
    const field = titleInput.current;
    if (!field) return;
    let width = -1;
    const fit = () => {
      field.style.height = 'auto';
      field.style.height = `${field.scrollHeight}px`;
      width = field.clientWidth;
    };
    fit();
    const observer = new ResizeObserver(() => {
      if (field.clientWidth !== width) fit();
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [draft.title]);

  /** Applies a change the editor made by other means than saving. */
  const adopt = useCallback(
    (stored: Note) => {
      controller.adopt(stored);
      setSelectedNote(stored);
    },
    [controller, setSelectedNote],
  );

  /**
   * Chooses the picture that stands for the note in the list of notes. It
   * is said about the note, not written in it: the note keeps its date.
   */
  const chooseThumbnail = async (choice: ThumbnailChoice) => {
    try {
      // What is typed is stored first, so that the choice is not written over.
      await controller.flush();
      adopt(await api.setNoteThumbnail(note.id, choice));
      void refreshNotes();
      showNotice(
        choice.kind === 'picture'
          ? 'The list of notes now shows this note by this picture.'
          : choice.kind === 'none'
            ? 'The list of notes now shows this note without a picture.'
            : 'The list of notes shows this note by its largest picture again.',
      );
    } catch (error) {
      useLibraryStore.getState().showError(error);
    }
  };

  /**
   * Makes ready for adding to the note's attachments. What is typed is
   * stored first, and the note is kept as it then is, as before a save:
   * an attachment is the note's from the moment it is added, and discarding
   * the changes takes off what the kept note had not. Resolves to what to
   * call when nothing was added after all, so that a note nothing was done
   * to has nothing to discard.
   */
  const beforeAttaching = useCallback(async () => {
    await controller.flush();
    const kept = await controller.begin();
    return () => {
      if (kept && controller.unbegin()) setKeptVersion(null);
    };
  }, [controller]);

  const attachFiles = useCallback(async (): Promise<Resource[]> => {
    try {
      const nothingAdded = await beforeAttaching();
      const resources = await api.attachFiles(note.id).catch((error: unknown) => {
        nothingAdded();
        throw error;
      });
      if (resources.length) adopt(await api.getNote(note.id));
      else nothingAdded();
      return resources;
    } catch (error) {
      showError(error);
      return [];
    }
  }, [adopt, beforeAttaching, note.id, showError]);

  const attachBlob = useCallback(
    async (file: Blob, fileName: string): Promise<Resource | null> => {
      try {
        const nothingAdded = await beforeAttaching();
        const resource = await api.attachBlob(note.id, file, fileName).catch((error: unknown) => {
          nothingAdded();
          throw error;
        });
        adopt(await api.getNote(note.id));
        return resource;
      } catch (error) {
        showError(error);
        return null;
      }
    },
    [adopt, beforeAttaching, note.id, showError],
  );

  // The forms kept of the note are listed with its information.
  useEffect(() => {
    if (!metadataOpen) return;
    let stale = false;
    void api
      .noteVersions(note.id)
      .then((found) => {
        if (!stale) setVersions(found);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [metadataOpen, note.id, note.revision, keptVersion]);

  /** Puts a kept form of the note back, once that is confirmed. */
  const restore = async (version: number, title: string, text: string, confirmLabel: string) => {
    if (!(await dialogs.confirm({ title, message: text, confirmLabel }))) return;
    try {
      await controller.flush().catch(() => undefined);
      const restored = await api.restoreNoteVersion(note.id, version);
      controller.replace(restored);
      setSelectedNote(restored);
      setKeptVersion(null);
      void refreshNotes();
      void refreshOverview();
      showNotice('The note is as it was. What it was just now is kept under Note information.');
    } catch (error) {
      showError(error);
    }
  };

  const applyTimestamps = async (createdAt: number, updatedAt: number) => {
    await controller.flush();
    adopt(await api.updateNoteTimestamps(note.id, createdAt, updatedAt));
    void refreshNotes();
  };

  const addTag = () => {
    const name = tagInput.trim().replace(/^#/, '');
    setTagInput('');
    if (!name || draft.tags.some((tag) => tag.toLowerCase() === name.toLowerCase())) return;
    // Use the spelling of an existing tag rather than creating a near-duplicate.
    const existing = allTags.find((tag) => tag.name.toLowerCase() === name.toLowerCase());
    controller.update('tags', [...draft.tags, existing?.name ?? name]);
  };

  const deletePermanently = async () => {
    const confirmed = await dialogs.confirm({
      title: 'Delete permanently?',
      message: `“${draft.title || 'Untitled'}” and its attachments will be deleted from this device and, after the next sync, from your other devices. This cannot be undone.`,
      confirmLabel: 'Delete permanently',
      danger: true,
    });
    if (confirmed) {
      await deleteNotes([note.id]);
      onBack();
    }
  };

  const suggestions = allTags.filter(
    (tag) => !draft.tags.some((name) => name.toLowerCase() === tag.name.toLowerCase()),
  );

  return (
    <main className="editor-panel">
      <header className="workspace-header">
        <button className="icon-button editor-back" onClick={onBack} aria-label="Back to notes">
          <ArrowLeft />
        </button>
        <div className={`save-status ${saveState}`} aria-live="polite">
          {saveState === 'saving' ? (
            <span className="saving-spinner" />
          ) : saveState !== 'saved' ? (
            <X />
          ) : locked && !trashed ? (
            <Lock />
          ) : (
            <Check />
          )}
          <span>
            {trashed
              ? 'In Trash'
              : locked && saveState === 'saved'
                ? 'Read-only'
                : saveState === 'saving'
                  ? 'Saving…'
                  : saveState === 'saved'
                    ? 'Saved locally'
                    : 'Save failed'}
          </span>
        </div>
        {keptVersion !== null && !readOnly && (
          <button
            className="text-action discard-changes"
            title="Put the note back as it was when you opened it"
            onClick={() =>
              void restore(
                keptVersion,
                'Discard the changes?',
                'The note will be as it was when you opened it: its text, title, tags, details, and the date it was last changed. What it is now is kept under Note information, in case you want it back.',
                'Discard changes',
              )
            }
          >
            <Undo2 />
            <span>Discard changes</span>
          </button>
        )}
        <div className="workspace-actions">
          {!trashed && (
            <button
              className={`icon-button ${locked ? 'active' : ''}`}
              title={
                locked
                  ? 'Read-only: nothing can be changed by mistake. Unlock to write.'
                  : 'Lock this note against changes'
              }
              aria-label={locked ? 'Unlock this note' : 'Lock this note'}
              aria-pressed={locked}
              onClick={() => {
                if (!locked) void controller.flush().catch(() => undefined);
                setLocked(!locked);
              }}
            >
              {locked ? <Lock /> : <LockOpen />}
            </button>
          )}
          {searched.length > 0 && (
            <button
              className={`icon-button ${highlightSearch ? 'active' : ''}`}
              title={highlightSearch ? 'Hide what the search found' : 'Show what the search found'}
              aria-label="Highlight search matches"
              aria-pressed={highlightSearch}
              onClick={() => setHighlightSearch(!highlightSearch)}
            >
              <Highlighter />
            </button>
          )}
          <button
            className="icon-button"
            title="Find in this note (Ctrl+F)"
            aria-label="Find in this note"
            onClick={() => window.dispatchEvent(new Event('bever:find'))}
          >
            <TextSearch />
          </button>
          <button
            className={`icon-button ${isShortcut ? 'is-starred' : ''}`}
            title={isShortcut ? 'Remove shortcut' : 'Add shortcut'}
            aria-label={isShortcut ? 'Remove shortcut' : 'Add shortcut'}
            aria-pressed={isShortcut}
            onClick={() => void toggleShortcut('note', note.id, draft.title || 'Untitled')}
          >
            <Star />
          </button>
          {!trashed && (
            <button
              className={`icon-button desktop-pin ${pinned ? 'is-pinned' : ''}`}
              title={pinned ? 'Unpin from the top of its notebook' : 'Pin to the top of its notebook'}
              aria-label={pinned ? 'Unpin from notebook' : 'Pin to notebook'}
              aria-pressed={pinned}
              onClick={() => void pinNotes([note.id], !pinned)}
            >
              <Pin />
            </button>
          )}
          <button
            className={`icon-button ${metadataOpen ? 'active' : ''}`}
            title="Note information"
            aria-label="Note information"
            aria-pressed={metadataOpen}
            onClick={() => setMetadataOpen((value) => !value)}
          >
            <Info />
          </button>
          {isNative && (
            <button
              className="icon-button"
              title="Export as ENEX"
              aria-label="Export as ENEX"
              onClick={() =>
                void exportNotes({ kind: 'notes', noteIds: [note.id] }, draft.title || 'Untitled')
              }
            >
              <Download />
            </button>
          )}
          {trashed ? (
            <>
              <button className="text-action" onClick={() => void restoreNotes([note.id])}>
                <RotateCcw />
                Restore
              </button>
              <button
                className="icon-button danger"
                title="Delete permanently"
                aria-label="Delete permanently"
                onClick={() => void deletePermanently()}
              >
                <Trash2 />
              </button>
            </>
          ) : (
            <button
              className="icon-button"
              title="Move to Trash"
              aria-label="Move to Trash"
              onClick={() => {
                void trashNotes([note.id]);
                onBack();
              }}
            >
              <Trash2 />
            </button>
          )}
          <button
            className="icon-button focus-toggle"
            title={focused ? 'Show notebooks and notes (Ctrl+\\)' : 'Expand the note (Ctrl+\\)'}
            aria-label={focused ? 'Show notebooks and notes' : 'Expand the note'}
            aria-pressed={focused}
            onClick={onToggleFocus}
          >
            {focused ? <Minimize2 /> : <Maximize2 />}
          </button>
          <button
            className="icon-button"
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
            onClick={() => setShortcutsOpen(true)}
          >
            <Keyboard />
          </button>
        </div>
      </header>
      <div className={`workspace-body ${metadataOpen ? 'with-metadata' : ''}`}>
        <div className="document-column" tabIndex={0} aria-label="Note document">
          <div className="note-identity">
            <select
              aria-label="Notebook"
              value={draft.notebookId}
              disabled={readOnly}
              onChange={(event) => controller.update('notebookId', event.target.value)}
            >
              {notebooks.map((notebook) => (
                <option key={notebook.id} value={notebook.id}>
                  {notebook.name}
                </option>
              ))}
            </select>
            <span>·</span>
            <time dateTime={new Date(note.updatedAt).toISOString()}>
              {new Date(note.updatedAt).toLocaleDateString([], {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })}
            </time>
          </div>
          <textarea
            ref={titleInput}
            className="note-title"
            aria-label="Note title"
            placeholder="Untitled"
            rows={1}
            value={draft.title}
            readOnly={readOnly}
            onChange={(event) => controller.update('title', event.target.value.replace(/[\r\n]+/g, ' '))}
          />
          <div className="note-tags">
            <Tag className="note-tags-icon" aria-label="Tags" />
            {draft.tags.map((tag) => (
              <button
                key={tag}
                title={readOnly ? tag : `Remove ${tag}`}
                disabled={readOnly}
                onClick={() =>
                  controller.update(
                    'tags',
                    draft.tags.filter((item) => item !== tag),
                  )
                }
              >
                {tag}
                {!readOnly && <X />}
              </button>
            ))}
            {!readOnly && (
              <>
                <input
                  aria-label="Add a tag"
                  placeholder="Add tag"
                  list={tagListId}
                  value={tagInput}
                  onChange={(event) => setTagInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ',') {
                      event.preventDefault();
                      addTag();
                    }
                  }}
                  onBlur={addTag}
                />
                <datalist id={tagListId}>
                  {suggestions.map((tag) => (
                    <option key={tag.id} value={tag.name} />
                  ))}
                </datalist>
                <Plus className="tag-plus" />
              </>
            )}
          </div>
          <RichEditor
            note={{ ...note, contentHtml: draft.contentHtml }}
            editable={!readOnly}
            contentVersion={contentVersion}
            storedHtml={note.contentHtml}
            highlight={highlight}
            onChange={(html) => controller.update('contentHtml', html)}
            onAttachFiles={attachFiles}
            onAttachBlob={attachBlob}
            onThumbnail={(md5) =>
              void chooseThumbnail(md5 ? { kind: 'picture', md5 } : { kind: 'automatic' })
            }
          />
        </div>
        {metadataOpen && (
          <MetadataPanel
            note={note}
            attributes={draft.attributes}
            readOnly={readOnly}
            versions={versions}
            onRestore={(version) =>
              void restore(
                version.id,
                'Put this version back?',
                `The note will be as it was on ${formatWhen(version.keptAt)}: its text, title, tags, details, and the date it was last changed. What it is now is kept in this list, in case you want it back.`,
                'Put it back',
              )
            }
            onChange={(attributes) => controller.update('attributes', attributes)}
            onThumbnail={(choice) => void chooseThumbnail(choice)}
            onPin={(pin) => void pinNotes([note.id], pin)}
            onApplyTimestamps={applyTimestamps}
            onClose={() => setMetadataOpen(false)}
          />
        )}
      </div>
      {shortcutsOpen && <KeyboardShortcuts onClose={() => setShortcutsOpen(false)} />}
    </main>
  );
}

function KeyboardShortcuts({ onClose }: { onClose: () => void }) {
  const shortcuts = [
    ['Create a note', 'Ctrl / Cmd + N'],
    ['Search the whole library', 'Ctrl / Cmd + K or Ctrl / Cmd + Shift + F'],
    ['Find in this note', 'Ctrl / Cmd + F'],
    ['Go back or forward among the places you have been', 'Alt + ← or Alt + →'],
    ['Expand the note, or show the lists again', 'Ctrl / Cmd + \\'],
    ['Bold, italic, underline', 'Ctrl / Cmd + B, I, U'],
    ['Undo or redo', 'Ctrl / Cmd + Z or Ctrl / Cmd + Shift + Z'],
    ['Indent or outdent a list item', 'Tab or Shift + Tab'],
    ['Paste an image or file into a note', 'Ctrl / Cmd + V'],
    ['Close find, dialog, or navigation', 'Escape'],
  ];
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="modal shortcuts-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
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
            <p className="eyebrow">Contextual actions</p>
            <h2>Keyboard shortcuts</h2>
          </div>
          <button className="icon-button" autoFocus onClick={onClose} aria-label="Close keyboard shortcuts">
            <X />
          </button>
        </header>
        <dl>
          {shortcuts.map(([action, keys]) => (
            <div key={action}>
              <dt>{action}</dt>
              <dd>{keys}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

const EDITABLE_ATTRIBUTES = [
  ['author', 'Author'],
  ['source', 'Source'],
  ['source-url', 'Source URL'],
  ['subject-date', 'Subject date'],
  ['place-name', 'Place'],
  ['latitude', 'Latitude'],
  ['longitude', 'Longitude'],
] as const;

function MetadataPanel({
  note,
  attributes,
  readOnly,
  versions,
  onRestore,
  onChange,
  onThumbnail,
  onPin,
  onApplyTimestamps,
  onClose,
}: {
  note: Note;
  attributes: Attributes;
  /** Chooses what stands for the note in the list of notes. */
  onThumbnail: (choice: ThumbnailChoice) => void;
  /** Pins the note to the top of its notebook, or takes it down. */
  onPin: (pinned: boolean) => void;
  readOnly: boolean;
  /** The forms kept of the note before it was changed, the newest first. */
  versions: NoteVersion[];
  onRestore: (version: NoteVersion) => void;
  onChange: (value: Attributes) => void;
  onApplyTimestamps: (createdAt: number, updatedAt: number) => Promise<void>;
  onClose: () => void;
}) {
  const set = (key: string, value: string) => {
    const next = { ...attributes };
    if (value) next[key] = value;
    else delete next[key];
    onChange(next);
  };
  return (
    <aside className="metadata-panel">
      <header>
        <div>
          <p className="eyebrow">Details</p>
          <h2>Note information</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close note information">
          <X />
        </button>
      </header>
      {note.deletedAt === null && (
        <label className="metadata-check">
          <input type="checkbox" checked={isPinned(note)} onChange={(event) => onPin(event.target.checked)} />
          Pinned to the top of its notebook
        </label>
      )}
      <TimestampEditor
        key={`${note.createdAt}-${note.updatedAt}`}
        createdAt={note.createdAt}
        updatedAt={note.updatedAt}
        readOnly={readOnly}
        onApply={onApplyTimestamps}
      />
      <section className="note-versions" aria-label="Earlier versions">
        <h3>Earlier versions</h3>
        {versions.length === 0 ? (
          <p>
            None yet. Before a note is changed, Bever keeps it as it was, on this device. The last five are
            listed here, to be put back.
          </p>
        ) : (
          <ul>
            {versions.map((version) => (
              <li key={version.id}>
                <div>
                  <time dateTime={new Date(version.keptAt).toISOString()}>{formatWhen(version.keptAt)}</time>
                  <span>
                    <strong>{version.title || 'Untitled'}</strong>
                    {version.preview ? ` · ${version.preview}` : ''}
                  </span>
                </div>
                <button disabled={readOnly} onClick={() => onRestore(version)}>
                  Put back
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {EDITABLE_ATTRIBUTES.map(([key, label]) => (
        <label key={key}>
          {label}
          <input
            value={typeof attributes[key] === 'string' ? attributes[key] : ''}
            placeholder={key === 'source-url' ? 'https://…' : ''}
            readOnly={readOnly}
            onChange={(event) => set(key, event.target.value)}
          />
        </label>
      ))}
      {note.resources.some((resource) => resource.mime.startsWith('image/')) && (
        <label>
          Thumbnail in the list of notes
          <select
            aria-label="Thumbnail in the list of notes"
            value={thumbnailChoice(note.attributes).kind}
            disabled={note.deletedAt !== null}
            onChange={(event) => {
              if (event.target.value === 'none') onThumbnail({ kind: 'none' });
              else if (event.target.value === 'automatic') onThumbnail({ kind: 'automatic' });
            }}
          >
            <option value="automatic">The largest picture in the note</option>
            <option value="none">None</option>
            {/* Chosen from the picture's own menu in the note. */}
            <option value="picture" disabled={thumbnailChoice(note.attributes).kind !== 'picture'}>
              A picture chosen in the note
            </option>
          </select>
        </label>
      )}
      <p className="metadata-facts">
        {note.resources.length === 1 ? '1 attachment' : `${note.resources.length} attachments`}
        {' · '}
        {note.plainText ? note.plainText.split(/\s+/).length.toLocaleString() : 0} words
      </p>
      {note.originalEnml && (
        <div className="source-preservation">
          <Check />
          <p>
            <strong>Original ENML preserved</strong>
            <span>The imported source remains alongside your editable note.</span>
          </p>
        </div>
      )}
    </aside>
  );
}

function TimestampEditor({
  createdAt,
  updatedAt,
  readOnly,
  onApply,
}: {
  createdAt: number;
  updatedAt: number;
  readOnly: boolean;
  onApply: (createdAt: number, updatedAt: number) => Promise<void>;
}) {
  const [created, setCreated] = useState(() => localDateTimeValue(createdAt));
  const [updated, setUpdated] = useState(() => localDateTimeValue(updatedAt));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const apply = async () => {
    const createdTimestamp = new Date(created).getTime();
    const updatedTimestamp = new Date(updated).getTime();
    setStatus(null);
    if (!Number.isFinite(createdTimestamp) || !Number.isFinite(updatedTimestamp)) {
      setError('Enter a valid created and updated date and time.');
      return;
    }
    if (createdTimestamp < 0 || updatedTimestamp < createdTimestamp) {
      setError('Updated time must be at or after created time.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onApply(createdTimestamp, updatedTimestamp);
      setStatus('Timestamps updated.');
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="timestamp-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void apply();
      }}
    >
      <label>
        Created
        <input
          aria-label="Created date and time"
          type="datetime-local"
          step={1}
          required
          disabled={saving || readOnly}
          value={created}
          onChange={(event) => {
            setCreated(event.target.value);
            setError(null);
            setStatus(null);
          }}
        />
      </label>
      <label>
        Updated
        <input
          aria-label="Updated date and time"
          type="datetime-local"
          step={1}
          required
          disabled={saving || readOnly}
          value={updated}
          onChange={(event) => {
            setUpdated(event.target.value);
            setError(null);
            setStatus(null);
          }}
        />
      </label>
      {!readOnly && (
        <button className="primary-action" type="submit" disabled={saving || !created || !updated}>
          {saving ? 'Applying…' : 'Apply timestamps'}
        </button>
      )}
      <p>Dates and times use this device’s timezone.</p>
      {error && (
        <p className="timestamp-error" role="alert">
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
    </form>
  );
}

/** A moment, as a person would say it: the day and the time. */
function formatWhen(timestamp: number) {
  return new Date(timestamp).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function localDateTimeValue(timestamp: number) {
  const date = new Date(timestamp);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

function EmptyWorkspace() {
  return (
    <main className="editor-panel empty-workspace">
      <div className="empty-illustration">
        <img src="/bever.svg" alt="" />
        <i />
        <i />
        <i />
      </div>
      <h2>A quiet place for your thoughts</h2>
      <p>Select a note to start reading, or create a new one.</p>
      <kbd>Ctrl N</kbd>
    </main>
  );
}
