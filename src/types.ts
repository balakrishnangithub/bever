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

/** A search is a shortcut by its words: they are what it points to. */
export type ShortcutTarget = 'note' | 'notebook' | 'stack' | 'tag' | 'search';

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
  /** Whether the note is pinned to the top of the notebook it is in. */
  pinned: boolean;
}

/**
 * What is said about a note without being part of it is kept under its
 * `application-data`: which picture stands for it in a list, and that it is
 * pinned to its notebook. Setting either is not an edit of the note.
 */
export const THUMBNAIL_KEY = 'bever.thumbnail';
export const PINNED_KEY = 'bever.pinned';
const NO_THUMBNAIL = 'none';
const AUTOMATIC_THUMBNAIL = 'auto';

/** Which picture stands for a note in a list. */
export type ThumbnailChoice = { kind: 'automatic' } | { kind: 'none' } | { kind: 'picture'; md5: string };

function mark(attributes: Attributes, key: string): string | null {
  const data = attributes['application-data'];
  const value = data && typeof data === 'object' && !Array.isArray(data) ? data[key] : null;
  return typeof value === 'string' && value ? value : null;
}

/**
 * The choice made for a note. What was chosen here comes first; then what
 * an export of Evernote says in the note's `thumbnail`, which is empty
 * where the thumbnail was removed there.
 */
export function thumbnailChoice(attributes: Attributes): ThumbnailChoice {
  const chosen = mark(attributes, THUMBNAIL_KEY);
  const exported = attributes.thumbnail;
  const said = chosen ?? (typeof exported === 'string' ? exported || NO_THUMBNAIL : null);
  if (said === null || said === AUTOMATIC_THUMBNAIL) return { kind: 'automatic' };
  return said === NO_THUMBNAIL ? { kind: 'none' } : { kind: 'picture', md5: said };
}

/** The MD5 of the picture chosen to stand for a note, if one was chosen. */
export function chosenThumbnail(attributes: Attributes): string | null {
  const choice = thumbnailChoice(attributes);
  return choice.kind === 'picture' ? choice.md5 : null;
}

/** Whether a note is pinned to the notebook it is in. */
export function isPinned(note: Pick<Note, 'attributes' | 'notebookId'>): boolean {
  return mark(note.attributes, PINNED_KEY)?.startsWith(`${note.notebookId} `) ?? false;
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

/**
 * A note as it was before it was changed in the editor, kept on this device
 * so that the change can be taken back.
 */
export interface NoteVersion {
  id: number;
  /** When this form was put aside. */
  keptAt: number;
  /** The date the note itself had then. */
  updatedAt: number;
  title: string;
  /** How its text begins. */
  preview: string;
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
  /** Only from the Evernote application: shortcuts it has that were added here. */
  shortcutsAdded?: number;
  /** Only from the Evernote application: shortcuts it has that lead to nothing that is here. */
  shortcutsNowhere?: number;
  /** Evernote's tasks that came as items of checklists, and the notes they are in. */
  tasksBrought?: number;
  notesWithTasks?: number;
  /** Only from the Evernote application: notes that lie in its trash and were not imported. */
  notesInTrash?: number;
  /** Only from the Evernote application: tags that no note has, added with the whole account. */
  tagsAdded?: number;
  /** Only from the Evernote application: notes given the thumbnail they have there, or none. */
  thumbnailsBrought?: number;
  /** Only from the Evernote application: notes pinned to their notebooks as they are there. */
  pinsBrought?: number;
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
  /** Shortcuts Evernote has that were added here. */
  shortcutsAdded: number;
  /** Shortcuts Evernote has that lead to nothing that is here. */
  shortcutsNowhere: number;
  /** Evernote's tasks that came as items of checklists, and the notes they are in. */
  tasksBrought: number;
  notesWithTasks: number;
  /** Notes that lie in Evernote's trash and were not imported. */
  notesInTrash: number;
  /** Tags that no note has, added with the whole account. */
  tagsAdded: number;
  /** Notes given the thumbnail they have in Evernote, or none where it was removed there. */
  thumbnailsBrought: number;
  /** Notes pinned to their notebooks as they are in Evernote. */
  pinsBrought: number;
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
  /** Requests that were made again because they did not complete. */
  retries: number;
}

export interface SyncStatus {
  revision: number;
  runId: number;
  running: boolean;
  /** The run was asked to stop and has not ended yet. */
  stopping: boolean;
  progress: SyncProgress;
  lastReport: SyncReport | null;
  error: string | null;
  /** The last run ended because it was asked to stop. */
  stopped: boolean;
}

/**
 * One run as the library remembers it. `running` while no run is going
 * means that it never got to say how it ended: Bever was closed, or the
 * device slept or went off, under it.
 */
export interface SyncRun {
  startedAt: number;
  /** When the run was last seen at work. */
  activeAt: number;
  endedAt: number | null;
  outcome: 'running' | 'complete' | 'stopped' | 'failed';
  /** Why the run failed. */
  message: string | null;
  pushed: number;
  pulled: number;
  blobsUploaded: number;
  blobsDownloaded: number;
  bytesUploaded: number;
  bytesDownloaded: number;
  /** Notes that were held back, each with its reason in the run's report. */
  heldBack: number;
  retries: number;
  /** Times the storage service said it was being asked too much. */
  throttled: number;
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
  /** Requests that were made again because they did not complete. */
  retries: number;
  /** Times the storage service said it was being asked too much. */
  throttled: number;
}
