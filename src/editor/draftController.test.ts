import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Note, SaveNote } from '../types';
import { DraftController } from './draftController';

const note = (overrides: Partial<Note> = {}): Note => ({
  id: 'note-1',
  notebookId: 'inbox',
  title: 'Title',
  contentHtml: '<p>Stored</p>',
  originalEnml: null,
  plainText: 'Stored',
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  attributes: {},
  evernoteGuid: null,
  revision: 5,
  tags: ['one'],
  resources: [],
  ...overrides,
});

/** A stand-in for the library: stores what it is given, one revision later. */
function library(start = note()) {
  let stored = start;
  const saves: SaveNote[] = [];
  let release: (() => void) | null = null;
  let hold = false;
  return {
    saves,
    get stored() {
      return stored;
    },
    /** Makes the next save wait until `finish()` is called. */
    holdNextSave() {
      hold = true;
    },
    finish() {
      release?.();
    },
    persist: async (input: SaveNote, beforeApply: (note: Note) => void) => {
      saves.push(input);
      if (hold) {
        hold = false;
        await new Promise<void>((resolve) => (release = resolve));
      }
      stored = { ...stored, ...input, revision: stored.revision + 1 };
      beforeApply(stored);
    },
  };
}

describe('DraftController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('saves a short while after the last edit, with the revision it started from', async () => {
    const backend = library();
    const controller = new DraftController(note(), backend.persist, 650);
    controller.update('contentHtml', '<p>A</p>');
    controller.update('contentHtml', '<p>AB</p>');
    await vi.advanceTimersByTimeAsync(649);
    expect(backend.saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.saves).toHaveLength(1);
    expect(backend.saves[0]).toMatchObject({ id: 'note-1', contentHtml: '<p>AB</p>', baseRevision: 5 });
    expect(controller.getSnapshot()).toMatchObject({ dirty: false, saveState: 'saved' });
  });

  it('flush saves at once, so nothing typed is lost when the note is left', async () => {
    const backend = library();
    const controller = new DraftController(note(), backend.persist, 650);
    controller.update('title', 'Typed just before switching');
    await controller.flush();
    expect(backend.stored.title).toBe('Typed just before switching');
    expect(controller.isDirty).toBe(false);
    // The timer that was pending does not save a second time.
    await vi.advanceTimersByTimeAsync(1000);
    expect(backend.saves).toHaveLength(1);
    // And with nothing to save, flush does nothing.
    await controller.flush();
    expect(backend.saves).toHaveLength(1);
  });

  it('never overlaps saves and bases each on the revision of the one before', async () => {
    const backend = library();
    const controller = new DraftController(note(), backend.persist, 650);
    controller.update('contentHtml', '<p>first</p>');
    backend.holdNextSave();
    const first = controller.flush();
    await Promise.resolve();
    controller.update('contentHtml', '<p>second</p>');
    const second = controller.flush();
    await Promise.resolve();
    expect(backend.saves).toHaveLength(1);
    backend.finish();
    await Promise.all([first, second]);
    expect(backend.saves.map((save) => [save.contentHtml, save.baseRevision])).toEqual([
      ['<p>first</p>', 5],
      ['<p>second</p>', 6],
    ]);
    expect(backend.stored.contentHtml).toBe('<p>second</p>');
    expect(controller.getSnapshot()).toMatchObject({ dirty: false, saveState: 'saved' });
  });

  it('reports a failed save and keeps the edits for the next attempt', async () => {
    let fail = true;
    const backend = library();
    const controller = new DraftController(
      note(),
      async (input, beforeApply) => {
        if (fail) throw new Error('disk full');
        await backend.persist(input, beforeApply);
      },
      650,
    );
    controller.update('title', 'Kept');
    await expect(controller.flush()).rejects.toThrow('disk full');
    expect(controller.getSnapshot()).toMatchObject({ dirty: true, saveState: 'error' });
    fail = false;
    await controller.flush();
    expect(backend.stored.title).toBe('Kept');
    expect(controller.getSnapshot()).toMatchObject({ dirty: false, saveState: 'saved' });
  });

  it("does not treat the result of its own save as someone else's change", async () => {
    const backend = library();
    const controller = new DraftController(note(), backend.persist, 650);
    controller.update('contentHtml', '<p>mine</p>');
    await controller.flush();
    const before = controller.getSnapshot();
    controller.noteChanged(backend.stored);
    expect(controller.getSnapshot()).toBe(before);
  });

  it('follows a change from outside when there is nothing unsaved', () => {
    const controller = new DraftController(note(), library().persist, 650);
    controller.noteChanged(note({ revision: 9, contentHtml: '<p>From another device</p>', tags: ['two'] }));
    expect(controller.getSnapshot()).toMatchObject({
      dirty: false,
      contentVersion: 1,
      draft: { contentHtml: '<p>From another device</p>', tags: ['two'] },
    });
  });

  it('keeps typed content over a change from outside and saves against the new revision', async () => {
    const backend = library();
    const controller = new DraftController(note(), backend.persist, 650);
    controller.update('contentHtml', '<p>typed here</p>');
    // A tag was added from the note list, and the note moved, meanwhile.
    controller.noteChanged(note({ revision: 6, notebookId: 'work', tags: ['one', 'added'] }));
    expect(controller.getSnapshot()).toMatchObject({
      dirty: true,
      contentVersion: 0,
      draft: { contentHtml: '<p>typed here</p>', notebookId: 'work', tags: ['one', 'added'] },
    });
    await controller.flush();
    expect(backend.saves[0]).toMatchObject({ baseRevision: 6, tags: ['one', 'added'], notebookId: 'work' });
  });

  it('adopts changes the editor made itself, such as adding an attachment', async () => {
    const backend = library();
    const controller = new DraftController(note(), backend.persist, 650);
    const withAttachment = note({ revision: 6 });
    controller.adopt(withAttachment);
    const before = controller.getSnapshot();
    controller.noteChanged(withAttachment);
    expect(controller.getSnapshot()).toBe(before);
    controller.update('contentHtml', '<p>with <en-media hash="x"></en-media></p>');
    await controller.flush();
    expect(backend.saves[0]?.baseRevision).toBe(6);
  });

  it('saves nothing when what was changed is taken back', async () => {
    const backend = library();
    const controller = new DraftController(note(), backend.persist, 650);
    controller.update('title', 'Titles');
    expect(controller.getSnapshot()).toMatchObject({ dirty: true });
    controller.update('title', 'Title');
    expect(controller.getSnapshot()).toMatchObject({ dirty: false, saveState: 'saved' });
    // A tag added and removed, a move there and back: the same.
    controller.update('tags', ['one', 'two']);
    controller.update('tags', ['one']);
    controller.update('notebookId', 'work');
    controller.update('notebookId', 'inbox');
    await vi.advanceTimersByTimeAsync(5000);
    await controller.flush();
    expect(backend.saves).toHaveLength(0);
    expect(controller.isDirty).toBe(false);
  });

  it('saves nothing when the editor reports the page that is stored', async () => {
    const backend = library();
    const controller = new DraftController(note(), backend.persist, 650);
    // As when only the cursor was moved: the editor says that something
    // happened, and what it shows is what is stored.
    controller.update('contentHtml', '<p>Stored</p>');
    controller.update('contentHtml', '<p>Stored</p>');
    await vi.advanceTimersByTimeAsync(5000);
    expect(backend.saves).toHaveLength(0);
    expect(controller.getSnapshot()).toMatchObject({ dirty: false, saveState: 'saved' });
  });

  it('takes the same tags and details in another order for the same', async () => {
    const backend = library(note({ tags: ['one', 'two'], attributes: { author: 'Ada', source: 'web' } }));
    const controller = new DraftController(backend.stored, backend.persist, 650);
    controller.update('tags', ['two', 'one']);
    controller.update('attributes', { source: 'web', author: 'Ada' });
    expect(controller.isDirty).toBe(false);
    controller.update('attributes', { source: 'web', author: 'Grace' });
    expect(controller.isDirty).toBe(true);
    await controller.flush();
    expect(backend.saves).toHaveLength(1);
  });

  it('stores again what was taken back while a save was under way', async () => {
    const backend = library();
    const controller = new DraftController(note(), backend.persist, 650);
    backend.holdNextSave();
    controller.update('title', 'Changed');
    const first = controller.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.saves).toHaveLength(1);
    // Back to what it was, while "Changed" is on its way to being stored.
    controller.update('title', 'Title');
    backend.finish();
    await first;
    await controller.flush();
    expect(backend.saves.map((save) => save.title)).toEqual(['Changed', 'Title']);
    expect(backend.stored.title).toBe('Title');
    expect(controller.getSnapshot()).toMatchObject({ dirty: false, saveState: 'saved' });
  });

  it('lets each part that was not changed here follow a change from outside', async () => {
    const backend = library();
    const controller = new DraftController(note(), backend.persist, 650);
    controller.update('contentHtml', '<p>typed here</p>');
    // The note was pinned from the list meanwhile, which is said in its details.
    const pinned = { 'application-data': { 'bever.pinned': 'inbox 7' } };
    controller.noteChanged(note({ revision: 6, attributes: pinned }));
    expect(controller.getSnapshot()).toMatchObject({
      dirty: true,
      contentVersion: 0,
      draft: { contentHtml: '<p>typed here</p>', attributes: pinned },
    });
    await controller.flush();
    expect(backend.saves[0]).toMatchObject({ baseRevision: 6, attributes: pinned });
    // And a part that was changed here is kept against the one from outside.
    controller.update('title', 'Mine');
    controller.noteChanged(
      note({ revision: 8, title: 'Theirs', contentHtml: '<p>typed here</p>', attributes: pinned }),
    );
    expect(controller.getSnapshot().draft.title).toBe('Mine');
  });

  it('follows the editor’s own other changes, such as a thumbnail chosen, without a save', async () => {
    const backend = library();
    const controller = new DraftController(note(), backend.persist, 650);
    const chosen = { 'application-data': { 'bever.thumbnail': 'none' } };
    controller.adopt(note({ revision: 6, attributes: chosen }));
    expect(controller.getSnapshot()).toMatchObject({ dirty: false, draft: { attributes: chosen } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(backend.saves).toHaveLength(0);
  });

  it('notifies subscribers and stops after dispose', async () => {
    const backend = library();
    const controller = new DraftController(note(), backend.persist, 650);
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    controller.update('title', 'x');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    controller.update('title', 'xy');
    expect(listener).toHaveBeenCalledTimes(1);
    controller.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    expect(backend.saves).toHaveLength(0);
  });

  it('lets the note be kept as it was before the first save, and only then', async () => {
    const backend = library();
    const order: string[] = [];
    const controller = new DraftController(
      note(),
      async (input, beforeApply) => {
        order.push('save');
        await backend.persist(input, beforeApply);
      },
      650,
      () => {
        order.push('keep');
        return Promise.resolve();
      },
    );
    controller.update('title', 'a');
    await controller.flush();
    controller.update('title', 'ab');
    await controller.flush();
    expect(order).toEqual(['keep', 'save', 'save']);

    // Put back to another form: that form is shown, nothing is unsaved,
    // and what follows is a new beginning with its own first save.
    controller.replace(note({ revision: 9, title: 'As it was' }));
    expect(controller.getSnapshot()).toMatchObject({ dirty: false, saveState: 'saved' });
    expect(controller.getSnapshot().draft.title).toBe('As it was');
    controller.update('title', 'As it was, and more');
    await controller.flush();
    expect(order).toEqual(['keep', 'save', 'save', 'keep', 'save']);
    expect(backend.saves.at(-1)?.baseRevision).toBe(9);
  });

  it('saves all the same when the note could not be kept, and tries again', async () => {
    const backend = library();
    const keep = vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValue(1);
    const controller = new DraftController(note(), backend.persist, 650, keep);
    controller.update('title', 'a');
    await controller.flush();
    expect(backend.saves).toHaveLength(1);
    controller.update('title', 'ab');
    await controller.flush();
    expect(keep).toHaveBeenCalledTimes(2);
    controller.update('title', 'abc');
    await controller.flush();
    expect(keep).toHaveBeenCalledTimes(2);
    expect(backend.saves).toHaveLength(3);
  });
});
