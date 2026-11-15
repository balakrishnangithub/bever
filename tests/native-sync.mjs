// Drives synchronization in the real Windows application, against a
// stand-in for pCloud that this test runs on the same computer.
//
//   npm run tauri -- build --no-bundle
//   cargo build --release -p bever-core --example import_enex
//   node tests/native-sync.mjs
//
// The application is started with its own temporary library
// (BEVER_DATA_DIR) and is told where the stand-in listens
// (BEVER_PCLOUD_STAND_IN). It then reads no sign-in, saves none, and sends
// nothing anywhere but to 127.0.0.1; pCloud itself is never reached, and
// neither are the installed application, its library or its sign-in, which
// is checked at the end.
//
// What is looked at is what a person has to be able to rely on when a run
// takes hours: that it can be stopped at once, that one file that cannot be
// read does not end it, that quitting quits, and that what happened to a run
// can be read afterwards.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const executable = join(root, 'target/release/bever.exe');
const importer = join(root, 'target/release/examples/import_enex.exe');
const port = 9334;
const NOTES = 120;
const ATTACHMENT_BYTES = 200_000;
// The first notes have attachments large enough to be on their way, and not
// yet out of the application's hands, when the run is stopped.
const LARGE = 8;
const LARGE_BYTES = 8_000_000;

for (const needed of [executable, importer]) {
  if (!existsSync(needed)) throw new Error(`Build first: ${needed} does not exist.`);
}

const work = mkdtempSync(join(tmpdir(), 'bever-sync-'));
const dataDirectory = join(work, 'library');
const profile = join(work, 'webview');
const evernote = join(work, 'Evernote');
mkdirSync(evernote);
const userLibrary = join(process.env.APPDATA ?? '', 'io.github.balakrishnangithub.bever', 'bever.db');
const userLibraryBefore = existsSync(userLibrary) ? statSync(userLibrary).mtimeMs : null;
const savedLogins = () =>
  execFileSync('cmdkey', ['/list'], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => /bever/i.test(line)).length;
const savedLoginsBefore = savedLogins();
const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

// --- A library to synchronize: notes with an attachment each ----------------
const number = (index) => String(index).padStart(3, '0');
const attachments = [];
{
  const notes = [];
  for (let index = 1; index <= NOTES; index += 1) {
    const bytes = randomBytes(index <= LARGE ? LARGE_BYTES : ATTACHMENT_BYTES);
    attachments.push(createHash('sha256').update(bytes).digest('hex'));
    const md5 = createHash('md5').update(bytes).digest('hex');
    const enml =
      '<?xml version="1.0" encoding="UTF-8" standalone="no"?>' +
      '<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">' +
      `<en-note><div>Body of note ${index}</div><en-media hash="${md5}" type="application/octet-stream"/></en-note>`;
    notes.push(
      `<note><title>! Sync note ${number(index)}</title><created>20260101T000000Z</created>` +
        `<updated>20260101T000000Z</updated><content><![CDATA[${enml}]]></content>` +
        `<resource><data encoding="base64">${bytes.toString('base64')}</data><mime>application/octet-stream</mime>` +
        `<resource-attributes><file-name>file-${number(index)}.bin</file-name></resource-attributes></resource></note>`,
    );
  }
  const exportFile = join(work, 'Sync notes.enex');
  writeFileSync(
    exportFile,
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">\n' +
      `<en-export export-date="20260101T000000Z" application="Evernote" version="10.0">${notes.join('')}</en-export>`,
  );
  const summary = execFileSync(importer, [exportFile, dataDirectory], { encoding: 'utf8' });
  const match = /Imported (\d+) notes, (\d+) attachments/.exec(summary);
  if (Number(match?.[1]) !== NOTES || Number(match?.[2]) !== NOTES) {
    throw new Error(`The library for the run was not made: ${summary}`);
  }
}
const blobFile = (sha256) => join(dataDirectory, 'blobs', sha256.slice(0, 2), sha256.slice(2, 4), sha256);
// With BEVER_SYNC_ENEX set, the notes of that export are in the library too,
// so that the run is of real notes and attachments of every kind.
let allNotes = NOTES;
if (process.env.BEVER_SYNC_ENEX) {
  const summary = execFileSync(importer, [process.env.BEVER_SYNC_ENEX, dataDirectory], { encoding: 'utf8' });
  allNotes += Number(/Imported (\d+) notes/.exec(summary)?.[1]);
  console.log(`With ${allNotes - NOTES} notes of an export beside the ${NOTES} made for the run.`);
}
/** Attachment files in the library: what a complete run has sent. */
const allAttachments = readdirSync(join(dataDirectory, 'blobs'), {
  recursive: true,
  withFileTypes: true,
}).filter((entry) => entry.isFile() && !entry.name.startsWith('.')).length;

// --- The stand-in for pCloud -------------------------------------------------
// It keeps folders and files in memory and answers the few methods a run
// uses. It can be told to take uploads slowly, or to answer late, so that a
// run lasts long enough to be stopped.
const remote = {
  folders: new Set(['/']),
  /** path -> { size, hash, content } ; the content of attachments is not kept. */
  files: new Map(),
  /** Bytes a second at which an upload is taken, or 0 for at once. */
  rate: 0,
  /** Milliseconds every answer is held back. */
  delay: 0,
  uploadsCutShort: 0,
  /** Bytes of uploads taken so far, whole or not. */
  taken: 0,
  /** Whether uploads are refused because the account is full. */
  full: false,
  requests: 0,
  hashes: 0,
  under(folder) {
    const prefix = folder.endsWith('/') ? folder : `${folder}/`;
    return [...this.files.keys()].filter(
      (path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'),
    );
  },
};

/** The files of a multipart form: [{ name, content }]. */
function formFiles(body, contentType) {
  const boundary = Buffer.from(`--${/boundary=(.+)$/.exec(contentType)[1]}`);
  const files = [];
  let at = body.indexOf(boundary);
  while (at >= 0) {
    const headersEnd = body.indexOf('\r\n\r\n', at);
    if (headersEnd < 0) break;
    const headers = body.subarray(at, headersEnd).toString('utf8');
    const next = body.indexOf(boundary, headersEnd);
    if (next < 0) break;
    const name = /filename="([^"]*)"/.exec(headers)?.[1];
    if (name) files.push({ name, content: body.subarray(headersEnd + 4, next - 2) });
    at = next;
  }
  return files;
}

const server = createServer(async (request, response) => {
  remote.requests += 1;
  const url = new URL(request.url, 'http://127.0.0.1');
  const answer = async (value, status = 200) => {
    if (remote.delay) await pause(remote.delay);
    const text = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    response.writeHead(status, { 'Content-Length': text.length });
    response.end(text);
  };
  try {
    const path = url.searchParams.get('path') ?? '';
    if (url.pathname === '/listfolder') {
      if (!remote.folders.has(path))
        return await answer({ result: 2005, error: 'Directory does not exist.' });
      const prefix = `${path}/`;
      const contents = [
        ...[...remote.folders]
          .filter((folder) => folder.startsWith(prefix) && !folder.slice(prefix.length).includes('/'))
          .map((folder) => ({ isfolder: true, name: folder.slice(prefix.length) })),
        ...remote.under(path).map((file) => ({
          isfolder: false,
          name: file.slice(prefix.length),
          size: remote.files.get(file).size,
          hash: remote.files.get(file).hash,
        })),
      ];
      return await answer({ result: 0, metadata: { contents } });
    }
    if (url.pathname === '/createfolderifnotexists') {
      remote.folders.add(path);
      return await answer({ result: 0 });
    }
    if (url.pathname === '/uploadfile') {
      const chunks = [];
      let cut = false;
      request.on('aborted', () => {
        cut = true;
      });
      try {
        for await (const chunk of request) {
          chunks.push(chunk);
          remote.taken += chunk.length;
          if (remote.rate) await pause((chunk.length / remote.rate) * 1000);
        }
      } catch {
        cut = true;
      }
      if (cut || !request.complete) {
        // As pCloud with `nopartial`: what did not arrive whole is not kept.
        remote.uploadsCutShort += 1;
        return;
      }
      if (remote.full) return await answer({ result: 2008, error: 'User is over quota.' });
      const stored = formFiles(Buffer.concat(chunks), request.headers['content-type']).map((file) => {
        const target = `${path}/${file.name}`;
        const entry = {
          size: file.content.length,
          hash: (remote.hashes += 1),
          content: path.endsWith('/blobs') ? null : Buffer.from(file.content),
        };
        remote.files.set(target, entry);
        return { name: file.name, size: entry.size, hash: entry.hash };
      });
      return await answer({ result: 0, metadata: stored });
    }
    if (url.pathname === '/getfilelink') {
      if (!remote.files.get(path)?.content) return await answer({ result: 2009, error: 'File not found.' });
      return await answer({ result: 0, hosts: [request.headers.host], path: `/content${path}` });
    }
    if (url.pathname.startsWith('/content/')) {
      const content = remote.files.get(decodeURIComponent(url.pathname.slice('/content'.length)))?.content;
      return content ? await answer(content) : await answer({}, 404);
    }
    return await answer({ result: 2000, error: `The stand-in does not know ${url.pathname}.` });
  } catch (error) {
    response.destroy(error);
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const standIn = `http://127.0.0.1:${server.address().port}`;
const notesThere = () => remote.under('/Bever/items').length;
const attachmentsThere = () => remote.under('/Bever/blobs').length;

// --- The application ---------------------------------------------------------
const start = () =>
  spawn(executable, [], {
    cwd: root,
    env: {
      ...process.env,
      BEVER_DATA_DIR: dataDirectory,
      BEVER_PCLOUD_STAND_IN: standIn,
      BEVER_EVERNOTE_DIR: evernote,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: 'ignore',
  });
const attach = async (process) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    if (process.exitCode !== null) throw new Error(`Bever exited with code ${process.exitCode}`);
    if (attempt > 120) throw new Error('The application window did not appear within 60 seconds.');
    await pause(500);
  }
  return chromium.connectOverCDP(`http://127.0.0.1:${port}`);
};
/** Waits for the application to end by itself; returns how long that took. */
const ended = async (process, within) => {
  const began = Date.now();
  while (process.exitCode === null) {
    if (Date.now() - began > within) throw new Error(`The application was still running after ${within} ms.`);
    await pause(50);
  }
  return Date.now() - began;
};
/** Opens Settings and returns what the test works with there. */
const openSettings = async (page) => {
  await page.locator('.loading-screen').waitFor({ state: 'detached', timeout: 60000 });
  await page.getByRole('button', { name: 'Settings & sync' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  return {
    settings,
    syncNow: settings.getByRole('button', { name: 'Sync now', exact: true }),
    stop: settings.getByRole('button', { name: 'Stop', exact: true }),
    runs: settings.locator('.sync-runs li'),
  };
};
/** The state of synchronization, from the application itself. */
const status = (page) => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('sync_status'));
/** Starts a run, waits for it to end, and returns its report. */
const finishRun = async (page, syncNow, timeout = 300000) => {
  const before = (await status(page)).runId;
  await syncNow.click();
  await expect
    .poll(
      async () => {
        const now = await status(page);
        return now.runId > before && !now.running;
      },
      { timeout },
    )
    .toBe(true);
  const { lastReport, error } = await status(page);
  if (!lastReport) throw new Error(`The run did not complete: ${error}`);
  return lastReport;
};
// With a real export in the library, text is recognised in its pictures
// while the test runs, and a note that gained such text is sent again. The
// number of notes a run sends is then at least what the test expects.
const real = Boolean(process.env.BEVER_SYNC_ENEX);
const expectSent = (report, notes) =>
  real ? expect(report.pushed).toBeGreaterThanOrEqual(notes) : expect(report.pushed).toBe(notes);
/** Makes a note with a title, and waits until it is in the library. */
const newNote = async (page, title) => {
  await page.keyboard.press('Control+n');
  // The new note is open when its title is there to be typed in, and empty.
  // Typing before that would go to the note that was open until then.
  await expect(page.getByLabel('Note title')).toHaveValue('');
  await page.getByLabel('Note title').fill(title);
  // The list shows a title once it is saved.
  await expect(page.locator('.note-list').getByRole('heading', { name: title, exact: true })).toBeVisible({
    timeout: 10000,
  });
};
/** Holds a file so that no other program can open it, until released. */
const hold = async (file) => {
  const holder = spawn(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$held = [System.IO.File]::Open('${file}', 'Open', 'Read', 'None'); Write-Output held; Start-Sleep -Seconds 900`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  await new Promise((done, fail) => {
    holder.stdout.on('data', (text) => String(text).includes('held') && done());
    holder.on('exit', () => fail(new Error('The file could not be held.')));
  });
  return () =>
    new Promise((done) => {
      holder.removeAllListeners('exit');
      holder.on('exit', done);
      holder.kill();
    });
};

const passed = [];
const check = (description) => {
  passed.push(description);
  console.log(`  ok: ${description}`);
};

let application = start();
let browser;
let release = null;
try {
  browser = await attach(application);
  let page = browser.contexts()[0].pages()[0];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let { settings, syncNow, stop, runs } = await openSettings(page);
  await expect(settings.locator('.setting-ok').first()).toContainText('Connected');
  await expect(syncNow).toBeEnabled();
  await expect(stop).toHaveCount(0);
  check('the application takes the stand-in for pCloud, and no sign-in');

  // --- A run is stopped while it goes ---------------------------------------
  remote.rate = 1_500_000;
  await syncNow.click();
  await expect(stop).toBeVisible();
  // Four large attachments are on their way, and none has arrived whole.
  await expect.poll(() => remote.taken, { timeout: 30000 }).toBeGreaterThan(6_000_000);
  expect(attachmentsThere()).toBe(0);
  const clicked = Date.now();
  await stop.click();
  await expect(settings.getByText(/Synchronization stopped after/)).toBeVisible({ timeout: 5000 });
  const stoppedIn = Date.now() - clicked;
  expect(stoppedIn).toBeLessThan(2500);
  await expect(stop).toHaveCount(0);
  await expect(syncNow).toBeEnabled();
  await expect(settings.locator('.sync-message.error')).toHaveCount(0);
  // Nothing goes on arriving once it says that it has stopped.
  // What had left the application whole may still arrive; nothing else does.
  await pause(2500);
  const there = [notesThere(), attachmentsThere()];
  const taken = remote.taken;
  await pause(2500);
  expect(remote.taken).toBe(taken);
  expect([notesThere(), attachmentsThere()]).toEqual(there);
  expect(attachmentsThere()).toBeLessThan(allAttachments);
  expect(remote.uploadsCutShort).toBeGreaterThan(0);
  await expect(runs.first()).toContainText('Stopped after');
  check(
    `a run is stopped ${stoppedIn} ms after Stop, with ${there[1]} of ${allAttachments} attachments sent and ${remote.uploadsCutShort} transfers cut off`,
  );

  // --- One file cannot be read; the run goes on without its note ------------
  release = await hold(blobFile(attachments[NOTES - 1]));
  remote.rate = 0;
  const withOneHeld = await finishRun(page, syncNow);
  const complete = settings.locator('.sync-message.success');
  await expect(complete).toContainText('Sync complete in');
  const heldBack = await complete.locator('.sync-warnings li').allInnerTexts();
  expect(heldBack).toHaveLength(withOneHeld.warnings.length);
  const held = heldBack.filter((reason) => reason.includes(`Sync note ${number(NOTES)}`));
  expect(held).toHaveLength(1);
  expect(held[0]).toMatch(
    new RegExp(
      `^“! Sync note ${number(NOTES)}” was not uploaded: its attachment “file-${number(NOTES)}\\.bin” is held by another program, or access to it was refused \\(.*os error 32.*\\)\\.$`,
    ),
  );
  // Whatever else is held back is what this computer's security software
  // withheld of a real export, and says so; nothing is held back in silence.
  const withheld = heldBack.filter((reason) => !held.includes(reason));
  for (const reason of withheld) expect(reason).toMatch(/security software on this device/);
  if (withheld.length) console.log(`  (the security software of this computer withheld ${withheld.length})`);
  expectSent(withOneHeld, allNotes - heldBack.length - there[0]);
  await expect(complete).toContainText(`${withOneHeld.pushed} notes uploaded`);
  expect(notesThere()).toBe(allNotes - heldBack.length);
  expect(attachmentsThere()).toBeLessThan(allAttachments);
  await expect(runs.first()).toContainText(
    `${heldBack.length} note${heldBack.length === 1 ? '' : 's'} held back`,
  );
  await page.screenshot({ path: join(root, 'test-results/native-sync-held-back.png') });
  check(
    `a file held by another program holds back its one note; the other ${allNotes - heldBack.length} are synchronized`,
  );

  // --- Once it can be read, the note goes too -------------------------------
  await release();
  release = null;
  const afterRelease = await finishRun(page, syncNow);
  expectSent(afterRelease, 1);
  expect(afterRelease.warnings.join()).not.toContain('Sync note');
  let expectedNotes = allNotes - withheld.length;
  expect(notesThere()).toBe(expectedNotes);
  if (!withheld.length) {
    expect(attachmentsThere()).toBe(allAttachments);
    await expect(runs.first()).toContainText('Completed in');
    await expect(runs.first()).not.toContainText('held back');
  }
  check('the note that was held back goes with the next run, once its file can be read');

  // A run with nothing to do asks for the two listings and no more.
  if (!withheld.length && !real) {
    const asked = remote.requests;
    expectSent(await finishRun(page, syncNow), 0);
    await expect(complete).toContainText('0 notes uploaded');
    expect(remote.requests - asked).toBe(2);
    check('a run with nothing to do makes two requests');
  }

  await page.screenshot({ path: join(root, 'test-results/native-sync-complete.png') });

  // --- A run that pCloud refuses says why, and the next one finishes --------
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await newNote(page, 'Written while the storage was full');
  ({ settings, syncNow, stop, runs } = await openSettings(page));
  remote.full = true;
  await syncNow.click();
  const failure = settings.locator('.sync-message.error');
  await expect(failure).toContainText('Synchronization failed after', { timeout: 30000 });
  await expect(failure).toContainText('Your pCloud storage is full; free some space and synchronize again');
  await expect(failure).toContainText('What was transferred until then is kept');
  await expect(runs.first()).toContainText(/Failed after .*: Your pCloud storage is full/);
  await expect(syncNow).toBeEnabled();
  await page.screenshot({ path: join(root, 'test-results/native-sync-failed.png') });
  remote.full = false;
  expectSent(await finishRun(page, syncNow), 1);
  expectedNotes += 1;
  expect(notesThere()).toBe(expectedNotes);
  await expect(failure).toHaveCount(0);
  check('a run that the service refuses says why in plain words, and the next run finishes it');

  // --- Closing the window keeps a run going; stopping it then quits ---------
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await newNote(page, 'Written before quitting');
  ({ settings, syncNow, stop, runs } = await openSettings(page));
  remote.delay = 4000;
  await syncNow.click();
  await expect(stop).toBeVisible();
  // The window is closed as its close button closes it.
  execFileSync('taskkill', ['/PID', String(application.pid)], { stdio: 'ignore' });
  await pause(2500);
  expect(application.exitCode).toBeNull();
  check('closing the window while a run goes leaves the application running');
  // The application may be gone before the page could answer, so no answer is waited for.
  await page.evaluate(() => {
    void window.__TAURI_INTERNALS__.invoke('stop_sync');
  });
  const quitIn = await ended(application, 5000);
  expect(application.exitCode).toBe(0);
  await browser.close().catch(() => undefined);
  check(`stopping that run ends the application, ${quitIn} ms later`);

  // --- The record of runs is there after a restart --------------------------
  remote.delay = 0;
  application = start();
  browser = await attach(application);
  page = browser.contexts()[0].pages()[0];
  page.on('pageerror', (error) => errors.push(error.message));
  ({ settings, syncNow, stop, runs } = await openSettings(page));
  await expect(runs.first()).toContainText('Stopped after');
  await expect(runs.nth(1)).toContainText('Completed in');
  check('the runs of before are in the record after a restart, the stopped one first');
  expectSent(await finishRun(page, syncNow), 1);
  expectedNotes += 1;
  expect(notesThere()).toBe(expectedNotes);
  check('the note written before quitting is synchronized by the next run');

  // --- A run that never got to end says so afterwards ------------------------
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await newNote(page, 'Written before the power went');
  ({ settings, syncNow, stop, runs } = await openSettings(page));
  remote.delay = 4000;
  await syncNow.click();
  await expect(stop).toBeVisible();
  await pause(1000);
  // As when the computer goes off: the application is gone without a word.
  execFileSync('taskkill', ['/PID', String(application.pid), '/T', '/F'], { stdio: 'ignore' });
  await ended(application, 10000);
  await browser.close().catch(() => undefined);
  remote.delay = 0;
  await pause(1500);
  application = start();
  browser = await attach(application);
  page = browser.contexts()[0].pages()[0];
  page.on('pageerror', (error) => errors.push(error.message));
  ({ settings, syncNow, stop, runs } = await openSettings(page));
  await expect(runs.first()).toContainText('Did not finish; last seen at work after');
  await expect(runs.first()).toContainText(
    'Bever was closed, or the device slept or was turned off, while it ran.',
  );
  // The record is open by itself, since the last run did not end well.
  await expect(runs.first()).toBeVisible();
  await page.screenshot({ path: join(root, 'test-results/native-sync-did-not-finish.png') });
  check('a run that was cut off without a word is in the record as one that did not finish');
  expectSent(await finishRun(page, syncNow), 1);
  expectedNotes += 1;
  expect(notesThere()).toBe(expectedNotes);
  check('and the next run finishes what it left');

  if (errors.length) throw new Error(`Errors in the application window:\n${errors.join('\n')}`);
  expect(savedLogins()).toBe(savedLoginsBefore);
  const userLibraryAfter = existsSync(userLibrary) ? statSync(userLibrary).mtimeMs : null;
  expect(userLibraryAfter).toBe(userLibraryBefore);
  check("no sign-in was saved or removed, and the user's own library was not touched");
  console.log(`PASS: ${passed.length} native synchronization checks.`);
} finally {
  await release?.();
  await browser?.close().catch(() => undefined);
  if (application.exitCode === null) {
    try {
      execFileSync('taskkill', ['/PID', String(application.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // Already gone.
    }
  }
  server.closeAllConnections();
  server.close();
  await pause(1500);
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
}
