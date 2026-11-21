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

const FIELDS = ['notebookId', 'title', 'contentHtml', 'attributes', 'tags'] as const;

const draftOf = (note: Note): Draft => ({
  notebookId: note.notebookId,
  title: note.title,
  contentHtml: note.contentHtml,
  attributes: note.attributes,
  tags: note.tags,
});

/** A value as text that is the same whatever order its names were given in. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Whether one part of a draft is the same in two drafts. */
function same(key: (typeof FIELDS)[number], one: Draft, other: Draft): boolean {
  if (one[key] === other[key]) return true;
  // The same tags in another order are the same tags.
  if (key === 'tags') return stable([...one.tags].sort()) === stable([...other.tags].sort());
  if (key === 'attributes') return stable(one.attributes) === stable(other.attributes);
  return false;
}

const sameDraft = (one: Draft, other: Draft) => FIELDS.every((key) => same(key, one, other));

/**
 * The unsaved state of one open note, and the rules for saving it.
 *
 * - A draft is unsaved when it differs from what is stored, and only then.
 *   Whether it does is worked out, not remembered: an edit that is taken
 *   back, a title typed again as it was, a tag added and removed, leave
 *   nothing to save, and nothing is saved. So a note is never stored anew,
 *   and never gets a new date, without having been changed.
 * - Changes are saved a short while after the last one (`delayMs`).
 * - Saves never overlap. Each tells the library which revision it started
 *   from, which is how a version that arrived from another device in the
 *   meantime is recognised and kept instead of being overwritten.
 * - `flush()` saves at once; it is called before the note is left.
 * - Before the first save, the application is given the chance to keep the
 *   note as it was (`beforeFirstSave`). So it is before the editor changes
 *   the stored note by other means than saving (`begin()`).
 *
 * It lives outside React so that these rules do not depend on render timing.
 */
export class DraftController {
  private snapshot: DraftSnapshot;
  private readonly listeners = new Set<() => void>();
  /** Revision of the stored note this draft is based on. */
  private baseRevision: number;
  /** What is stored, as far as this draft knows. */
  private base: Draft;
  private saving: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Whether what precedes the first save has been done. */
  private begun = false;
  /** What precedes the first save, while it is being done. */
  private beginning: Promise<boolean> | null = null;
  /** Whether anything was saved since what precedes the first save. */
  private savedSince = false;

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
    this.base = draftOf(note);
    this.snapshot = { draft: this.base, dirty: false, saveState: 'saved', contentVersion: 0 };
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

  /**
   * Records what a part of the note is now. A save is scheduled when the
   * draft then differs from what is stored; when it does not, because the
   * part is what it was or has come back to it, there is nothing to save.
   */
  update<Key extends keyof Draft>(key: Key, value: Draft[Key]): void {
    const draft = { ...this.snapshot.draft, [key]: value };
    clearTimeout(this.timer);
    const dirty = !sameDraft(draft, this.base);
    if (dirty) {
      this.set({ draft, dirty });
      this.timer = setTimeout(() => void this.flush().catch(() => undefined), this.delayMs);
    } else {
      // Unless a save is under way, which may be storing what was just
      // taken back: it looks again when it is done.
      this.set({ draft, dirty, saveState: this.saving ? this.snapshot.saveState : 'saved' });
    }
  }

  /**
   * The stored note is now `note`. Ignored when it is the result of this
   * draft's own save. Otherwise something else changed it (a move, a tag
   * added from the list, a pin, synchronization). Each part of the draft
   * that was not changed here follows the stored note; a part that was
   * changed here stays as it was typed.
   */
  noteChanged(note: Note): void {
    if (note.revision === this.baseRevision) return;
    this.follow(note);
  }

  /**
   * The editor itself changed the stored note by other means than saving
   * (it added an attachment, corrected the dates, chose a thumbnail). Call
   * with the stored result before the application learns of it, so it is
   * not mistaken for a change from outside.
   */
  adopt(note: Note): void {
    this.follow(note);
  }

  private follow(note: Note): void {
    this.baseRevision = note.revision;
    const stored = draftOf(note);
    const draft = { ...this.snapshot.draft };
    let shown = this.snapshot.contentVersion;
    for (const key of FIELDS) {
      if (!same(key, draft, this.base) || same(key, draft, stored)) continue;
      Object.assign(draft, { [key]: stored[key] });
      if (key === 'contentHtml') shown += 1;
    }
    this.base = stored;
    const dirty = !sameDraft(draft, stored);
    if (!dirty) clearTimeout(this.timer);
    this.set({ draft, dirty, contentVersion: shown });
  }

  /**
   * The stored note was put back to another form by this editor, which
   * shows that form from now on. Call `flush()` first: what is unsaved
   * here is given up.
   */
  replace(note: Note): void {
    clearTimeout(this.timer);
    this.baseRevision = note.revision;
    this.base = draftOf(note);
    // What follows is a new beginning, with its own first save.
    this.begun = false;
    this.savedSince = false;
    this.set({
      draft: this.base,
      dirty: false,
      saveState: 'saved',
      contentVersion: this.snapshot.contentVersion + 1,
    });
  }

  /**
   * Does what precedes the first save, unless it is done. The editor calls
   * this before it changes the stored note by other means than saving, as
   * by adding an attachment: the note is to be kept as it was before that
   * too, or what is kept would have the attachment already. Resolves to
   * whether it was done now. When it fails it is tried again the next time.
   */
  begin(): Promise<boolean> {
    if (this.begun || !this.beforeFirstSave) return Promise.resolve(false);
    this.beginning ??= this.beforeFirstSave()
      .then(
        () => {
          this.begun = true;
          this.savedSince = false;
          return true;
        },
        () => false,
      )
      .finally(() => {
        this.beginning = null;
      });
    return this.beginning;
  }

  /**
   * Nothing came of what `begin()` was called for: no file was chosen, or
   * it could not be added. Unless something was saved meanwhile, the first
   * save is then still to come, with what precedes it. Returns whether it
   * is.
   */
  unbegin(): boolean {
    if (!this.begun || this.savedSince) return false;
    this.begun = false;
    return true;
  }

  /** Saves pending edits now. Resolves once nothing typed so far is unsaved. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    // Wait for a running save; it may not include the latest edits.
    while (this.saving) await this.saving.catch(() => undefined);
    if (!this.snapshot.dirty) return;
    const sent = this.snapshot.draft;
    const input: SaveNote = { id: this.noteId, ...sent, baseRevision: this.baseRevision };
    this.set({ saveState: 'saving' });
    const save = this.begin()
      .then(() =>
        this.persist(input, (stored) => {
          this.baseRevision = stored.revision;
        }),
      )
      .then(
        () => {
          // What was sent is what is stored now. Edits made during the
          // save keep the draft unsaved for the next one.
          this.base = sent;
          this.savedSince = true;
          const dirty = !sameDraft(this.snapshot.draft, sent);
          this.set(dirty ? { dirty } : { dirty, saveState: 'saved' });
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
    if (this.snapshot.dirty) await this.flush();
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
