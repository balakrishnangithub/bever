/**
 * The open note editor, as seen by the rest of the application.
 *
 * The editor saves a short while after typing stops. Anything that is about
 * to take the note away (opening another note, closing the window) or change
 * it from outside (synchronization) first asks the editor to save through
 * here, so nothing typed is lost and nothing is overwritten unseen.
 */
export interface EditorSession {
  noteId: string;
  /** Saves pending changes; resolves when they are stored. */
  flush: () => Promise<void>;
  isDirty: () => boolean;
}

let current: EditorSession | null = null;

export const editorSession = {
  /** Registers the open editor and returns a function that unregisters it. */
  register(session: EditorSession): () => void {
    current = session;
    return () => {
      if (current === session) current = null;
    };
  },
  /** Saves the open editor's pending changes, if there is an open editor. */
  async flush(): Promise<void> {
    await current?.flush();
  },
  isDirty(): boolean {
    return current?.isDirty() ?? false;
  },
  noteId(): string | null {
    return current?.noteId ?? null;
  },
};
