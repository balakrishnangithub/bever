import type { Note, SaveNote } from '../types';

/** The parts of a note the editor changes. */
export type Draft = Pick<Note, 'notebookId' | 'title' | 'contentHtml' | 'attributes' | 'tags'>;
export type SaveState = 'saved' | 'saving' | 'error';

export interface DraftSnapshot {
  draft: Draft;
  dirty: boolean;
  saveState: SaveState;
  /** Changes when the editor must show `draft.contentHtml` again. */
  contentVersion: number;
}

/**
 * Stores a draft. `beforeApply` must be called with the stored note before
 * the rest of the application learns of it.
 */
export type Persist = (input: SaveNote, beforeApply: (note: Note) => void) => Promise<unknown>;

const draftOf = (note: Note): Draft => ({
  notebookId: note.notebookId,
  title: note.title,
  contentHtml: note.contentHtml,
  attributes: note.attributes,
  tags: note.tags,
});

/**
 * The unsaved state of one open note, and the rules for saving it.
 *
 * - Changes are saved a short while after the last one (`delayMs`).
 * - Saves never overlap. Each tells the library which revision it started
 *   from, which is how a version that arrived from another device in the
 *   meantime is recognised and kept instead of being overwritten.
 * - `flush()` saves at once; it is called before the note is left.
 * - Before the first save, the application is given the chance to keep the
 *   note as it was (`beforeFirstSave`).
 *
 * It lives outside React so that these rules do not depend on render timing.
 */
export class DraftController {
  private snapshot: DraftSnapshot;
  private readonly listeners = new Set<() => void>();
  /** Revision of the stored note this draft is based on. */
  private baseRevision: number;
  /** Counts edits, to tell whether more arrived while a save was running. */
  private edits = 0;
  private saving: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Whether what precedes the first save has been done. */
  private begun = false;

  /**
   * `beforeFirstSave` runs once, before the first save: the application
   * uses it to keep the note as it was. If it fails the save goes ahead
   * all the same, and the next save tries it again.
   */
  constructor(
    note: Note,
    private readonly persist: Persist,
    private readonly delayMs = 650,
    private readonly beforeFirstSave?: () => Promise<unknown>,
  ) {
    this.noteId = note.id;
    this.baseRevision = note.revision;
    this.snapshot = { draft: draftOf(note), dirty: false, saveState: 'saved', contentVersion: 0 };
  }

  readonly noteId: string;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DraftSnapshot => this.snapshot;

  get isDirty(): boolean {
    return this.snapshot.dirty;
  }

  /** Records an edit and schedules a save. */
  update<Key extends keyof Draft>(key: Key, value: Draft[Key]): void {
    this.edits += 1;
    this.set({ draft: { ...this.snapshot.draft, [key]: value }, dirty: true });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush().catch(() => undefined), this.delayMs);
  }

  /**
   * The stored note is now `note`. Ignored when it is the result of this
   * draft's own save. Otherwise something else changed it (a move, a tag
   * added from the list, synchronization): without unsaved edits the draft
   * simply follows; with them, the typed content stays and only notebook
   * and tags, which the other operation may have changed, are taken over.
   */
  noteChanged(note: Note): void {
    if (note.revision === this.baseRevision) return;
    this.baseRevision = note.revision;
    if (this.snapshot.dirty) {
      this.set({ draft: { ...this.snapshot.draft, notebookId: note.notebookId, tags: note.tags } });
    } else {
      this.set({ draft: draftOf(note), contentVersion: this.snapshot.contentVersion + 1 });
    }
  }

  /**
   * The editor itself changed the stored note by other means than saving
   * (it added an attachment, corrected the dates). Call with the stored
   * result before the application learns of it, so it is not mistaken for a
   * change from outside.
   */
  adopt(note: Note): void {
    this.baseRevision = note.revision;
  }

  /**
   * The stored note was put back to another form by this editor, which
   * shows that form from now on. Call `flush()` first: what is unsaved
   * here is given up.
   */
  replace(note: Note): void {
    clearTimeout(this.timer);
    this.baseRevision = note.revision;
    this.edits += 1;
    // What follows is a new beginning, with its own first save.
    this.begun = false;
    this.set({
      draft: draftOf(note),
      dirty: false,
      saveState: 'saved',
      contentVersion: this.snapshot.contentVersion + 1,
    });
  }

  /** Saves pending edits now. Resolves once nothing typed so far is unsaved. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    // Wait for a running save; it may not include the latest edits.
    while (this.saving) await this.saving.catch(() => undefined);
    if (!this.snapshot.dirty) return;
    const edits = this.edits;
    const input: SaveNote = { id: this.noteId, ...this.snapshot.draft, baseRevision: this.baseRevision };
    this.set({ saveState: 'saving' });
    const ready =
      this.begun || !this.beforeFirstSave
        ? Promise.resolve()
        : this.beforeFirstSave().then(
            () => {
              this.begun = true;
            },
            () => undefined,
          );
    const save = ready
      .then(() =>
        this.persist(input, (stored) => {
          this.baseRevision = stored.revision;
        }),
      )
      .then(
        () => {
          // Edits made during the save keep the draft dirty for the next one.
          if (this.edits === edits) this.set({ dirty: false, saveState: 'saved' });
        },
        (error: unknown) => {
          this.set({ saveState: 'error' });
          throw error;
        },
      );
    const tracked = save.finally(() => {
      if (this.saving === tracked) this.saving = null;
    });
    this.saving = tracked;
    await tracked;
    if (this.snapshot.dirty && this.edits !== edits) await this.flush();
  }

  /** Stops the pending timer. Call `flush()` first to keep unsaved edits. */
  dispose(): void {
    clearTimeout(this.timer);
  }

  private set(change: Partial<DraftSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
}
