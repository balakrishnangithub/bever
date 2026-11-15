import { listen } from '@tauri-apps/api/event';
import {
  Check,
  Cloud,
  CloudCheck,
  HardDrive,
  ImageOff,
  Lock,
  RefreshCw,
  ScanText,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { api, isAndroid, isNative } from '../lib/api';
import { dialogs } from '../lib/dialogs';
import { describeRetries, describeRun, formatBytes, formatDuration } from '../lib/syncProgress';
import { message, useLibraryStore } from '../store/useLibraryStore';
import { useSyncStore } from '../store/useSyncStore';
import type { PCloudStatus } from '../types';

export function SettingsDialog({
  theme,
  onTheme,
  onClose,
}: {
  theme: string;
  onTheme: (theme: string) => void;
  onClose: () => void;
}) {
  const {
    status: syncStatus,
    starting: syncStarting,
    receivedAt: progressReceivedAt,
    error: syncError,
    runs,
    start: startSync,
    stop: stopSync,
  } = useSyncStore();
  const settings = useLibraryStore((state) => state.settings);
  const setSetting = useLibraryStore((state) => state.setSetting);
  const ocr = useLibraryStore((state) => state.ocr);
  const openReadOnly = useLibraryStore((state) => state.openReadOnly);
  const setOpenReadOnly = useLibraryStore((state) => state.setOpenReadOnly);
  const appInfo = useLibraryStore((state) => state.appInfo);
  const [status, setStatus] = useState<PCloudStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [manualOpen, setManualOpen] = useState(false);
  const [eraseState, setEraseState] = useState<{ done: boolean; error: string | null } | null>(null);
  const [token, setToken] = useState('');
  const [hostname, setHostname] = useState('api.pcloud.com');
  const syncRunning = syncStarting || Boolean(syncStatus?.running);
  const syncStopping = Boolean(syncStatus?.stopping);
  const syncProgress = syncStatus?.progress ?? null;
  const report = syncStatus?.lastReport ?? null;
  // The record opens by itself when the latest run did not end well, and
  // otherwise when it is asked for.
  const [runsOpen, setRunsOpen] = useState<boolean | null>(null);
  const latestRun = runs[0] ? describeRun(runs[0], syncRunning) : null;
  // On desktop the command waits for the browser; on Android the app is
  // reopened by a link, so the waiting state comes from the stored status.
  const connecting = busy === 'connect' || Boolean(status?.authorizationPending);

  useEffect(() => {
    void useSyncStore.getState().refresh();
    void api
      .pcloudStatus()
      .then(setStatus)
      .catch((error: unknown) => setNotice({ text: message(error), error: true }));
  }, []);

  useEffect(() => {
    if (!isNative) return;
    let active = true;
    const subscriptions = [
      listen<PCloudStatus>('bever:pcloud-status', (event) => {
        if (!active) return;
        setStatus(event.payload);
        setToken('');
        setManualOpen(false);
        setNotice(null);
      }),
      listen<string>('bever:pcloud-error', (event) => {
        if (!active) return;
        setStatus((current) => current && { ...current, authorizationPending: false });
        setNotice({ text: message(event.payload), error: true });
      }),
    ];
    return () => {
      active = false;
      void Promise.all(subscriptions).then((unlisteners) => {
        unlisteners.forEach((unlisten) => unlisten());
      });
    };
  }, []);

  useEffect(() => {
    if (!syncRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [syncRunning]);

  const run = async (action: string, operation: () => Promise<PCloudStatus>) => {
    setBusy(action);
    setNotice(null);
    try {
      const result = await operation();
      setStatus(result);
      setToken('');
      setManualOpen(false);
      if (action === 'connect' && result.authorizationPending) {
        setNotice({
          text: 'Approve Bever in your browser. Android returns to the app automatically.',
          error: false,
        });
      }
    } catch (error) {
      const text = message(error);
      // Cancelling is the user's own doing, not a failure to report.
      if (!/cancelled/i.test(text)) setNotice({ text, error: true });
    } finally {
      setBusy(null);
    }
  };
  const cancelConnect = () => {
    void api
      .cancelPcloudConnect()
      .then(setStatus)
      .catch(() => undefined);
    setNotice(null);
  };

  // Everything Bever keeps on this device goes, so that an uninstall
  // leaves nothing behind. The word has to be typed: nothing brings it back.
  const erase = async () => {
    const typed = await dialogs.prompt({
      title: 'Remove all data from this device?',
      message: (
        <>
          <p>
            This removes every note, attachment, and setting that Bever keeps on this device, and forgets the
            pCloud login. It cannot be undone.
          </p>
          <p>
            Notes that were synchronized stay in pCloud. Notes that were not are lost: export them first if
            you want to keep them.
          </p>
          <p>Bever closes when it is done, and can then be uninstalled.</p>
        </>
      ),
      label: 'Type ERASE to confirm',
      confirmLabel: 'Remove everything',
      danger: true,
      emptyMessage: 'Type ERASE to confirm.',
      validate: (value) => (value === 'ERASE' ? null : 'Type ERASE, in capital letters, to confirm.'),
    });
    if (typed === null) return;
    setEraseState({ done: false, error: null });
    try {
      await api.eraseLocalData();
      setEraseState({ done: true, error: null });
    } catch (error) {
      setEraseState({ done: false, error: message(error) });
    }
  };

  const elapsedMs = syncProgress
    ? syncProgress.elapsedMs + (syncRunning ? Math.max(0, now - progressReceivedAt) : 0)
    : 0;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow">Preferences</p>
            <h2>Settings</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings">
            <X />
          </button>
        </header>
        <div className="settings-content">
          <section className="settings-card">
            <Cloud />
            <div className="sync-settings">
              <h3>Optional pCloud sync</h3>
              <p>
                Synchronize notes and attachments directly with your pCloud storage. HTTPS protects data in
                transit; Bever does not encrypt the remote copy.
              </p>
              {!status?.connected && (
                <span className="settings-pending">
                  {status === null
                    ? 'Checking pCloud connection…'
                    : connecting
                      ? 'Waiting for you to approve Bever in your browser…'
                      : 'Connect pCloud to enable sync.'}
                </span>
              )}
              <div className="settings-buttons sync-primary-actions">
                <button
                  className="primary-action"
                  disabled={!status?.connected || busy !== null || syncRunning}
                  title={status?.connected ? 'Synchronize with pCloud now' : 'Connect pCloud to enable sync'}
                  onClick={() => void startSync()}
                >
                  <RefreshCw className={syncRunning ? 'spin' : ''} />
                  {syncRunning ? 'Synchronizing…' : 'Sync now'}
                </button>
                {syncStatus?.running && (
                  <button
                    className="secondary-action"
                    disabled={syncStopping}
                    title="Stop this run. What it has transferred is kept, and the next run goes on from there."
                    onClick={() => void stopSync()}
                  >
                    {syncStopping ? 'Stopping…' : 'Stop'}
                  </button>
                )}
                {status?.connected && (
                  <button
                    className="secondary-action"
                    disabled={busy !== null || syncRunning}
                    onClick={() => void run('disconnect', api.disconnectPcloud)}
                  >
                    Disconnect
                  </button>
                )}
              </div>
              <span className="settings-pending">
                Sync runs when you start it, one run at a time, and keeps going if you close Settings. On
                Windows, closing the window keeps a running sync in the tray, and the computer is asked not to
                sleep meanwhile; on Android, a notification shows its progress. Stop ends a run, and so does
                Quit in the tray: what was transferred is kept, and the next run goes on from there.
              </span>
              {status?.connected ? (
                <>
                  <span className="setting-ok">
                    <CloudCheck />
                    Connected{status.email ? ` as ${status.email}` : ''} · {status.hostname}
                  </span>
                  {status.lastSyncAt && (
                    <span className="settings-pending">
                      Last synchronized {new Date(status.lastSyncAt).toLocaleString()}
                    </span>
                  )}
                </>
              ) : (
                <>
                  <div className="oauth-note">
                    <p>One-time pCloud app setup:</p>
                    <ol className="oauth-steps">
                      <li>
                        Set <strong>Allow implicit grant</strong> to <strong>Allow</strong>, then click{' '}
                        <strong>Save changes</strong>.
                      </li>
                      {!isAndroid && (
                        <li>
                          Keep the redirect URI exactly <code>http://127.0.0.1:53682/</code>.
                        </li>
                      )}
                      <li>
                        Connect below and approve in the browser. pCloud returns the token and region
                        automatically.
                      </li>
                    </ol>
                  </div>
                  <div className="settings-buttons">
                    {connecting ? (
                      <button className="secondary-action" onClick={cancelConnect}>
                        Cancel
                      </button>
                    ) : (
                      <button
                        className="primary-action"
                        disabled={!isNative || busy !== null}
                        onClick={() => void run('connect', api.connectPcloud)}
                      >
                        Connect with browser
                      </button>
                    )}
                    <button
                      className="secondary-action"
                      disabled={!isNative || busy !== null}
                      onClick={() => setManualOpen((value) => !value)}
                    >
                      Use access token
                    </button>
                  </div>
                  {manualOpen && (
                    <form
                      className="token-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void run('token', () => api.connectPcloudToken(token, hostname));
                      }}
                    >
                      <label>
                        pCloud region
                        <select value={hostname} onChange={(event) => setHostname(event.target.value)}>
                          <option value="api.pcloud.com">Global (api.pcloud.com)</option>
                          <option value="eapi.pcloud.com">Europe (eapi.pcloud.com)</option>
                        </select>
                      </label>
                      <p className="settings-pending">
                        Fallback for a token pCloud already issued to you. Bever does not create tokens;
                        browser connection is the recommended way to obtain one securely.
                      </p>
                      <label>
                        Access token
                        <input
                          required
                          type="password"
                          autoComplete="off"
                          value={token}
                          onChange={(event) => setToken(event.target.value)}
                          placeholder="Token is stored in your system credential vault"
                        />
                      </label>
                      <button
                        className="primary-action"
                        type="submit"
                        disabled={!token.trim() || busy !== null}
                      >
                        {busy === 'token' ? 'Connecting…' : 'Connect token'}
                      </button>
                    </form>
                  )}
                </>
              )}
              {!isNative && (
                <span className="settings-pending">pCloud connection is available in the native app.</span>
              )}
              {syncRunning && (
                <div className="sync-progress" role="status" aria-live="polite">
                  <strong>{syncProgress?.message ?? 'Preparing synchronization…'}</strong>
                  {syncProgress && (
                    <>
                      {syncProgress.total > 0 && (
                        <progress
                          aria-label="Current sync operation"
                          max={syncProgress.total}
                          value={Math.min(syncProgress.current, syncProgress.total)}
                        />
                      )}
                      <div className="sync-progress-timing">
                        <span>Elapsed {formatDuration(elapsedMs)}</span>
                        <span>
                          ↓ {formatBytes(syncProgress.bytesDownloaded)} · ↑{' '}
                          {formatBytes(syncProgress.bytesUploaded)}
                        </span>
                        {syncProgress.retries > 0 && (
                          <span title="Requests that did not complete and were made again">
                            {describeRetries(syncProgress.retries, 0)}
                          </span>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
              {(syncError ?? syncStatus?.error) && (
                <div className="sync-message error" role="alert">
                  <strong>
                    {syncError
                      ? 'Synchronization could not start'
                      : `Synchronization failed after ${formatDuration(syncProgress?.elapsedMs ?? 0)}`}
                  </strong>
                  <p>{message(syncError ?? syncStatus?.error)}</p>
                  {!syncError && (
                    <p>
                      What was transferred until then is kept (↑{' '}
                      {formatBytes(syncProgress?.bytesUploaded ?? 0)}, ↓{' '}
                      {formatBytes(syncProgress?.bytesDownloaded ?? 0)}); the next run goes on from there.
                    </p>
                  )}
                </div>
              )}
              {syncStatus?.stopped && !syncRunning && (
                <p className="sync-message" role="status">
                  Synchronization stopped after {formatDuration(syncProgress?.elapsedMs ?? 0)}. What was
                  transferred is kept, and the next run goes on from there.
                </p>
              )}
              {notice && (
                <p
                  className={`sync-message ${notice.error ? 'error' : ''}`}
                  role={notice.error ? 'alert' : 'status'}
                >
                  {notice.text}
                </p>
              )}
              {report && (
                <div className="sync-message success" role="status">
                  <strong>Sync complete in {formatDuration(report.durationMs)}</strong>
                  <p>
                    {report.pushed} notes uploaded, {report.pulled} downloaded, {report.conflicts} conflict
                    copies, {report.blobsUploaded + report.blobsDownloaded} attachments transferred.
                  </p>
                  <span className="settings-pending">
                    {report.remoteRequests} requests · ↓ {formatBytes(report.bytesDownloaded)} · ↑{' '}
                    {formatBytes(report.bytesUploaded)}
                    {report.retries > 0 && ` · ${describeRetries(report.retries, report.throttled)}`}
                  </span>
                  {report.warnings.length > 0 && (
                    <details className="sync-warnings" open>
                      <summary>
                        {report.warnings.length} {report.warnings.length === 1 ? 'note was' : 'notes were'}{' '}
                        not uploaded
                      </summary>
                      <ul>
                        {report.warnings.map((warning, index) => (
                          <li key={index}>{warning}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
              {latestRun && (
                <details
                  className="sync-runs"
                  open={runsOpen ?? latestRun.trouble}
                  onToggle={(event) => setRunsOpen(event.currentTarget.open)}
                >
                  <summary>Recent runs</summary>
                  <ol>
                    {runs.slice(0, 10).map((run, index) => {
                      const told = index === 0 ? latestRun : describeRun(run, false);
                      return (
                        <li key={run.startedAt} className={told.trouble ? 'trouble' : undefined}>
                          <strong>{new Date(run.startedAt).toLocaleString()}</strong>
                          <span>
                            {told.headline}
                            {told.reason && `: ${message(told.reason)}`}
                          </span>
                          <span className="settings-pending">{told.moved}</span>
                        </li>
                      );
                    })}
                  </ol>
                </details>
              )}
            </div>
          </section>
          <section className="settings-card">
            <HardDrive />
            <div>
              <h3>Local-first library</h3>
              <p>
                Your notes, search index, and attachments stay on this device. Bever has no server-side
                compute.
              </p>
              <span className="setting-ok">
                <Check />
                Offline and ready
              </span>
            </div>
          </section>
          <section className="settings-card">
            <ScanText />
            <div>
              <h3>Offline image text recognition</h3>
              <p>
                Makes text in PNG, JPEG, and WebP images searchable. It runs on this device, in the
                background, after notes are imported or images are added. Best for printed Latin-alphabet
                text; images are never changed.
              </p>
              <label className="ocr-setting">
                <input
                  type="checkbox"
                  checked={settings.ocrEnabled}
                  disabled={!isNative}
                  onChange={(event) => void setSetting('ocr_enabled', event.target.checked)}
                />
                Recognise image text on this device
              </label>
              {!isNative && <span className="settings-pending">Available in the native app.</span>}
              {isNative && ocr && ocr.pending > 0 && (
                <span className="settings-pending" role="status">
                  {settings.ocrEnabled
                    ? `${ocr.pending.toLocaleString()} images left to read.`
                    : `Paused. ${ocr.pending.toLocaleString()} images are waiting.`}
                </span>
              )}
            </div>
          </section>
          <section className="settings-card">
            <ImageOff />
            <div>
              <h3>Images from the web</h3>
              <p>
                Some clipped notes point to images on other websites. Loading one tells that website when you
                opened the note, so they stay hidden until you click them.
              </p>
              <label className="ocr-setting">
                <input
                  type="checkbox"
                  checked={settings.loadRemoteImages}
                  onChange={(event) => void setSetting('load_remote_images', event.target.checked)}
                />
                Always load images from the web
              </label>
            </div>
          </section>
          <section className="settings-card">
            <Lock />
            <div>
              <h3>Changes made by mistake</h3>
              <p>
                Notes save by themselves. Before a note is changed, Bever keeps it as it was: “Discard
                changes” in the note puts it back, and the last five such versions are listed under Note
                information. They stay on this device.
              </p>
              <label className="ocr-setting">
                <input
                  type="checkbox"
                  checked={openReadOnly}
                  onChange={(event) => setOpenReadOnly(event.target.checked)}
                />
                Open notes read-only; the padlock in a note unlocks it
              </label>
            </div>
          </section>
          <section className="settings-card">
            <ShieldCheck />
            <div>
              <h3>Your data remains portable</h3>
              <p>
                Import and export standard Evernote ENEX files. Original ENML and attachment metadata are
                preserved.
              </p>
            </div>
          </section>
          <section className="settings-card">
            <Trash2 />
            <div>
              <h3>Remove Bever’s data from this device</h3>
              {isAndroid ? (
                <p>
                  Uninstalling Bever removes its notes, attachments, settings, and pCloud login from this
                  device. Nothing changes in pCloud.
                </p>
              ) : (
                <>
                  <p>
                    For a clean uninstall. An uninstaller removes the program and can leave your notes and the
                    pCloud login behind. This removes them from this device; nothing changes in pCloud.
                  </p>
                  <div className="settings-buttons">
                    <button
                      className="secondary-action danger"
                      disabled={syncRunning || busy !== null || (eraseState !== null && !eraseState.error)}
                      title={
                        syncRunning
                          ? 'Stop the synchronization first, or wait until it has finished'
                          : undefined
                      }
                      onClick={() => void erase()}
                    >
                      Remove all data from this device…
                    </button>
                  </div>
                  {eraseState && !eraseState.error && (
                    <p className="sync-message" role="status">
                      {eraseState.done ? 'Removed. Bever is closing.' : 'Removing…'}
                    </p>
                  )}
                  {eraseState?.error && (
                    <p className="sync-message error" role="alert">
                      {eraseState.error}
                    </p>
                  )}
                </>
              )}
            </div>
          </section>
          <label className="theme-setting">
            Appearance
            <select value={theme} onChange={(event) => onTheme(event.target.value)}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          {appInfo && (
            <p className="settings-version">
              Bever {appInfo.version} · free and open source under GPL-3.0-or-later
              <br />
              An independent project, not affiliated with Evernote or pCloud, whose names are their owners’
              trademarks.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
