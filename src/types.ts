export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Attributes = Record<string, JsonValue>;

export interface Stack {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export interface Notebook {
  id: string;
  name: string;
  stackId: string | null;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export interface Tag {
  id: string;
  name: string;
  parentId: string | null;
  color: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ShortcutTarget = 'note' | 'notebook' | 'stack' | 'tag';

export interface Shortcut {
  id: string;
  targetType: ShortcutTarget;
  targetId: string;
  label: string;
  sortOrder: number;
  createdAt: number;
}

export interface Resource {
  id: string;
  noteId: string;
  sha256: string;
  md5: string;
  mime: string;
  fileName: string | null;
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  recognitionXml: string | null;
  recognitionText: string | null;
  attributes: Attributes;
  alternateSha256: string | null;
  position: number;
}

export interface Note {
  id: string;
  notebookId: string;
  title: string;
  contentHtml: string;
  originalEnml: string | null;
  plainText: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  attributes: Attributes;
  evernoteGuid: string | null;
  revision: number;
  tags: string[];
  resources: Resource[];
}

export interface NoteSummary {
  id: string;
  notebookId: string;
  notebookName: string;
  title: string;
  /** Plain text. Matches of a search are wrapped in the snippet marker characters. */
  snippet: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  tags: string[];
  hasAttachments: boolean;
  isShortcut: boolean;
  /** SHA-256 of the picture that stands for the note in a list, if it has one. */
  thumbnail: string | null;
}

/**
 * The key under a note's `application-data` that names, by its MD5, the
 * picture chosen to stand for the note in a list.
 */
export const THUMBNAIL_KEY = 'bever.thumbnail';

/** The MD5 of the picture chosen to stand for a note, if one was chosen. */
export function chosenThumbnail(attributes: Attributes): string | null {
  const data = attributes['application-data'];
  const chosen = data && typeof data === 'object' && !Array.isArray(data) ? data[THUMBNAIL_KEY] : null;
  return typeof chosen === 'string' && chosen ? chosen : null;
}

/** `attributes` with `md5` as the picture chosen for the note, or with none chosen. */
export function withThumbnail(attributes: Attributes, md5: string | null): Attributes {
  const data = attributes['application-data'];
  const kept = data && typeof data === 'object' && !Array.isArray(data) ? { ...data } : {};
  if (md5) kept[THUMBNAIL_KEY] = md5;
  else delete kept[THUMBNAIL_KEY];
  const next = { ...attributes };
  if (Object.keys(kept).length) next['application-data'] = kept;
  else delete next['application-data'];
  return next;
}

/** One page of a listing and the size of the whole result. */
export interface NotePage {
  notes: NoteSummary[];
  total: number;
  /**
   * The search as it was understood, when nothing answered it as typed and
   * words spelt nearly so did.
   */
  corrected?: string | null;
}

export interface SaveNote {
  id: string;
  notebookId: string;
  title: string;
  contentHtml: string;
  attributes: Attributes;
  tags: string[];
  /**
   * Revision the editor started from. If the stored note has since changed
   * (synchronization replaced it), that version is kept as a conflict copy.
   */
  baseRevision: number | null;
}

export interface SavedNote {
  note: Note;
  /** Title of the note that preserves the version this save replaced. */
  conflictCopy: string | null;
}

export type NoteSort =
  'relevance' | 'updatedDesc' | 'updatedAsc' | 'createdDesc' | 'createdAsc' | 'titleAsc' | 'titleDesc';

export interface NoteFilter {
  query: string;
  notebookId: string | null;
  stackId: string | null;
  tagIds: string[];
  includeTrash: boolean;
  trashOnly: boolean;
  createdFrom: number | null;
  createdTo: number | null;
  updatedFrom: number | null;
  updatedTo: number | null;
  contains: string | null;
  sort: NoteSort;
  limit: number;
  offset: number;
}

/** Notes fetched per request; more load as the list is scrolled. */
export const PAGE_SIZE = 100;

export const emptyFilter: NoteFilter = {
  query: '',
  notebookId: null,
  stackId: null,
  tagIds: [],
  includeTrash: false,
  trashOnly: false,
  createdFrom: null,
  createdTo: null,
  updatedFrom: null,
  updatedTo: null,
  contains: null,
  sort: 'updatedDesc',
  limit: PAGE_SIZE,
  offset: 0,
};

export interface LibrarySnapshot {
  stacks: Stack[];
  notebooks: Notebook[];
  tags: Tag[];
  shortcuts: Shortcut[];
}

/** Notes outside the trash per notebook and tag, plus totals. */
export interface LibraryCounts {
  all: number;
  trash: number;
  notebooks: Record<string, number>;
  tags: Record<string, number>;
}

export interface Overview extends LibrarySnapshot {
  counts: LibraryCounts;
}

export const emptyOverview: Overview = {
  stacks: [],
  notebooks: [],
  tags: [],
  shortcuts: [],
  counts: { all: 0, trash: 0, notebooks: {}, tags: {} },
};

export interface ImportReport {
  notesImported: number;
  /** Notes whose newer form took the place of the one imported before. */
  notesUpdated: number;
  /** Of the imported notes, those added beside a form of themselves that was changed here. */
  notesKeptBoth: number;
  notesSkipped: number;
  notesFailed: number;
  /** Only from the Evernote application: notes imported without attachments it does not have. */
  notesIncomplete?: number;
  /** Only from the Evernote application: tags placed under the tags they are under there. */
  tagsNested?: number;
  resourcesImported: number;
  bytesImported: number;
  imagesQueued: number;
  linksResolved: number;
  cancelled: boolean;
  notebookId: string;
  warnings: string[];
}

export interface ImportProgress {
  importId: string;
  fileIndex: number;
  fileCount: number;
  fileName: string;
  phase:
    'preparing' | 'notebookReady' | 'reading' | 'processing' | 'noteImported' | 'finalizing' | 'complete';
  notebookId: string;
  noteIndex: number;
  noteTitle: string | null;
  notesImported: number;
  notesSkipped: number;
  notesFailed: number;
  resourcesImported: number;
  bytesRead: number;
  totalBytes: number;
}

/** A file chosen for import. The token stands for it; its path stays native. */
export interface PickedFile {
  token: string;
  name: string;
  size: number;
  notebookName: string;
}

export interface ImportRequest {
  token: string;
  notebookName: string;
}

export interface ImportOutcome {
  fileName: string;
  notebookName: string;
  report: ImportReport | null;
  error: string | null;
  /** Set when the notes came from the Evernote application's own files. */
  notebooks?: number;
}

/** A notebook the Evernote application keeps on this computer. */
export interface EvernoteNotebook {
  id: string;
  name: string;
  stack: string | null;
  notes: number;
  attachments: number;
  bytes: number;
  /** Notes of which Evernote does not have everything on this computer. */
  notesNotDownloaded: number;
  /** Those notes, to name them. */
  incomplete: EvernoteIncompleteNote[];
}

/** A note of which Evernote does not have everything on this computer. */
export interface EvernoteIncompleteNote {
  title: string;
  /** Without its text a note cannot be imported at all. */
  textMissing: boolean;
  attachments: number;
  attachmentsMissing: number;
}

/** An account the Evernote application keeps on this computer. */
export interface EvernoteAccount {
  userId: string;
  notebooks: EvernoteNotebook[];
}

export interface EvernoteImportReport {
  notebooks: number;
  notesImported: number;
  notesUpdated: number;
  notesKeptBoth: number;
  notesSkipped: number;
  notesFailed: number;
  /** Notes imported without attachments Evernote does not have on this computer. */
  notesIncomplete: number;
  /** Tags placed under the tags they are under in Evernote. */
  tagsNested: number;
  resourcesImported: number;
  bytesImported: number;
  imagesQueued: number;
  linksResolved: number;
  cancelled: boolean;
  warnings: string[];
}

export type ExportScope =
  { kind: 'notes'; noteIds: string[] } | { kind: 'notebook'; notebookId: string } | { kind: 'all' };

export type NoteOrganizationAction = 'move' | 'copy' | 'addTags' | 'removeTags';

export interface Settings {
  ocrEnabled: boolean;
  loadRemoteImages: boolean;
}

export type SettingKey = 'ocr_enabled' | 'load_remote_images';

export interface AppInfo {
  version: string;
  platform: string;
}

export interface OcrStatus {
  enabled: boolean;
  pending: number;
  running: boolean;
}

export interface PCloudStatus {
  connected: boolean;
  email: string | null;
  hostname: string;
  lastSyncAt: number | null;
  authorizationPending: boolean;
}

export interface SyncProgress {
  phase: string;
  message: string;
  current: number;
  total: number;
  elapsedMs: number;
  networkMs: number;
  remoteRequests: number;
  bytesUploaded: number;
  bytesDownloaded: number;
}

export interface SyncStatus {
  revision: number;
  runId: number;
  running: boolean;
  progress: SyncProgress;
  lastReport: SyncReport | null;
  error: string | null;
}

export interface SyncReport {
  pushed: number;
  pulled: number;
  conflicts: number;
  blobsUploaded: number;
  blobsDownloaded: number;
  syncedAt: number;
  durationMs: number;
  networkMs: number;
  remoteRequests: number;
  bytesUploaded: number;
  bytesDownloaded: number;
  warnings: string[];
}
