import { invoke } from '@tauri-apps/api/core';

import type {
  AppInfo,
  EvernoteAccount,
  EvernoteImportReport,
  ExportScope,
  ImportOutcome,
  ImportRequest,
  Note,
  NoteFilter,
  NoteOrganizationAction,
  NotePage,
  OcrStatus,
  Overview,
  PCloudStatus,
  PickedFile,
  Resource,
  SaveNote,
  SavedNote,
  SettingKey,
  Settings,
  ShortcutTarget,
  SyncStatus,
} from '../types';
import { browserApi } from './browserApi';
import { demoResourceUrl } from './demoResources';

/**
 * Everything the interface can ask of the native side. No call carries a
 * file path: files are chosen in native dialogs that the native side opens.
 */
export interface BeverApi {
  bootstrap: () => Promise<Overview>;
  listNotes: (filter: NoteFilter) => Promise<NotePage>;
  getNote: (id: string) => Promise<Note>;
  createNote: (notebookId: string | null) => Promise<Note>;
  saveNote: (input: SaveNote) => Promise<SavedNote>;
  setNotesTrashed: (noteIds: string[], trashed: boolean) => Promise<number>;
  deleteNotesPermanently: (noteIds: string[]) => Promise<number>;
  emptyTrash: () => Promise<number>;
  createNotebook: (name: string, stackId: string | null) => Promise<Overview>;
  renameNotebook: (id: string, name: string) => Promise<Overview>;
  deleteNotebook: (id: string) => Promise<Overview>;
  setNotebookStack: (notebookId: string, stackId: string | null) => Promise<Overview>;
  createStack: (name: string) => Promise<Overview>;
  renameStack: (id: string, name: string) => Promise<Overview>;
  deleteStack: (id: string) => Promise<Overview>;
  createTag: (name: string, parentId: string | null) => Promise<Overview>;
  renameTag: (id: string, name: string) => Promise<Overview>;
  /** Places a tag under another, or at the top when no parent is named. */
  setTagParent: (id: string, parentId: string | null) => Promise<Overview>;
  deleteTag: (id: string) => Promise<Overview>;
  toggleShortcut: (targetType: ShortcutTarget, targetId: string, label: string) => Promise<Overview>;
  organizeNotes: (
    noteIds: string[],
    action: NoteOrganizationAction,
    notebookId: string | null,
    tags: string[],
  ) => Promise<number>;
  updateNoteTimestamps: (id: string, createdAt: number, updatedAt: number) => Promise<Note>;
  getSettings: () => Promise<Settings>;
  setSetting: (key: SettingKey, enabled: boolean) => Promise<Settings>;
  appInfo: () => Promise<AppInfo>;
  /** Opens the native file dialog. Resolves to an empty list when cancelled. */
  pickEnexFiles: () => Promise<PickedFile[]>;
  importEnex: (importId: string, files: ImportRequest[]) => Promise<ImportOutcome[]>;
  cancelImport: () => Promise<void>;
  /** The accounts the Evernote application keeps on this computer. */
  evernoteAccounts: () => Promise<EvernoteAccount[]>;
  /**
   * Imports notebooks of an account, all of them when none are named. With
   * `withoutMissing`, a note whose attachments Evernote does not all have is
   * imported without those instead of being left out.
   */
  importEvernote: (
    importId: string,
    userId: string,
    notebookIds: string[] | null,
    withoutMissing: boolean,
  ) => Promise<EvernoteImportReport>;
  /** Opens the native file dialog and stores the chosen files as attachments. */
  attachFiles: (noteId: string) => Promise<Resource[]>;
  /** Stores a pasted or dropped file as an attachment. */
  attachBlob: (noteId: string, file: Blob, fileName: string) => Promise<Resource>;
  /** Resolves to the number of notes written, or null when cancelled. */
  exportNotes: (scope: ExportScope, suggestedName: string) => Promise<number | null>;
  /** Resolves to false when the save dialog was cancelled. */
  saveAttachment: (resourceId: string) => Promise<boolean>;
  openAttachment: (resourceId: string) => Promise<void>;
  openExternalUrl: (url: string) => Promise<void>;
  ocrStatus: () => Promise<OcrStatus>;
  /** Tells the native side that unsaved work is stored and the window may close. */
  finishClose: () => Promise<void>;
  syncNow: () => Promise<SyncStatus>;
  syncStatus: () => Promise<SyncStatus>;
  pcloudStatus: () => Promise<PCloudStatus>;
  connectPcloud: () => Promise<PCloudStatus>;
  cancelPcloudConnect: () => Promise<PCloudStatus>;
  connectPcloudToken: (accessToken: string, hostname: string) => Promise<PCloudStatus>;
  disconnectPcloud: () => Promise<PCloudStatus>;
  /**
   * Removes the library, the pCloud login, and the interface's preferences
   * from this device. The application ends; nothing changes in pCloud.
   */
  eraseLocalData: () => Promise<void>;
}

export const isNative = '__TAURI_INTERNALS__' in window;
export const isAndroid = isNative && /Android/i.test(navigator.userAgent);

/**
 * The file as base64. The browser's own encoder does it: a loop in script
 * takes ten times as long, which is seconds for a photograph on a phone.
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.onload = () => {
      // A data address: everything after its first comma is the base64.
      const address = typeof reader.result === 'string' ? reader.result : '';
      resolve(address.slice(address.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

const tauriApi: BeverApi = {
  bootstrap: () => invoke('bootstrap'),
  listNotes: (filter) => invoke('list_notes', { filter }),
  getNote: (id) => invoke('get_note', { id }),
  createNote: (notebookId) => invoke('create_note', { notebookId }),
  saveNote: (input) => invoke('save_note', { input }),
  setNotesTrashed: (noteIds, trashed) => invoke('set_notes_trashed', { noteIds, trashed }),
  deleteNotesPermanently: (noteIds) => invoke('delete_notes_permanently', { noteIds }),
  emptyTrash: () => invoke('empty_trash'),
  createNotebook: (name, stackId) => invoke('create_notebook', { name, stackId }),
  renameNotebook: (id, name) => invoke('rename_notebook', { id, name }),
  deleteNotebook: (id) => invoke('delete_notebook', { id }),
  setNotebookStack: (notebookId, stackId) => invoke('set_notebook_stack', { notebookId, stackId }),
  createStack: (name) => invoke('create_stack', { name }),
  renameStack: (id, name) => invoke('rename_stack', { id, name }),
  deleteStack: (id) => invoke('delete_stack', { id }),
  createTag: (name, parentId) => invoke('create_tag', { name, parentId }),
  renameTag: (id, name) => invoke('rename_tag', { id, name }),
  setTagParent: (id, parentId) => invoke('set_tag_parent', { id, parentId }),
  deleteTag: (id) => invoke('delete_tag', { id }),
  toggleShortcut: (targetType, targetId, label) => invoke('toggle_shortcut', { targetType, targetId, label }),
  organizeNotes: (noteIds, action, notebookId, tags) =>
    invoke('organize_notes', { noteIds, action, notebookId, tags }),
  updateNoteTimestamps: (id, createdAt, updatedAt) =>
    invoke('update_note_timestamps', { id, createdAt, updatedAt }),
  getSettings: () => invoke('get_settings'),
  setSetting: (key, enabled) => invoke('set_setting', { key, enabled }),
  appInfo: () => invoke('app_info'),
  pickEnexFiles: () => invoke('pick_enex_files'),
  importEnex: (importId, files) => invoke('import_enex', { importId, files }),
  cancelImport: () => invoke('cancel_import'),
  evernoteAccounts: () => invoke('evernote_local_overview'),
  importEvernote: (importId, userId, notebookIds, withoutMissing) =>
    invoke('import_evernote_local', { importId, userId, notebookIds, withoutMissing }),
  attachFiles: (noteId) => invoke('attach_files', { noteId }),
  attachBlob: async (noteId, file, fileName) => {
    // Android's bridge cannot carry raw bytes, so it gets base64 in JSON.
    if (isAndroid) {
      return invoke('attach_bytes', {
        noteId,
        fileName,
        mime: file.type || null,
        data: await blobToBase64(file),
      });
    }
    return invoke('attach_bytes', new Uint8Array(await file.arrayBuffer()), {
      headers: {
        'x-note-id': encodeURIComponent(noteId),
        'x-file-name': encodeURIComponent(fileName),
        'x-mime': encodeURIComponent(file.type),
      },
    });
  },
  exportNotes: (scope, suggestedName) => invoke('export_notes', { scope, suggestedName }),
  saveAttachment: (resourceId) => invoke('save_attachment', { resourceId }),
  openAttachment: (resourceId) => invoke('open_attachment', { resourceId }),
  openExternalUrl: (url) => invoke('open_external_url', { url }),
  ocrStatus: () => invoke('ocr_status'),
  finishClose: () => invoke('finish_close'),
  syncNow: () => invoke('sync_now'),
  syncStatus: () => invoke('sync_status'),
  pcloudStatus: () => invoke('pcloud_status'),
  connectPcloud: () => invoke('connect_pcloud'),
  cancelPcloudConnect: () => invoke('cancel_pcloud_connect'),
  connectPcloudToken: (accessToken, hostname) => invoke('connect_pcloud_token', { accessToken, hostname }),
  disconnectPcloud: () => invoke('disconnect_pcloud'),
  eraseLocalData: () => invoke('erase_local_data'),
};

export const api: BeverApi = isNative ? tauriApi : browserApi;

/**
 * Whether notes can be read from the Evernote application itself: on a
 * computer, where that application runs. The demonstration offers it when
 * asked to, so that the screens can be looked at.
 */
export const canImportFromEvernote = isNative
  ? !isAndroid
  : new URLSearchParams(window.location.search).has('demoEvernote');

/** Address of a small version of a picture, for the list of notes. */
export function thumbnailUrl(sha256: string): string {
  if (!isNative) return demoResourceUrl(sha256);
  return window.location.protocol === 'http:'
    ? `http://bever.localhost/thumb/${encodeURIComponent(sha256)}`
    : `bever://localhost/thumb/${encodeURIComponent(sha256)}`;
}

/** Address of an attachment, named by the hash its `<en-media>` carries. */
export function resourceUrl(reference: string): string {
  if (!isNative) return demoResourceUrl(reference);
  return window.location.protocol === 'http:'
    ? `http://bever.localhost/${encodeURIComponent(reference)}`
    : `bever://localhost/${encodeURIComponent(reference)}`;
}
