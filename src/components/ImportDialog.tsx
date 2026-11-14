import { AlertTriangle, Check, FileInput, HardDrive, X } from 'lucide-react';
import { useId } from 'react';

import { importPercent } from '../lib/importProgress';
import { formatBytes } from '../lib/syncProgress';
import { useImportStore } from '../store/useImportStore';
import { useLibraryStore } from '../store/useLibraryStore';
import type { EvernoteNotebook, ImportOutcome, ImportProgress } from '../types';

const plural = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;

/** Up to this many notes Evernote does not have whole are listed without being asked for. */
const INCOMPLETE_OPEN = 6;
/** No more than this many are listed at all; the rest are counted. */
const INCOMPLETE_SHOWN = 200;

/** Chooses notebooks for the picked exports, shows progress, then a summary. */
export function ImportDialog() {
  const {
    phase,
    open,
    files,
    names,
    progress,
    outcomes,
    cancelling,
    error,
    accounts,
    account,
    selected,
    withoutMissing,
  } = useImportStore();
  const chooseFiles = useImportStore((state) => state.chooseFiles);
  const chooseEvernote = useImportStore((state) => state.chooseEvernote);
  const setAccount = useImportStore((state) => state.setAccount);
  const setSelected = useImportStore((state) => state.setSelected);
  const setWithoutMissing = useImportStore((state) => state.setWithoutMissing);
  const startEvernote = useImportStore((state) => state.startEvernote);
  const setName = useImportStore((state) => state.setName);
  const start = useImportStore((state) => state.start);
  const cancel = useImportStore((state) => state.cancel);
  const hide = useImportStore((state) => state.hide);
  const dismiss = useImportStore((state) => state.dismiss);
  const notebooks = useLibraryStore((state) => state.overview.notebooks);
  const ocrEnabled = useLibraryStore((state) => state.settings.ocrEnabled);
  const notebookListId = useId();
  if (!open || phase === 'idle') return null;

  const close = phase === 'running' ? hide : dismiss;
  const title =
    phase === 'running'
      ? 'Importing…'
      : phase === 'done'
        ? 'Import finished'
        : phase === 'evernote'
          ? 'Import from Evernote on this computer'
          : phase === 'review'
            ? 'Import ENEX files'
            : 'Import notes';
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const missingName = files.some((file) => !names[file.token]?.trim());

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <section
        className="modal import-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            close();
          }
        }}
      >
        <header>
          <div>
            <p className="eyebrow">
              {phase === 'evernote' ? 'Evernote' : phase === 'review' ? 'ENEX' : 'Import'}
            </p>
            <h2>{title}</h2>
          </div>
          <button
            className="icon-button"
            onClick={close}
            aria-label={phase === 'running' ? 'Continue in the background' : 'Close'}
          >
            <X />
          </button>
        </header>

        {phase === 'source' && (
          <div className="import-sources">
            <p className="dialog-message">Where are the notes to come from? Both give the same notes.</p>
            <button type="button" autoFocus onClick={() => void chooseEvernote()}>
              <HardDrive />
              <span>
                <strong>Evernote on this computer</strong>
                <small>
                  All notebooks at once, with their stacks, straight from the Evernote application’s own
                  files. Nothing is exported, and nothing is sent anywhere.
                </small>
              </span>
            </button>
            <button type="button" onClick={() => void chooseFiles()}>
              <FileInput />
              <span>
                <strong>ENEX files…</strong>
                <small>Files exported from Evernote, one for each notebook.</small>
              </span>
            </button>
            <p className="import-independent">
              Bever is an independent project and is not affiliated with Evernote.
            </p>
          </div>
        )}

        {phase === 'evernote' && (
          <EvernoteNotebooks
            accounts={accounts}
            account={account}
            selected={selected}
            withoutMissing={withoutMissing}
            error={error}
            ocrEnabled={ocrEnabled}
            onAccount={setAccount}
            onSelect={setSelected}
            onWithoutMissing={setWithoutMissing}
            onStart={() => void startEvernote()}
            onFiles={() => void chooseFiles()}
            onCancel={dismiss}
          />
        )}

        {phase === 'review' && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <p className="dialog-message">
              Each file becomes a notebook. A notebook that already has that name receives the notes.
              Importing again is safe: notes imported before are skipped, and a note that has changed in
              Evernote since is brought up to date, unless you changed it here too, in which case both are
              kept.
            </p>
            <ul className="import-files">
              {files.map((file, index) => (
                <li key={file.token}>
                  <span className="import-file-name" title={file.name}>
                    <FileInput />
                    {file.name}
                    {file.size > 0 && <small>{formatBytes(file.size)}</small>}
                  </span>
                  <label>
                    Notebook
                    <input
                      autoFocus={index === 0}
                      list={notebookListId}
                      value={names[file.token] ?? ''}
                      maxLength={255}
                      onChange={(event) => setName(file.token, event.target.value)}
                    />
                  </label>
                </li>
              ))}
            </ul>
            <datalist id={notebookListId}>
              {notebooks.map((notebook) => (
                <option key={notebook.id} value={notebook.name} />
              ))}
            </datalist>
            <p className="settings-pending">
              {plural(files.length, 'file')}
              {totalSize > 0 ? `, ${formatBytes(totalSize)}` : ''}.{' '}
              {ocrEnabled
                ? 'Text in images is recognised in the background after the import.'
                : 'Image text recognition is switched off in Settings.'}
            </p>
            <div className="dialog-actions">
              <button type="button" className="secondary-action" onClick={dismiss}>
                Cancel
              </button>
              <button type="submit" className="primary-action" disabled={missingName}>
                Import {plural(files.length, 'file')}
              </button>
            </div>
          </form>
        )}

        {phase === 'running' && (
          <div className="import-running" aria-live="polite">
            <ImportProgressView progress={progress} />
            <p className="settings-pending">
              You can keep using Bever; imported notes appear as they arrive.
            </p>
            <div className="dialog-actions">
              <button type="button" className="secondary-action" onClick={hide}>
                Continue in the background
              </button>
              <button
                type="button"
                className="primary-action danger-action"
                disabled={cancelling}
                onClick={() => void cancel()}
              >
                {cancelling ? 'Stopping after this note…' : 'Stop import'}
              </button>
            </div>
          </div>
        )}

        {phase === 'done' && (
          <div className="import-summary">
            {error && (
              <p className="dialog-error" role="alert">
                {error}
              </p>
            )}
            <ul className="import-outcomes">
              {outcomes.map((outcome) => (
                <OutcomeRow key={`${outcome.fileName}-${outcome.notebookName}`} outcome={outcome} />
              ))}
            </ul>
            <div className="dialog-actions">
              <button type="button" className="primary-action" autoFocus onClick={dismiss}>
                Done
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/** Progress of a running import; also used, compactly, in the sidebar. */
export function ImportProgressView({ progress }: { progress: ImportProgress | null }) {
  const percent = importPercent(progress);
  const detail = !progress
    ? 'Starting…'
    : progress.phase === 'finalizing' || progress.phase === 'complete'
      ? 'Connecting links between notes…'
      : (progress.noteTitle ?? (progress.noteIndex ? `Reading note ${progress.noteIndex}…` : 'Preparing…'));
  return (
    <div className="import-progress">
      <div>
        <strong title={progress?.fileName}>
          {progress && progress.fileCount > 1
            ? `File ${progress.fileIndex + 1} of ${progress.fileCount}: ${progress.fileName}`
            : (progress?.fileName ?? 'Import')}
        </strong>
        <span>{percent}%</span>
      </div>
      <progress aria-label="Import progress" max={100} value={percent} />
      <p title={detail}>{detail}</p>
      {progress && (
        <small>
          {plural(progress.notesImported, 'note')} imported
          {progress.notesSkipped > 0 && ` · ${progress.notesSkipped.toLocaleString()} already present`}
          {progress.notesFailed > 0 && ` · ${progress.notesFailed.toLocaleString()} unreadable`}
          {' · '}
          {plural(progress.resourcesImported, 'attachment')}
        </small>
      )}
    </div>
  );
}

/** The notebooks the Evernote application has, to choose which to import. */
function EvernoteNotebooks({
  accounts,
  account,
  selected,
  withoutMissing,
  error,
  ocrEnabled,
  onAccount,
  onSelect,
  onWithoutMissing,
  onStart,
  onFiles,
  onCancel,
}: {
  accounts: ReturnType<typeof useImportStore.getState>['accounts'];
  account: number;
  selected: string[];
  withoutMissing: boolean;
  error: string | null;
  ocrEnabled: boolean;
  onAccount: (index: number) => void;
  onSelect: (ids: string[]) => void;
  onWithoutMissing: (on: boolean) => void;
  onStart: () => void;
  onFiles: () => void;
  onCancel: () => void;
}) {
  if (accounts === null) {
    return (
      <div className="import-running" aria-live="polite">
        <p className="dialog-message">Looking at what Evernote keeps on this computer…</p>
      </div>
    );
  }
  const notebooks = accounts[account]?.notebooks ?? [];
  if (!notebooks.length) {
    return (
      <div className="import-summary">
        {error ? (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        ) : (
          <p className="dialog-message">
            No notes of the Evernote application were found on this computer. Install Evernote, sign in, and
            let it finish synchronizing; then try again. Files exported from Evernote can be imported without
            it.
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary-action" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary-action" onClick={onFiles}>
            Import ENEX files…
          </button>
        </div>
      </div>
    );
  }
  const chosen = notebooks.filter((notebook) => selected.includes(notebook.id));
  const sum = (pick: (notebook: EvernoteNotebook) => number) =>
    chosen.reduce((total, notebook) => total + pick(notebook), 0);
  const notes = sum((notebook) => notebook.notes);
  const missing = sum((notebook) => notebook.notesNotDownloaded);
  // The notes Evernote does not have whole, each with its notebook's name.
  const incomplete = chosen.flatMap((notebook) =>
    notebook.incomplete.map((note) => ({ ...note, notebook: notebook.name || 'Untitled notebook' })),
  );
  // Without its text a note cannot be imported; without attachments it can.
  const importable = incomplete.filter((note) => !note.textMissing).length;
  // Notebooks without a stack first, then each stack, as Evernote lists them.
  const stacks = [...new Set(notebooks.map((notebook) => notebook.stack))].sort((a, b) =>
    a === null ? -1 : b === null ? 1 : a.localeCompare(b),
  );
  const toggle = (ids: string[], on: boolean) =>
    onSelect(on ? [...new Set([...selected, ...ids])] : selected.filter((id) => !ids.includes(id)));
  return (
    <form
      className="import-evernote"
      onSubmit={(event) => {
        event.preventDefault();
        onStart();
      }}
    >
      <p className="dialog-message">
        Bever reads the notes that Evernote keeps on this computer; Evernote’s files are not changed. Each
        notebook becomes a notebook of the same name, in its stack, and tags are nested as they are in
        Evernote. The notes are what exporting them would give, with the text Evernote recognised in pictures
        besides. Importing again is safe: notes imported before are skipped, and a note that has changed in
        Evernote since is brought up to date, unless you changed it here too, in which case both are kept.
      </p>
      {accounts.length > 1 && (
        <label className="import-account">
          Account
          <select value={account} onChange={(event) => onAccount(Number(event.target.value))}>
            {accounts.map((item, index) => (
              <option key={item.userId} value={index}>
                User {item.userId} ({plural(item.notebooks.length, 'notebook')})
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="import-notebooks" role="group" aria-label="Notebooks to import">
        <label className="import-all">
          <input
            type="checkbox"
            checked={chosen.length === notebooks.length}
            ref={(input) => {
              if (input) input.indeterminate = chosen.length > 0 && chosen.length < notebooks.length;
            }}
            onChange={(event) =>
              toggle(
                notebooks.map((notebook) => notebook.id),
                event.target.checked,
              )
            }
          />
          All notebooks
        </label>
        {stacks.map((stack) => {
          const inStack = notebooks.filter((notebook) => notebook.stack === stack);
          const ids = inStack.map((notebook) => notebook.id);
          const count = ids.filter((id) => selected.includes(id)).length;
          return (
            <fieldset key={stack ?? ''}>
              {stack !== null && (
                <legend>
                  <label>
                    <input
                      type="checkbox"
                      checked={count === ids.length}
                      ref={(input) => {
                        if (input) input.indeterminate = count > 0 && count < ids.length;
                      }}
                      onChange={(event) => toggle(ids, event.target.checked)}
                    />
                    {stack}
                  </label>
                </legend>
              )}
              {inStack.map((notebook) => (
                <label key={notebook.id} title={notebook.name}>
                  <input
                    type="checkbox"
                    checked={selected.includes(notebook.id)}
                    onChange={(event) => toggle([notebook.id], event.target.checked)}
                  />
                  <span>{notebook.name || 'Untitled notebook'}</span>
                  <small>
                    {plural(notebook.notes, 'note')}
                    {notebook.bytes > 0 && ` · ${formatBytes(notebook.bytes)}`}
                    {notebook.notesNotDownloaded > 0 && (
                      <em> · {notebook.notesNotDownloaded.toLocaleString()} not downloaded</em>
                    )}
                  </small>
                </label>
              ))}
            </fieldset>
          );
        })}
      </div>
      <p className="settings-pending">
        {plural(chosen.length, 'notebook')}, {plural(notes, 'note')}
        {sum((notebook) => notebook.bytes) > 0
          ? `, ${formatBytes(sum((notebook) => notebook.bytes))}`
          : ''}.{' '}
        {ocrEnabled
          ? 'Pictures Evernote has not read are read in the background after the import.'
          : 'Image text recognition is switched off in Settings.'}
      </p>
      {missing > 0 && (
        <div className="import-caution">
          <AlertTriangle />
          <div>
            <p>
              {plural(missing, 'note')} cannot be imported whole: Evernote does not have{' '}
              {missing === 1 ? 'all of it' : 'all of them'} on this computer. Open{' '}
              {missing === 1 ? 'it' : 'each of them'} in Evernote while online, so that Evernote fetches what
              is missing, then import again. Letting Evernote synchronize longer may not help: a file it was
              once refused is not asked for again until the note is opened. The rest is imported now.
            </p>
            <details open={incomplete.length <= INCOMPLETE_OPEN}>
              <summary>{missing === 1 ? 'Which note' : `Which ${missing.toLocaleString()} notes`}</summary>
              <ul aria-label="Notes Evernote does not have whole">
                {incomplete.slice(0, INCOMPLETE_SHOWN).map((note, index) => (
                  <li key={index}>
                    <strong>{note.title || 'Untitled'}</strong> in {note.notebook}
                    <small>
                      {note.textMissing
                        ? 'text missing'
                        : `${note.attachmentsMissing.toLocaleString()} of ${plural(note.attachments, 'attachment')} missing`}
                    </small>
                  </li>
                ))}
                {incomplete.length > INCOMPLETE_SHOWN && (
                  <li>and {(incomplete.length - INCOMPLETE_SHOWN).toLocaleString()} more</li>
                )}
              </ul>
            </details>
            {importable > 0 && (
              <label>
                <input
                  type="checkbox"
                  checked={withoutMissing}
                  onChange={(event) => onWithoutMissing(event.target.checked)}
                />
                <span>
                  Import {importable === 1 ? 'this note' : `these ${importable.toLocaleString()} notes`} now,
                  without the attachments that are missing
                  <small>
                    {importable < incomplete.length
                      ? `${plural(incomplete.length - importable, 'note')} without text cannot be imported. `
                      : ''}
                    Importing again once Evernote has the attachments completes{' '}
                    {importable === 1 ? 'the note' : 'the notes'}.
                  </small>
                </span>
              </label>
            )}
          </div>
        </div>
      )}
      <div className="dialog-actions">
        <button type="button" className="secondary-action" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary-action" disabled={!chosen.length || notes === 0}>
          Import {plural(chosen.length, 'notebook')}
        </button>
      </div>
    </form>
  );
}

function OutcomeRow({ outcome }: { outcome: ImportOutcome }) {
  const report = outcome.report;
  if (!report) {
    return (
      <li className="failed">
        <AlertTriangle />
        <div>
          <strong>{outcome.fileName}</strong>
          <p>Could not be imported: {outcome.error}</p>
        </div>
      </li>
    );
  }
  const facts = [
    outcome.notebooks === undefined
      ? `${plural(report.notesImported, 'note')} and ${plural(report.resourcesImported, 'attachment')} imported into “${outcome.notebookName}”`
      : `${plural(report.notesImported, 'note')} and ${plural(report.resourcesImported, 'attachment')} imported from ${plural(outcome.notebooks, 'notebook')}`,
    report.notesUpdated > 0
      ? `${plural(report.notesUpdated, 'note')} that changed in Evernote brought up to date`
      : null,
    report.notesKeptBoth > 0
      ? `${plural(report.notesKeptBoth, 'note')} changed both here and in Evernote, so Evernote’s version was added beside yours`
      : null,
    report.notesSkipped > 0
      ? `${plural(report.notesSkipped, 'note')} already present and left unchanged`
      : null,
    report.notesIncomplete
      ? `${plural(report.notesIncomplete, 'note')} imported without attachments Evernote does not have`
      : null,
    report.linksResolved > 0 ? `${plural(report.linksResolved, 'link')} between notes connected` : null,
    report.tagsNested ? `${plural(report.tagsNested, 'tag')} nested as in Evernote` : null,
    report.shortcutsAdded ? `${plural(report.shortcutsAdded, 'shortcut')} added as in Evernote` : null,
    report.imagesQueued > 0 ? `${plural(report.imagesQueued, 'image')} queued for text recognition` : null,
    report.cancelled
      ? outcome.notebooks === undefined
        ? 'stopped before the end of the file'
        : 'stopped before the end'
      : null,
  ].filter(Boolean);
  return (
    <li className={report.notesFailed > 0 || report.notesIncomplete || report.cancelled ? 'partial' : ''}>
      {report.notesFailed > 0 || report.notesIncomplete || report.cancelled ? <AlertTriangle /> : <Check />}
      <div>
        <strong>{outcome.fileName}</strong>
        <p>{facts.join('; ')}.</p>
        {outcome.notebooks !== undefined &&
          report.warnings.map((warning, index) => (
            <p key={index} className="import-warning">
              {warning}
            </p>
          ))}
        {outcome.notebooks === undefined && report.warnings.length > 0 && (
          <details>
            <summary>{plural(report.warnings.length, 'note')} could not be imported</summary>
            <ul>
              {report.warnings.slice(0, 200).map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </li>
  );
}
