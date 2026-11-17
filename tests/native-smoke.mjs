// Drives the real Windows application, not the browser demonstration.
//
//   npm run tauri -- build --no-bundle
//   node tests/native-smoke.mjs
//   BEVER_SMOKE_ENEX=C:\path\notes.enex node tests/native-smoke.mjs
//
// The application is started with its own temporary library
// (BEVER_DATA_DIR) and its own WebView2 profile, so the installed
// application and the user's notes are never touched; this is checked at the
// end. Playwright attaches to the WebView2 window over its debugging port
// and exercises what only the native side can do: the Rust commands, the
// bever: attachment protocol, raw-byte attachments, and file cleanup.
//
// With BEVER_SMOKE_ENEX set, that export is imported first (through the
// import_enex example, since the import dialog is a native file picker) and
// the checks run against a real library.
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const executable = join(root, 'target/release/bever.exe');
const importer = join(root, 'target/release/examples/import_enex.exe');
const exportFile = process.env.BEVER_SMOKE_ENEX;
const port = 9333;

if (!existsSync(executable)) {
  throw new Error(`Build the application first: ${executable} does not exist.`);
}

const work = mkdtempSync(join(tmpdir(), 'bever-smoke-'));
const dataDirectory = join(work, 'library');
const profile = join(work, 'webview');
const userLibrary = join(process.env.APPDATA ?? '', 'io.github.balakrishnangithub.bever', 'bever.db');
const userLibraryBefore = existsSync(userLibrary) ? statSync(userLibrary).mtimeMs : null;

/** Attachment files in the temporary library. */
const blobFiles = () =>
  existsSync(join(dataDirectory, 'blobs'))
    ? readdirSync(join(dataDirectory, 'blobs'), { recursive: true, withFileTypes: true }).filter(
        (entry) => entry.isFile() && !entry.name.startsWith('.'),
      ).length
    : 0;

let imported = null;
if (exportFile) {
  if (!existsSync(importer)) {
    throw new Error('Build the importer first: cargo build --release -p bever-core --example import_enex');
  }
  const summary = execFileSync(importer, [exportFile, dataDirectory], { encoding: 'utf8' });
  const match = /Imported (\d+) notes, (\d+) attachments/.exec(summary);
  imported = { notes: Number(match?.[1]), attachments: Number(match?.[2]) };
  // And a note of the test's own that is a list to its very end, which is
  // where the editor adds a line of its own; see the check that opens it.
  const listExport = join(work, 'Grains.enex');
  writeFileSync(
    listExport,
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">' +
      '<en-export export-date="20261118T000000Z" application="Evernote" version="10.0">' +
      '<note><title>Grains to try</title>' +
      '<created>20240111T192505Z</created><updated>20240130T141156Z</updated>' +
      '<content><![CDATA[<?xml version="1.0" encoding="UTF-8" standalone="no"?>' +
      '<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">' +
      '<en-note><ul><li><div>Oats</div></li><li><div>Maltbarley</div></li></ul>' +
      '<div><br/></div><hr/><div><br/></div>' +
      '<ul><li><div>Rye</div></li><li><div>Millet</div></li></ul></en-note>]]></content></note></en-export>',
  );
  execFileSync(importer, [listExport, dataDirectory], { encoding: 'utf8' });
  imported.notes += 1;
  console.log(`Imported ${imported.notes} notes and ${imported.attachments} attachments for the run.`);
}

// A folder in the form the Evernote application keeps its data in: one
// notebook in a stack, with one note that has an attachment. The note's
// body is a Yjs document, made with that library.
const evernote = join(work, 'Evernote');
{
  const site = 'https%3A%2F%2Fwww.evernote.com';
  const note = '11111111-2222-3333-4444-555555555555';
  const hash = '72adfd72c0caeec500581c85d0f5ce67';
  mkdirSync(join(evernote, 'conduit-storage', site), { recursive: true });
  const database = new DatabaseSync(join(evernote, 'conduit-storage', site, 'UDB-User42+RemoteGraph.sql'));
  database.exec(`
    CREATE TABLE Nodes_Notebook(id TEXT, label TEXT, personal_Stack_id TEXT);
    CREATE TABLE Nodes_Note(id TEXT, label TEXT, isUntitled BOOLEAN, created INTEGER, updated INTEGER,
      deleted INTEGER, parent_Notebook_id TEXT, editor_author TEXT, source TEXT, source_URL TEXT,
      source_application TEXT);
    CREATE TABLE Nodes_Tag(id TEXT, label TEXT);
    CREATE TABLE NoteTag(id TEXT, Note_id TEXT, Tag_id TEXT);
    CREATE TABLE Attachment(id TEXT, filename TEXT, mime TEXT, width INTEGER, height INTEGER,
      isActive BOOLEAN, dataHash TEXT, dataSize INTEGER, applicationDataKeys TEXT,
      applicationData TEXT, shardId TEXT, parent_Note_id TEXT);
    INSERT INTO Nodes_Notebook VALUES ('nb-1', 'Smoke travel', 'Stack:Smoke stack');
    INSERT INTO Nodes_Note VALUES ('${note}', 'First note', 0, 1700000000789, 1700000100123, NULL, 'nb-1', 'Ada', NULL, NULL, NULL);
    INSERT INTO Nodes_Tag VALUES ('tag-1', 'smoke-tag');
    INSERT INTO NoteTag VALUES ('1', '${note}', 'tag-1');
    INSERT INTO Attachment VALUES ('att-1', 'notes.txt', 'text/plain', 0, 0, 1, '${hash}', 16, '[]', NULL, 's1', '${note}');
    CREATE TABLE Nodes_SavedSearch(id TEXT, query TEXT, label TEXT);
    CREATE TABLE Nodes_Shortcut(id TEXT, sortOrder TEXT, source_Stack_id TEXT, source_Note_id TEXT,
      source_Notebook_id TEXT, source_Tag_id TEXT, source_SavedSearch_id TEXT, label TEXT);
    INSERT INTO Nodes_Shortcut VALUES
      ('s-1', 'V', NULL, '${note}', NULL, NULL, NULL, ''),
      ('s-2', 'M', NULL, NULL, 'nb-1', NULL, NULL, ''),
      ('s-3', 'X', 'Stack:A stack that is gone', NULL, NULL, NULL, NULL, '');
    -- A task of the note, which Evernote keeps apart from the note's text,
    -- and a note that lies in Evernote's trash.
    CREATE TABLE Nodes_Task(id TEXT, label TEXT, status TEXT, sortWeight TEXT, taskGroupNoteLevelID TEXT,
      created INTEGER, dueDate INTEGER, dueDateUIOption TEXT, deleted INTEGER, parent_Note_id TEXT);
    INSERT INTO Nodes_Task VALUES ('task-1', 'Pack the smoke bag', 'completed', 'B', 'group-1', 1700000000000, NULL, NULL, NULL, '${note}');
    INSERT INTO Nodes_Note VALUES ('99999999-2222-3333-4444-555555555555', 'Thrown away', 0, 1, 1, 1700000000000, 'nb-1', NULL, NULL, NULL, NULL);
    -- What Evernote says about a note beside what is in it: the first note
    -- has its thumbnail removed, and is pinned to its notebook.
    ALTER TABLE Nodes_Note ADD COLUMN selectedThumbnailHash TEXT;
    UPDATE Nodes_Note SET selectedThumbnailHash = '' WHERE id = '${note}';
    CREATE TABLE Nodes_Preferences(id TEXT, clientInfo TEXT);
  `);
  database
    .prepare('INSERT INTO Nodes_Preferences VALUES (?, ?)')
    .run('preferences', JSON.stringify({ PINNED_NOTES_IN_NOTEBOOK: JSON.stringify({ 'nb-1': [note] }) }));
  database.close();
  const body = join(evernote, 'conduit-fs', site, 'someone', 'rte', 'Note', 'internal_rteDoc', '111', '555');
  mkdirSync(body, { recursive: true });
  writeFileSync(
    join(body, `${note}.dat`),
    Buffer.from(
      'AQwVAAcBB2NvbnRlbnQDB2VuLW5vdGUHABUAAwNkaXYHABUBBgQAFQIPSGVsbG8gJiBnb29kYnllhxUBAwNkaXYHABUSAwhlbi1tZWRpYSgAFRMEaGFzaAF3IDcyYWRmZDcyYzBjYWVlYzUwMDU4MWM4NWQwZjVjZTY3KAAVEwR0eXBlAXcKdGV4dC9wbGFpbocVEgMDZGl2BwAVFgMCYnIEAQV0aXRsZQpGaXJzdCBub3RlKAEQY3VzdG9tTm90ZVN0eWxlcw1oZWFkaW5nU3R5bGVzAXYBB2lzRW1wdHl4AA==',
      'base64',
    ),
  );
  mkdirSync(join(evernote, 'resource-cache', '7', note), { recursive: true });
  writeFileSync(join(evernote, 'resource-cache', '7', note, hash), 'attachment bytes');
}

const start = () =>
  spawn(executable, [], {
    cwd: root,
    env: {
      ...process.env,
      BEVER_DATA_DIR: dataDirectory,
      // The installed Evernote and its notes are never read by this test.
      BEVER_EVERNOTE_DIR: evernote,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: 'ignore',
  });
/** Waits for the WebView of `process` to accept a debugger, and attaches. */
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
    await new Promise((done) => setTimeout(done, 500));
  }
  return chromium.connectOverCDP(`http://127.0.0.1:${port}`);
};
/** Entries of Windows Credential Manager that belong to Bever. */
const savedLogins = () =>
  execFileSync('cmdkey', ['/list'], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => /bever/i.test(line)).length;
const savedLoginsBefore = savedLogins();
let application = start();

const passed = [];
const check = (description) => {
  passed.push(description);
  console.log(`  ok: ${description}`);
};

let browser;
try {
  browser = await attach(application);
  const page = browser.contexts()[0].pages()[0];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // What the content security policy refuses is reported on the console.
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) errors.push(message.text());
  });
  // Requests that would leave the device. The test names a host that cannot exist.
  const webRequests = [];
  page.on('request', (request) => {
    if (request.url().includes('example.invalid')) webRequests.push(request.url());
  });
  await page.locator('.loading-screen').waitFor({ state: 'detached', timeout: 60000 });
  await expect(page.locator('.primary-nav').getByRole('button', { name: /All notes/ })).toBeVisible();
  check('the window opens on its own temporary library');

  const total = async () =>
    Number((await page.locator('.notes-header h1 span').innerText()).replace(/\D/g, ''));

  /** A note as the library has it, read from its file. */
  const stored = (title) => {
    const database = new DatabaseSync(join(dataDirectory, 'bever.db'), { readOnly: true });
    const row = database
      .prepare(
        'SELECT revision, updated_at AS updated, content_html AS html, attributes_json AS attributes FROM notes WHERE title = ?',
      )
      .get(title);
    database.close();
    return { ...row };
  };

  if (imported) {
    await expect(page.locator('.primary-nav .row-count')).toHaveText(imported.notes.toLocaleString());
    expect(await total()).toBe(imported.notes);
    check(`the list reports all ${imported.notes} imported notes`);

    // Scrolling reaches the last note, however many there are.
    let loaded = 0;
    for (let pass = 0; pass < 400; pass += 1) {
      loaded = await page.evaluate(async () => {
        const list = document.querySelector('.note-list');
        list.scrollTop = list.scrollHeight;
        await new Promise((done) => setTimeout(done, 60));
        return Math.round(list.scrollHeight / 138);
      });
      if (loaded >= imported.notes) break;
    }
    expect(loaded).toBeGreaterThanOrEqual(imported.notes);
    check('scrolling loads every note, page by page');
    await page.locator('.note-list').evaluate((list) => (list.scrollTop = 0));

    // Opening a note from a search is not writing in it. The note is a list
    // to its end: the search's marks make the editor add its empty line
    // there, which is not the writer's and must not store the note anew.
    const listed = stored('Grains to try');
    expect(listed.html.trimEnd().endsWith('</ul>')).toBe(true);
    for (const [search, marks] of [
      ['maltbarley', 1],
      ['intitle:"Grains to try" grains', 0],
    ]) {
      await page.getByLabel('Search notes').fill(search);
      await page.getByRole('heading', { name: 'Grains to try', exact: true }).click();
      await expect(page.locator('.note-prose li')).toHaveCount(4);
      await expect(page.locator('.note-prose .note-find-match')).toHaveCount(marks);
      await new Promise((done) => setTimeout(done, 2000));
      expect(stored('Grains to try')).toEqual(listed);
      await expect(page.locator('.discard-changes')).toHaveCount(0);
      await page.getByLabel('Clear search').click();
    }
    check('a note opened from a search is not stored anew, and keeps its date');

    // An imported image attachment is served by the bever: protocol.
    await page.getByRole('button', { name: /Filters/ }).click();
    await page.locator('.filter-panel select').first().selectOption('images');
    await page.getByLabel('Close filters').click();
    if ((await total()) > 0) {
      await page.locator('.note-card .note-open').first().click();
      const image = page.locator('.note-prose .attachment-image img').first();
      await image.scrollIntoViewIfNeeded();
      await expect
        .poll(() => image.evaluate((element) => element.complete && element.naturalWidth > 0), {
          timeout: 20000,
        })
        .toBe(true);
      check('an imported image is displayed from the attachment store');
      await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
      check('opening an imported note does not modify it');
    }
    await page.getByRole('button', { name: /Filters/ }).click();
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();

    // An imported PDF is read from the attachment store a part at a time,
    // shown as its pages one under another, and drawn again when made larger.
    await page.locator('.filter-panel select').first().selectOption('pdf');
    await page.getByLabel('Close filters').click();
    if ((await total()) > 0) {
      await page.locator('.note-card .note-open').first().click();
      await page.getByRole('button', { name: 'Preview PDF', exact: true }).first().click();
      const firstPage = page.locator('.pdf-sheet[data-page="1"]');
      await expect(firstPage.locator('canvas.pdf-whole')).toBeVisible({ timeout: 60000 });
      await expect(page.getByLabel('Loading PDF')).toHaveCount(0);
      const sheets = await page.locator('.pdf-sheet').count();
      await expect(page.locator('.pdf-controls')).toContainText(`/ ${sheets}`);
      const drawnAt = () => firstPage.evaluate((element) => Number(element.dataset.drawn));
      const fitted = await drawnAt();
      const box = await firstPage.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 200));
      await page.keyboard.down('Control');
      for (let turn = 0; turn < 3; turn += 1) {
        await page.mouse.wheel(0, -120);
        await page.waitForTimeout(30);
      }
      await page.keyboard.up('Control');
      expect((await firstPage.boundingBox()).width / box.width).toBeGreaterThan(2);
      // Drawn again for its new size: the whole page finer than before, or,
      // where that would be more than a drawing may have, the part in view.
      await expect
        .poll(
          async () =>
            (await drawnAt()) > fitted * 1.3 || (await firstPage.locator('canvas.pdf-part').count()) > 0,
          { timeout: 30000 },
        )
        .toBe(true);
      await page.getByLabel('Close PDF preview').click();
      await expect(page.locator('.pdf-backdrop')).toHaveCount(0);
      check(
        `an imported PDF of ${sheets} ${sheets === 1 ? 'page' : 'pages'} is shown and drawn again when made larger`,
      );
      await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
    }
    await page.getByRole('button', { name: /Filters/ }).click();
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await page.getByLabel('Close filters').click();
  }

  // A new note, saved through the Rust core.
  const before = await total();
  await page.keyboard.press('Control+n');
  await page.getByLabel('Note title').fill('Native smoke note');
  await page.locator('.note-prose').click();
  await page.locator('.note-prose').pressSequentially('Zebrafinch observations stay on this device.');
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect.poll(total).toBe(before + 1);
  check('a note is created and saved');

  // The filter offers the tags of the notes listed, counted by the library
  // over the whole listing, and a tag chosen there narrows the list.
  await page.getByLabel('Add a tag').fill('filter-check-tag');
  await page.getByLabel('Add a tag').press('Enter');
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: /Filters/ }).click();
  await page.getByLabel('Find a tag').fill('filter-check');
  const checkTag = page.locator('.filter-tags-list .checkbox-label').filter({ hasText: 'filter-check-tag' });
  await expect(checkTag.locator('small')).toHaveText('1', { timeout: 15000 });
  await checkTag.locator('input').check();
  await expect.poll(total).toBe(1);
  await expect(page.locator('.filter-tags-list .checkbox-label')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect.poll(total).toBe(before + 1);
  await page.getByLabel('Close filters').click();
  check('the filter offers the tags of the notes listed, and a tag narrows the list');

  // Pasted bytes travel as a raw IPC body and come back over bever:.
  const blobsBefore = blobFiles();
  const pixel =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const pixelSize = Buffer.from(pixel, 'base64').length;
  await page.locator('.note-prose').evaluate((element, encoded) => {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'smoke-pixel.png', { type: 'image/png' }));
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, pixel);
  const pasted = page.locator('.note-prose .attachment-image img');
  await expect(pasted).toHaveCount(1, { timeout: 15000 });
  await expect
    .poll(() => pasted.evaluate((element) => element.complete && element.naturalWidth === 1), {
      timeout: 15000,
    })
    .toBe(true);
  expect(blobFiles()).toBe(blobsBefore + 1);
  check('a pasted image is stored as an attachment and displayed');
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible({ timeout: 15000 });

  // The attachment protocol honours byte ranges and refuses anything else.
  const source = await pasted.getAttribute('src');
  const range = await page.evaluate(async (url) => {
    const part = await fetch(url, { headers: { Range: 'bytes=0-7' } });
    const whole = await fetch(url);
    const unknown = await fetch(url.replace(/[^/]+$/, 'not-an-attachment'));
    return {
      status: part.status,
      contentRange: part.headers.get('content-range'),
      signature: [...new Uint8Array(await part.arrayBuffer())],
      wholeStatus: whole.status,
      wholeLength: (await whole.arrayBuffer()).byteLength,
      type: whole.headers.get('content-type'),
      unknownStatus: unknown.status,
    };
  }, source);
  expect(range.status).toBe(206);
  expect(range.contentRange).toBe(`bytes 0-7/${pixelSize}`);
  expect(range.signature).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(range.wholeStatus).toBe(200);
  expect(range.wholeLength).toBe(pixelSize);
  expect(range.type).toBe('image/png');
  expect(range.unknownStatus).toBe(404);
  check('the attachment protocol serves byte ranges and only known attachments');

  // A small picture of an attachment, for the list of notes, and none of
  // anything that is not an attachment.
  const small = await page.evaluate(async (url) => {
    const made = await fetch(url.replace(/([^/]+)$/, 'thumb/$1'));
    const unknown = await fetch(url.replace(/[^/]+$/, 'thumb/not-an-attachment'));
    return {
      status: made.status,
      type: made.headers.get('content-type'),
      signature: [...new Uint8Array(await made.arrayBuffer()).slice(0, 2)],
      unknownStatus: unknown.status,
    };
  }, source);
  expect(small.status).toBe(200);
  expect(small.type).toBe('image/jpeg');
  expect(small.signature).toEqual([0xff, 0xd8]);
  expect(small.unknownStatus).toBe(404);
  // A picture this small does not stand for its note until it is chosen to.
  const ownCard = page.locator('.note-card.selected');
  await expect(ownCard.locator('.note-thumbnail')).toHaveCount(0);
  await pasted.click({ button: 'right' });
  await page
    .getByRole('menu', { name: /^Actions for/ })
    .getByRole('menuitem', { name: 'Use as note thumbnail' })
    .click();
  await expect
    .poll(
      () =>
        ownCard
          .locator('.note-thumbnail')
          .evaluate((image) => image.complete && image.naturalWidth === 1)
          .catch(() => false),
      { timeout: 15000 },
    )
    .toBe(true);
  check('a thumbnail is made of an attachment, and a picture chosen for a note is shown in the list');
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible({ timeout: 15000 });

  // Typing right before opening another note is kept.
  await page.getByLabel('Note title').fill('Native smoke note, renamed in a hurry');
  await page.keyboard.press('Control+n');
  await expect(page.getByLabel('Note title')).toHaveValue('');
  await expect(page.getByRole('heading', { name: 'Native smoke note, renamed in a hurry' })).toBeVisible();
  check('an edit made just before leaving a note is saved');

  // Changes made by mistake are taken back, although they were saved.
  await page.getByRole('heading', { name: 'Native smoke note, renamed in a hurry' }).click();
  await expect(page.getByLabel('Note title')).toHaveValue('Native smoke note, renamed in a hurry');
  const asItWas = await page.locator('.note-prose').innerText();
  await page.getByLabel('Note title').fill('Spoilt by mistake');
  await expect(page.getByRole('heading', { name: 'Spoilt by mistake' })).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await page
    .getByRole('dialog', { name: 'Discard the changes?' })
    .getByRole('button', { name: 'Discard changes' })
    .click();
  await expect(page.getByLabel('Note title')).toHaveValue('Native smoke note, renamed in a hurry');
  await expect(page.getByRole('heading', { name: 'Native smoke note, renamed in a hurry' })).toBeVisible();
  expect(await page.locator('.note-prose').innerText()).toBe(asItWas);
  // What was discarded is kept, with the note as it was before.
  await page.getByRole('button', { name: 'Note information' }).click();
  await expect(page.getByRole('region', { name: 'Earlier versions' }).locator('li')).toHaveCount(2);
  await page.getByRole('button', { name: 'Close note information' }).click();
  // Locked, the note takes nothing that is typed.
  await page.getByRole('button', { name: 'Lock this note' }).click();
  await page.locator('.note-prose').click();
  await page.keyboard.type('typed by mistake');
  expect(await page.locator('.note-prose').innerText()).toBe(asItWas);
  await page.getByRole('button', { name: 'Unlock this note' }).click();
  check('changes made by mistake are discarded and kept, and a locked note takes none');

  // Back and forward among the places one has been.
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByLabel('Note title')).toHaveValue('');
  await page.getByRole('button', { name: 'Forward', exact: true }).click();
  await expect(page.getByLabel('Note title')).toHaveValue('Native smoke note, renamed in a hurry');
  check('back and forward return to the notes that were open');
  // What follows is written in the new, empty note.
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByLabel('Note title')).toHaveValue('');

  // Full-text search with prefix matching and a marked match.
  await page.getByLabel('Search notes').fill('zebraf observ');
  await expect(page.locator('.note-card')).toHaveCount(1);
  await expect(page.locator('.note-card mark').first()).toHaveText(/zebrafinch/i);
  await page.getByLabel('Clear search').click();
  check('search finds word beginnings and marks the match');

  // A misspelt word finds what the right spelling would, and says so.
  await page.getByLabel('Search notes').fill('zebrafnich');
  await expect(page.locator('.note-card')).toHaveCount(1);
  await expect(page.locator('.search-corrected')).toContainText('Showing notes for zebrafinch');
  await expect(page.locator('.note-card mark').first()).toHaveText(/zebrafinch/i);
  await page.getByLabel('Search notes').fill('zebrafinch');
  await expect(page.locator('.note-card')).toHaveCount(1);
  await expect(page.locator('.search-corrected')).toHaveCount(0);
  await page.getByLabel('Clear search').click();
  check('a misspelt search is answered by the nearest spelling, and says so');

  // A web clipping keeps its own layout. It is drawn in a frame, which the
  // application's content security policy has to permit; only the real
  // application applies that policy, so it is checked here.
  const clipping =
    '<div style="--en-clipped-content:article; --en-clipped-source-url:https://example.invalid/story;">' +
    '<ul style="display:flex;list-style:none;margin:0px;padding:0px;"><li style="padding:6px 12px;">One</li><li style="padding:6px 12px;">Two</li></ul>' +
    '<h1 style="font-family:Georgia, serif;color:rgb(24, 49, 83);">Clipped heading</h1>' +
    `<img src="data:image/png;base64,${pixel}" width="12" height="12">` +
    '<img src="https://example.invalid/figure.png" width="40" height="40">' +
    '<p style="font-size:18px;">Clipped paragraph.</p></div>';
  await page.getByLabel('Note title').fill('Clipped page');
  await page.locator('.note-prose').click();
  await page.locator('.note-prose').evaluate((element, markup) => {
    const transfer = new DataTransfer();
    transfer.setData('text/html', markup);
    transfer.setData('text/plain', 'Clipped heading');
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, clipping);
  const clipFrame = page.frameLocator('iframe.web-clip-frame');
  const clipIsShown = async () => {
    await expect(page.locator('.web-clip')).toHaveCount(1);
    await expect(clipFrame.getByRole('heading', { name: 'Clipped heading' })).toBeVisible();
    expect(await clipFrame.locator('ul').evaluate((list) => getComputedStyle(list).display)).toBe('flex');
    expect(await clipFrame.locator('h1').evaluate((heading) => getComputedStyle(heading).color)).toBe(
      'rgb(24, 49, 83)',
    );
    await expect
      .poll(() =>
        clipFrame
          .locator('img')
          .first()
          .evaluate((image) => image.naturalWidth),
      )
      .toBe(1);
    await expect(clipFrame.locator('img')).toHaveCount(1);
    await expect(page.getByRole('button', { name: /Load 1 web image/ })).toBeVisible();
  };
  await clipIsShown();
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible({ timeout: 15000 });
  // Stored by the Rust core and read back: the clipping is still a clipping.
  await page.getByRole('heading', { name: 'Native smoke note, renamed in a hurry' }).click();
  await expect(page.locator('.web-clip')).toHaveCount(0);
  await page.getByRole('heading', { name: 'Clipped page' }).click();
  await clipIsShown();
  expect(webRequests).toEqual([]);
  check('a web clipping is stored, shown with its own layout, and requests nothing from the web');

  // Notebook management.
  await page.getByTitle('New notebook').click();
  await page.getByRole('dialog', { name: 'New notebook' }).getByLabel('Notebook name').fill('Smoke');
  await page.getByRole('dialog', { name: 'New notebook' }).getByRole('button', { name: 'Create' }).click();
  await page.locator('.notebook-row', { hasText: 'Smoke' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await page.getByRole('dialog', { name: 'Rename notebook' }).getByLabel('Notebook name').fill('Smoke test');
  await page.getByRole('dialog', { name: 'Rename notebook' }).getByRole('button', { name: 'Rename' }).click();
  await expect(page.locator('.notebook-row', { hasText: 'Smoke test' })).toBeVisible();
  await page.locator('.notebook-row', { hasText: 'Smoke test' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await page
    .getByRole('dialog', { name: /Delete “Smoke test”/ })
    .getByRole('button', { name: 'Delete notebook' })
    .click();
  await expect(page.locator('.notebook-row', { hasText: 'Smoke test' })).toHaveCount(0);
  check('a notebook is created, renamed, and deleted');

  // Deleting for good frees the attachment file.
  await page.getByLabel('Select Native smoke note, renamed in a hurry', { exact: true }).check();
  await page.locator('.bulk-toolbar').getByRole('button', { name: 'Trash', exact: true }).click();
  await page.locator('.sidebar-footer').getByRole('button', { name: /Trash/ }).click();
  await page.getByRole('button', { name: 'Empty Trash' }).click();
  await page
    .getByRole('dialog', { name: 'Empty Trash?' })
    .getByRole('button', { name: 'Empty Trash' })
    .click();
  await expect(page.locator('.empty-list')).toContainText('Trash is empty');
  await expect.poll(blobFiles).toBe(blobsBefore);
  check('emptying the trash removes the attachment file from disk');

  // Settings show the version, and sync is offered only when connected.
  await page.getByRole('button', { name: 'Settings & sync' }).click();
  await expect(page.locator('.settings-version')).toContainText(/Bever \d+\.\d+\.\d+/);
  await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: 'Close settings' }).click();
  check('settings show the version and the sync action');

  // Importing from the Evernote application: here, from a folder made for
  // this test in the form Evernote keeps its data.
  await page.getByRole('button', { name: 'Import notes' }).click();
  await page
    .getByRole('dialog', { name: 'Import notes', exact: true })
    .getByRole('button', { name: /Evernote on this computer/ })
    .click();
  const fromEvernote = page.getByRole('dialog', { name: 'Import from Evernote on this computer' });
  await expect(fromEvernote.getByRole('checkbox', { name: 'Smoke stack', exact: true })).toBeChecked();
  await expect(fromEvernote.getByRole('checkbox', { name: /^Smoke travel/ })).toBeChecked();
  await fromEvernote.getByRole('button', { name: 'Import 1 notebook' }).click();
  const finished = page.getByRole('dialog', { name: 'Import finished' });
  await expect(finished).toContainText('1 note and 1 attachment imported from 1 notebook', {
    timeout: 30000,
  });
  // What came as something else, and what was left in Evernote, is said.
  await expect(finished).toContainText('1 task in 1 note brought as checklists');
  await expect(finished).toContainText('1 note pinned to notebooks as in Evernote');
  await expect(finished).toContainText('1 thumbnail chosen or removed as in Evernote');
  await expect(finished.locator('.import-left')).toHaveText(
    'Not brought: 1 note in Evernote’s trash; 1 shortcut that leads to something Evernote has no more, or that is not in the library.',
  );
  await finished.getByRole('button', { name: 'Done' }).click();
  await expect(
    page.locator('.sidebar-section').nth(1).locator('.notebook-row', { hasText: 'Smoke travel' }),
  ).toBeVisible();
  await expect(page.locator('.sidebar').getByText('Smoke stack', { exact: true })).toBeVisible();
  await page
    .locator('.primary-nav')
    .getByRole('button', { name: /All notes/ })
    .click();
  await expect(page.getByRole('heading', { name: 'First note', exact: true })).toHaveCount(1);
  await page.getByRole('heading', { name: 'First note', exact: true }).click();
  await expect(page.locator('.note-prose')).toContainText('Hello & goodbye');
  await expect(page.locator('.note-prose')).toContainText('notes.txt');
  // The note's task is an item of a checklist in it, ticked as it was done.
  await expect(page.locator('.note-prose li[data-checked="true"]')).toContainText('Pack the smoke bag');
  await expect(page.getByRole('heading', { name: 'Thrown away', exact: true })).toHaveCount(0);
  check(
    'a notebook is imported from the Evernote application’s files, with its stack, note, attachment, and task',
  );
  // The shortcuts Evernote has came along, in its order.
  const shortcutNames = page.locator('.sidebar-section').first().locator('.tree-row span');
  await expect(shortcutNames).toHaveText(['Smoke travel', 'First note']);
  // The notebook's name answers a search, and such a note comes after one
  // whose title has the word.
  await page.getByLabel('Search notes').fill('smoke travel');
  await expect(page.getByRole('heading', { name: 'First note', exact: true })).toHaveCount(1);
  await page.getByLabel('Clear search').click();
  check('shortcuts come from Evernote, and a notebook’s name answers a search');
  // Once more: nothing is imported twice.
  await page.getByRole('button', { name: 'Import notes' }).click();
  await page
    .getByRole('dialog', { name: 'Import notes', exact: true })
    .getByRole('button', { name: /Evernote on this computer/ })
    .click();
  await fromEvernote.getByRole('button', { name: 'Import 1 notebook' }).click();
  await expect(finished).toContainText('1 note already present', { timeout: 30000 });
  await finished.getByRole('button', { name: 'Done' }).click();
  await page
    .locator('.primary-nav')
    .getByRole('button', { name: /All notes/ })
    .click();
  await expect(page.getByRole('heading', { name: 'First note', exact: true })).toHaveCount(1);
  check('importing from Evernote again adds nothing');

  // An imported note is stored as Evernote wrote it. Placing and moving the
  // cursor in it, a letter typed and taken away again, and a space at the
  // end of a line leave it so: to the letter, to its date, to its revision.
  const asImported = stored('First note');
  expect(asImported.html).toContain('<div>Hello &amp; goodbye</div>');
  await page.getByRole('heading', { name: 'First note', exact: true }).click();
  await expect(page.locator('.note-prose')).toContainText('Hello & goodbye');
  await page.locator('.note-prose p').first().click();
  for (const key of ['End', 'Home', 'ArrowRight', 'Shift+ArrowRight', 'ArrowDown', 'Control+End']) {
    await page.keyboard.press(key);
  }
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('End');
  await page.keyboard.type('x');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(' ');
  await new Promise((done) => setTimeout(done, 2000));
  expect(stored('First note')).toEqual(asImported);
  check(
    'placing and moving the cursor, and a letter typed and taken away, leave an imported note as it was stored',
  );
  // A letter that stays is a change, and is stored.
  await page.keyboard.type('!');
  await expect.poll(() => stored('First note').revision, { timeout: 10000 }).toBe(asImported.revision + 1);
  const written = stored('First note');
  expect(written.html).toContain('Hello &amp; goodbye !');
  expect(written.updated).toBeGreaterThan(asImported.updated);
  check('and what is written in it is stored');

  // The note came pinned to its notebook and without a thumbnail, as it is
  // in Evernote. Taking it down here is not an edit: its date stays.
  const marks = JSON.parse(asImported.attributes)['application-data'];
  expect(marks['bever.thumbnail']).toBe('none');
  expect(marks['bever.pinned']).toMatch(/^[0-9a-f-]{36} \d+$/);
  await expect(page.locator('.note-card', { hasText: 'First note' }).locator('.pinned-mark')).toBeVisible();
  await page.getByRole('button', { name: 'Unpin from notebook' }).click();
  await expect(page.locator('.note-card.pinned')).toHaveCount(0);
  const takenDown = stored('First note');
  expect(JSON.parse(takenDown.attributes)['application-data']['bever.pinned']).toBeUndefined();
  expect(takenDown.updated).toBe(written.updated);
  expect(takenDown.html).toBe(written.html);
  await page.getByRole('button', { name: 'Pin to notebook' }).click();
  await expect(page.locator('.note-card.pinned')).toHaveCount(1);
  expect(stored('First note').updated).toBe(written.updated);
  check('a note pinned in Evernote comes pinned; pinning and taking down here do not move its date');

  // A note of which Evernote does not have everything: its picture was
  // never fetched. Its text is the first note's, with a picture where that
  // has a text file, which is the same number of letters in the document.
  {
    const site = 'https%3A%2F%2Fwww.evernote.com';
    const first = '11111111-2222-3333-4444-555555555555';
    const second = '22222222-3333-4444-5555-666666666666';
    const bodies = join(evernote, 'conduit-fs', site, 'someone', 'rte', 'Note', 'internal_rteDoc');
    const body = readFileSync(join(bodies, '111', '555', `${first}.dat`));
    const at = body.indexOf('text/plain');
    if (at < 0) throw new Error('The first note is not in the form this test expects.');
    body.write('image/jpeg', at, 'latin1');
    mkdirSync(join(bodies, '222', '666'), { recursive: true });
    writeFileSync(join(bodies, '222', '666', `${second}.dat`), body);
    const database = new DatabaseSync(join(evernote, 'conduit-storage', site, 'UDB-User42+RemoteGraph.sql'));
    database.exec(`
      INSERT INTO Nodes_Note VALUES ('${second}', 'Second note', 0, 1700000200000, 1700000300000, NULL, 'nb-1', 'Ada', NULL, NULL, NULL, NULL);
      INSERT INTO Attachment VALUES ('att-2', NULL, 'image/jpeg', 400, 300, 1, '72adfd72c0caeec500581c85d0f5ce67', 16, '[]', NULL, 's1', '${second}');
    `);
    database.close();
  }
  await page.getByRole('button', { name: 'Import notes' }).click();
  await page
    .getByRole('dialog', { name: 'Import notes', exact: true })
    .getByRole('button', { name: /Evernote on this computer/ })
    .click();
  // It is named before anything is imported, with what is missing of it.
  await expect(fromEvernote).toContainText('1 note cannot be imported whole');
  await expect(
    fromEvernote.getByRole('list', { name: 'Notes Evernote does not have whole' }).getByRole('listitem'),
  ).toHaveText([/^Second note in Smoke travel.*1 of 1 attachment missing$/]);
  await expect(fromEvernote.getByRole('button', { name: 'Import 1 notebook' })).toBeInViewport({ ratio: 1 });
  // Left as it is, the import leaves the note out and says which it was.
  await fromEvernote.getByRole('button', { name: 'Import 1 notebook' }).click();
  await expect(finished).toContainText(
    '1 note was not imported because Evernote does not have all of it on this computer: “Second note” in “Smoke travel”',
    { timeout: 30000 },
  );
  await finished.getByRole('button', { name: 'Done' }).click();
  await page
    .locator('.primary-nav')
    .getByRole('button', { name: /All notes/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Second note', exact: true })).toHaveCount(0);
  check('a note Evernote does not have whole is named, and left out');
  // Asked to, the import takes it without the picture, and the note says
  // where the picture is missing.
  await page.getByRole('button', { name: 'Import notes' }).click();
  await page
    .getByRole('dialog', { name: 'Import notes', exact: true })
    .getByRole('button', { name: /Evernote on this computer/ })
    .click();
  await fromEvernote.getByRole('checkbox', { name: /^Import this note now, without/ }).check();
  await fromEvernote.getByRole('button', { name: 'Import 1 notebook' }).click();
  await expect(finished).toContainText('1 note and 0 attachments imported from 1 notebook', {
    timeout: 30000,
  });
  await expect(finished).toContainText('1 note imported without attachments Evernote does not have');
  await expect(finished).toContainText('“Second note” in “Smoke travel” (1 of 1)');
  await finished.getByRole('button', { name: 'Done' }).click();
  await page
    .locator('.primary-nav')
    .getByRole('button', { name: /All notes/ })
    .click();
  await page.getByRole('heading', { name: 'Second note', exact: true }).click();
  await expect(page.locator('.note-prose')).toContainText('Hello & goodbye');
  await expect(page.locator('.note-prose .attachment-file')).toContainText('Picture missing', {
    timeout: 15000,
  });
  check('asked to, it is imported without the picture, which the note shows as missing');

  // Removing all data, for a clean uninstall: the library's files go, the
  // application ends, and the next start finds nothing of the old library.
  if (errors.length) throw new Error(`Errors in the application window:\n${errors.join('\n')}`);
  await page.evaluate(() => localStorage.setItem('bever-theme', 'dark'));
  expect(existsSync(join(dataDirectory, 'bever.db'))).toBe(true);
  await page.getByRole('button', { name: 'Settings & sync' }).click();
  await page.getByRole('button', { name: 'Remove all data from this device…' }).click();
  const eraseDialog = page.getByRole('dialog', { name: 'Remove all data from this device?' });
  await eraseDialog.getByLabel('Type ERASE to confirm').fill('ERASE');
  await eraseDialog.getByRole('button', { name: 'Remove everything' }).click();
  for (let attempt = 0; application.exitCode === null; attempt += 1) {
    if (attempt > 60) throw new Error('The application did not end after removing its data.');
    await new Promise((done) => setTimeout(done, 500));
  }
  expect(application.exitCode).toBe(0);
  await browser.close().catch(() => undefined);
  expect(existsSync(dataDirectory)).toBe(false);
  check('removing all data deletes the library and its folder, and ends the application');
  expect(savedLogins()).toBe(savedLoginsBefore);
  check("a test library's removal leaves the installed application's pCloud login alone");

  await new Promise((done) => setTimeout(done, 1500));
  application = start();
  browser = await attach(application);
  const fresh = browser.contexts()[0].pages()[0];
  await fresh.locator('.loading-screen').waitFor({ state: 'detached', timeout: 60000 });
  await expect(fresh.locator('.notes-header h1 span')).toHaveText('0');
  // The application writes its default at once; what was chosen is gone.
  expect(await fresh.evaluate(() => localStorage.getItem('bever-theme'))).toBe('system');
  expect(blobFiles()).toBe(0);
  check('the next start is an empty library with no remembered preferences');

  const userLibraryAfter = existsSync(userLibrary) ? statSync(userLibrary).mtimeMs : null;
  expect(userLibraryAfter).toBe(userLibraryBefore);
  check("the user's own library was not touched");
  console.log(`PASS: ${passed.length} native checks.`);
} finally {
  await browser?.close().catch(() => undefined);
  if (application.exitCode === null) {
    try {
      execFileSync('taskkill', ['/PID', String(application.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // Already gone.
    }
  }
  await new Promise((done) => setTimeout(done, 1500));
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
}
