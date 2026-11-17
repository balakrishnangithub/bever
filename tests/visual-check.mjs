import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { preview } from 'vite';

// Exercise the same production bundle embedded in the native applications.
// This also avoids development-only dependency optimizer stalls on Windows.
const server = await preview({
  preview: { host: '127.0.0.1', port: 7100, strictPort: true },
});
let browser;
const errors = [];
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('http://127.0.0.1:7100', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
  await page.getByText('Welcome to Bever', { exact: true }).first().waitFor({ timeout: 90000 });
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/bever-desktop.png', fullPage: true });

  await page.getByRole('button', { name: 'New note', exact: false }).first().click();
  await page.getByLabel('Note title').fill('My offline field note');
  await page.locator('.note-prose').click();
  await page.locator('.note-prose').pressSequentially('Fast, private, and available anywhere.');
  await page.getByLabel('Add a tag').fill('testing');
  await page.getByLabel('Add a tag').press('Enter');
  await page.getByText('Saved locally', { exact: true }).waitFor({ timeout: 10000 });
  await page.getByLabel('Search notes').fill('offline field');
  await page.getByRole('heading', { name: 'My offline field note' }).waitFor();
  await page.screenshot({ path: 'test-results/bever-editor.png', fullPage: true });

  await page.getByRole('button', { name: 'Add shortcut', exact: true }).click();
  await expect(
    page.locator('.sidebar-section').first().getByText('My offline field note', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Settings & sync' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Optional pCloud sync' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect with browser' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeDisabled();
  await expect(page.getByText('Connect pCloud to enable sync.', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/bever-settings.png', fullPage: true });
  await page.getByLabel('Appearance').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Close settings' }).click();

  // Note-content-only find and keyboard navigation.
  await page.keyboard.press('Control+f');
  await page.getByLabel('Find in note content').fill('My offline field note');
  await expect(page.getByText('No matches', { exact: true })).toBeVisible();
  await page.getByLabel('Find in note content').fill('private');
  await expect(page.locator('.note-find-match')).toHaveCount(1);
  await page.getByLabel('Next match').click();
  await expect(page.locator('.note-find-match.active')).toHaveCount(1);
  await page.getByLabel('Find in note content').press('Escape');
  await expect(page.getByLabel('Find in note content')).toHaveCount(0);
  await page.getByLabel('Keyboard shortcuts').click();
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).press('Escape');

  // The complete palette floats outside the editor's scroll clipping context.
  await page.locator('.note-prose').click();
  await page.locator('.note-prose').press('Control+a');
  await page.getByLabel('Text color', { exact: true }).click();
  await expect(page.getByLabel('Custom text color')).toBeVisible();
  await checkFullyInViewport(page, page.getByRole('dialog', { name: 'Text color', exact: true }));
  await page.screenshot({ path: 'test-results/bever-color-palette.png', fullPage: true });
  await page.getByLabel('Text color: Blue').click();
  await expect(page.locator('.note-prose span[style*="color"]').first()).toHaveCSS(
    'color',
    'rgb(37, 99, 235)',
  );
  await page.getByLabel('Highlight color', { exact: true }).click();
  await expect(page.getByLabel('Custom highlight color')).toBeVisible();
  await checkFullyInViewport(page, page.getByRole('dialog', { name: 'Highlight color', exact: true }));
  await page.screenshot({ path: 'test-results/bever-highlight-palette.png', fullPage: true });
  await page.getByLabel('Highlight color: Mint').click();
  await expect(page.locator('.note-prose mark').first()).toHaveCSS('background-color', 'rgb(187, 247, 208)');

  // Stack folding is independent from stack navigation.
  await page.getByLabel('Collapse stack Learning').click();
  await expect(page.locator('.stack-children')).toHaveCount(0);
  await expect(page.getByLabel('Expand stack Learning')).toHaveAttribute('aria-expanded', 'false');
  await page.getByLabel('Expand stack Learning').click();
  await expect(page.locator('.stack-children')).toBeVisible();

  // Created/updated timestamps use local values, persist, and reject invalid ranges.
  await page.getByTitle('Note information').click();
  await page.getByLabel('Created date and time').fill('2024-01-02T03:04:05');
  await page.getByLabel('Updated date and time').fill('2024-02-03T04:05:06');
  await page.getByRole('button', { name: 'Apply timestamps' }).click();
  await expect(page.getByLabel('Created date and time')).toHaveValue('2024-01-02T03:04:05');
  await expect(page.getByLabel('Updated date and time')).toHaveValue('2024-02-03T04:05:06');
  await page.screenshot({ path: 'test-results/bever-timestamps.png', fullPage: true });
  await page.getByLabel('Close note information').click();
  await page.getByTitle('Note information').click();
  await expect(page.getByLabel('Created date and time')).toHaveValue('2024-01-02T03:04:05');
  await expect(page.getByLabel('Updated date and time')).toHaveValue('2024-02-03T04:05:06');
  await page.getByLabel('Updated date and time').fill('2023-12-31T23:59:59');
  await page.getByRole('button', { name: 'Apply timestamps' }).click();
  await expect(page.locator('.timestamp-editor').getByRole('alert')).toContainText(
    'Updated time must be at or after created time.',
  );
  await page.getByLabel('Close note information').click();

  // Multi-note additive tags and multi-select tag filtering.
  await page.getByLabel('Search notes').fill('');
  await page.getByLabel('Select Welcome to Bever', { exact: true }).check();
  await page.getByLabel('Select Bring your notes along', { exact: true }).check();
  await expect(page.locator('.bulk-toolbar')).toContainText('2 selected');
  await page.screenshot({ path: 'test-results/bever-bulk-actions.png', fullPage: true });
  await page.locator('.bulk-toolbar').getByRole('button', { name: 'Tag', exact: true }).click();
  const tagDialog = page.getByRole('dialog', { name: 'Add tags', exact: true });
  await expect(tagDialog.getByRole('group', { name: 'Existing tags' })).toBeVisible();
  await tagDialog.getByLabel('Tags', { exact: true }).fill('local');
  await expect(tagDialog.getByRole('button', { name: 'Add existing tag local-first' })).toBeVisible();
  await expect(tagDialog.getByRole('button', { name: 'Add existing tag ideas' })).toHaveCount(0);
  await tagDialog.getByRole('button', { name: 'Add existing tag local-first' }).click();
  await expect(tagDialog.getByRole('group', { name: 'Tags to add' })).toContainText('local-first');
  await tagDialog.getByLabel('Tags', { exact: true }).fill('bulk-test, second-tag');
  await tagDialog.getByLabel('Tags', { exact: true }).press('Enter');
  await expect(tagDialog.getByRole('group', { name: 'Tags to add' })).toContainText('bulk-test');
  await expect(tagDialog.getByRole('group', { name: 'Tags to add' })).toContainText('second-tag');
  await page.screenshot({ path: 'test-results/bever-tag-picker.png', fullPage: true });
  await tagDialog.getByRole('button', { name: 'Add tags', exact: true }).click();
  await expect(page.locator('.organization-status')).toContainText('Tags added to 2 notes.');
  await page.getByRole('button', { name: /Filters/ }).click();
  const tagRows = page.locator('.filter-tags-list .checkbox-label');
  // The tags offered are those of the notes listed, each with how many of
  // the notes have it.
  await expect(tagRows.filter({ hasText: 'bulk-test' }).locator('small')).toHaveText('2');
  await page.getByLabel('bulk-test', { exact: true }).check();
  await expect(page.locator('.note-card')).toHaveCount(2);
  // With a tag chosen, what is offered is what its two notes also have:
  // not "testing", which only the note made above has.
  await expect(page.getByLabel('bulk-test', { exact: true })).toBeChecked();
  await expect(tagRows.first()).toContainText('bulk-test');
  await expect(page.getByLabel('second-tag', { exact: true })).toBeVisible();
  await expect(page.getByLabel('testing', { exact: true })).toHaveCount(0);
  // A tag is found by typing some of its name; one that none of the listed
  // notes has is said to be elsewhere, and is there when all are asked for.
  await page.getByLabel('Find a tag').fill('SECOND');
  await expect(tagRows).toHaveCount(2);
  await page.getByLabel('Find a tag').fill('test');
  await expect(page.locator('.filter-tags-note')).toContainText(
    'No tag of these notes has “test” in its name. 1 other tag does.',
  );
  await page.getByRole('button', { name: /^Show all \d+ tags$/ }).click();
  await expect(page.getByLabel('testing', { exact: true })).toBeVisible();
  await expect(tagRows.filter({ hasText: 'testing' })).toHaveClass(/elsewhere/);
  await page.getByRole('button', { name: 'Show only the tags of these notes' }).click();
  await page.getByLabel('Find a tag').fill('second');
  await page.getByLabel('second-tag', { exact: true }).check();
  // Choosing the tag that was looked for ends the looking.
  await expect(page.getByLabel('Find a tag')).toHaveValue('');
  await expect(page.locator('.note-card')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /Filters/ })).toContainText('2');
  await page.screenshot({ path: 'test-results/bever-tag-filters.png', fullPage: true });
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.getByLabel('testing', { exact: true })).toBeVisible();
  await page.getByLabel('Close filters').click();
  await expect(page.locator('.note-card')).toHaveCount(4);

  // Move multiple notes, then copy one note with fresh identity.
  await page.getByLabel('Select Welcome to Bever', { exact: true }).check();
  await page.getByLabel('Select Bring your notes along', { exact: true }).check();
  await page.locator('.bulk-toolbar').getByRole('button', { name: 'Move', exact: true }).click();
  const moveDialog = page.getByRole('dialog', { name: 'Move notes', exact: true });
  await moveDialog.getByLabel('Destination notebook').selectOption({ label: 'Inbox' });
  await moveDialog.getByRole('button', { name: 'Move notes', exact: true }).click();
  await expect(page.locator('.organization-status')).toContainText('2 notes moved.');
  for (const title of ['Welcome to Bever', 'Bring your notes along']) {
    await expect(
      page
        .locator('.note-card')
        .filter({ has: page.getByRole('heading', { name: title, exact: true }) })
        .locator('.note-card-meta'),
    ).toContainText('Inbox');
  }
  await page.getByLabel('Select Welcome to Bever', { exact: true }).check();
  await page.locator('.bulk-toolbar').getByRole('button', { name: 'Copy', exact: true }).click();
  const copyDialog = page.getByRole('dialog', { name: 'Copy notes', exact: true });
  await copyDialog.getByLabel('Destination notebook').selectOption({ label: 'Reading' });
  await copyDialog.getByRole('button', { name: 'Copy notes', exact: true }).click();
  await expect(page.locator('.organization-status')).toContainText('1 note copied.');
  await page.getByLabel('Search notes').fill('Welcome to Bever (copy)');
  await expect(page.getByRole('heading', { name: 'Welcome to Bever (copy)', exact: true })).toBeVisible();
  await page.getByLabel('Search notes').fill('');

  // Local PDF preview, pagination, and attachment context actions.
  await page.getByLabel('Search notes').fill('Local attachment preview');
  await page.locator('.note-card').getByText('Local attachment preview', { exact: true }).click();
  await page.getByRole('button', { name: 'Preview PDF', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Preview Bever preview.pdf' })).toBeVisible();
  // Its pages are one under another, and it lies over the window, not in the note.
  await expect(page.locator('.pdf-sheet')).toHaveCount(2, { timeout: 30000 });
  await expect(page.locator('.pdf-sheet[data-page="1"] canvas.pdf-whole')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.pdf-sheet[data-page="2"] canvas.pdf-whole')).toBeAttached({ timeout: 30000 });
  await expect(page.locator('.pdf-controls')).toContainText('/ 2');
  await expect(page.getByLabel('PDF page', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('Loading PDF')).toHaveCount(0);
  expect(
    await page.locator('.pdf-backdrop').evaluate((element) => element.parentElement === document.body),
  ).toBe(true);
  await page.getByLabel('Next PDF page').click();
  await expect(page.getByLabel('PDF page', { exact: true })).toHaveValue('2');
  await page.getByLabel('PDF page', { exact: true }).fill('1');
  await page.getByLabel('PDF page', { exact: true }).press('Enter');
  await expect(page.getByLabel('PDF page', { exact: true })).toHaveValue('1');
  await page.screenshot({ path: 'test-results/bever-pdf-preview.png', fullPage: true });
  await page.getByLabel('Close PDF preview').click();
  await page.locator('.attachment-file').click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Open with system app' })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'Save as…' })).toBeDisabled();
  await checkFullyInViewport(page, page.getByRole('menu'));
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  // A checklist item keeps its checkbox and its text on one line.
  await page.getByLabel('Search notes').fill('');
  await page.getByRole('button', { name: 'Open note Welcome to Bever', exact: true }).click();
  const taskItem = page.locator('.note-prose ul[data-type="taskList"] > li').first();
  const checkbox = await taskItem.locator('input[type="checkbox"]').boundingBox();
  const taskText = await taskItem.locator('div').first().boundingBox();
  expect(Math.abs(checkbox.y - taskText.y)).toBeLessThan(12);
  expect(taskText.x).toBeGreaterThan(checkbox.x);

  // Evernote highlights and code blocks are shown as such.
  await page.getByRole('button', { name: 'Open note Bring your notes along', exact: true }).click();
  await expect(page.locator('.note-prose mark', { hasText: 'this one' })).toBeVisible();
  await expect(page.locator('.note-prose pre code')).toContainText('notes.search("offline");');
  // Opening a note does not count as editing it.
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();

  // While writing, a click on a link offers what to do with it; the note it
  // points to opens from there, or at once with Ctrl held.
  await page.locator('.note-prose a', { hasText: 'Welcome to Bever' }).click();
  const linkBubble = page.getByRole('toolbar', { name: 'Link' });
  await expect(linkBubble).toBeVisible();
  await expect(page.getByLabel('Note title')).toHaveValue('Bring your notes along');
  await page.keyboard.press('Escape');
  await expect(linkBubble).toHaveCount(0);
  // A second click within half a second would be a double-click, which selects a word.
  await page.waitForTimeout(700);
  await page.locator('.note-prose a', { hasText: 'Welcome to Bever' }).click();
  await linkBubble.getByRole('button', { name: 'Open note' }).click();
  await expect(page.getByLabel('Note title')).toHaveValue('Welcome to Bever');

  // A table is inserted at a chosen size; inside it, its tools are named.
  const firstRowCells = page.locator('.note-prose table tr').first().locator('th, td');
  const tableOption = async (role, name) => {
    await page.getByRole('button', { name: 'Table options' }).click();
    await page.getByRole('menu', { name: 'Table options' }).getByRole(role, { name, exact: true }).click();
  };
  await expect(page.getByRole('button', { name: 'Table options' })).toHaveCount(0);
  await page.locator('.note-prose').click();
  await page.keyboard.press('Control+End');
  await page.getByRole('button', { name: 'Insert table' }).click();
  const picker = page.getByRole('dialog', { name: 'Insert table' });
  await picker.getByRole('button', { name: '4 columns by 2 rows' }).hover();
  await expect(picker).toContainText('4 columns × 2 rows');
  await page.screenshot({ path: 'test-results/bever-table-picker.png', fullPage: true });
  await picker.getByRole('button', { name: '4 columns by 2 rows' }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.locator('.note-prose table tr')).toHaveCount(2);
  await expect(firstRowCells).toHaveCount(4);
  await page.getByRole('button', { name: 'Insert row below' }).click();
  await expect(page.locator('.note-prose table tr')).toHaveCount(3);
  await page.getByRole('button', { name: 'Table options' }).click();
  await expect(page.getByRole('menu', { name: 'Table options' })).toContainText('4 columns × 3 rows');
  await page.screenshot({ path: 'test-results/bever-table-tools.png', fullPage: true });
  await page.getByRole('menuitem', { name: 'Delete column', exact: true }).click();
  await expect(firstRowCells).toHaveCount(3);
  await tableOption('menuitem', 'Insert column left');
  await expect(firstRowCells).toHaveCount(4);
  // The cursor is in the header row, so that is the row removed.
  await tableOption('menuitem', 'Delete row');
  await expect(page.locator('.note-prose table tr')).toHaveCount(2);
  await expect(page.locator('.note-prose table th')).toHaveCount(0);
  await tableOption('menuitemradio', 'Header row');
  await expect(page.locator('.note-prose table th')).toHaveCount(4);
  // The picker's arrow keys choose a size without a pointer.
  await tableOption('menuitem', 'Delete table');
  await expect(page.locator('.note-prose table')).toHaveCount(0);
  await page.getByRole('button', { name: 'Insert table' }).click();
  await page
    .getByRole('dialog', { name: 'Insert table' })
    .getByRole('button', { name: '3 columns by 3 rows' })
    .focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(page.locator('.note-prose table tr')).toHaveCount(2);
  await expect(firstRowCells).toHaveCount(4);
  // A column can be dragged wider by its edge.
  const edge = await firstRowCells.first().boundingBox();
  await page.mouse.move(edge.x + edge.width - 1, edge.y + edge.height / 2);
  await expect(page.locator('.note-prose .column-resize-handle').first()).toBeVisible();
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width + 80, edge.y + edge.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => (await firstRowCells.first().boundingBox()).width)
    .toBeGreaterThan(edge.width + 40);
  await tableOption('menuitem', 'Delete table');
  await expect(page.locator('.note-prose table')).toHaveCount(0);

  // A pasted image becomes an attachment at the cursor.
  await page.locator('.note-prose').click();
  await page.locator('.note-prose').evaluate((element) => {
    const bytes = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAEAAAUAAQ0KLbQAAAAASUVORK5CYII='),
      (character) => character.charCodeAt(0),
    );
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.locator('.note-prose .attachment-image img')).toHaveCount(1);
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible({ timeout: 10000 });

  // Typing right before opening another note is not lost.
  await page.getByLabel('Note title').fill('Welcome, edited in a hurry');
  await page.getByRole('button', { name: 'Open note Local attachment preview', exact: true }).click();
  await expect(page.getByLabel('Note title')).toHaveValue('Local attachment preview');
  await expect(page.getByRole('heading', { name: 'Welcome, edited in a hurry', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open note Welcome, edited in a hurry', exact: true }).click();
  await page.getByLabel('Note title').fill('Welcome to Bever');
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible({ timeout: 10000 });

  // Renaming and deleting a notebook; its notes go to Trash and come back.
  await page.getByTitle('New notebook').click();
  await page.getByRole('dialog', { name: 'New notebook' }).getByLabel('Notebook name').fill('Scratch');
  await page.getByRole('dialog', { name: 'New notebook' }).getByRole('button', { name: 'Create' }).click();
  await page.locator('.notebook-row', { hasText: 'Scratch' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await page.getByRole('dialog', { name: 'Rename notebook' }).getByLabel('Notebook name').fill('Scratchpad');
  await page.getByRole('dialog', { name: 'Rename notebook' }).getByRole('button', { name: 'Rename' }).click();
  await expect(page.locator('.notebook-row', { hasText: 'Scratchpad' })).toBeVisible();
  await page.locator('.notebook-row', { hasText: 'Scratchpad' }).getByRole('button').first().click();
  await page.keyboard.press('Control+n');
  await page.getByLabel('Note title').fill('Doomed with its notebook');
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible({ timeout: 10000 });
  await page.locator('.notebook-row', { hasText: 'Scratchpad' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const deleteNotebook = page.getByRole('dialog', { name: 'Delete “Scratchpad”?' });
  await expect(deleteNotebook).toContainText('Its 1 note moves to Trash');
  await page.screenshot({ path: 'test-results/bever-confirm.png', fullPage: true });
  await deleteNotebook.getByRole('button', { name: 'Delete notebook' }).click();
  await expect(page.locator('.notebook-row', { hasText: 'Scratchpad' })).toHaveCount(0);
  await page.locator('.sidebar-footer').getByRole('button', { name: /Trash/ }).click();
  await expect(page.getByRole('heading', { name: 'Doomed with its notebook', exact: true })).toBeVisible();
  await page.getByLabel('Select Doomed with its notebook', { exact: true }).check();
  await page.locator('.bulk-toolbar').getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.locator('.note-card')).toHaveCount(0);
  await expect(page.locator('.empty-list')).toContainText('Trash is empty');
  await page
    .locator('.primary-nav')
    .getByRole('button', { name: /All notes/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Doomed with its notebook', exact: true })).toBeVisible();

  // Moving to Trash, then emptying it, deletes for good after confirmation.
  await page.getByLabel('Select Doomed with its notebook', { exact: true }).check();
  await page.locator('.bulk-toolbar').getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(page.locator('.toast').first()).toContainText('1 note moved to Trash.');
  await page.locator('.sidebar-footer').getByRole('button', { name: /Trash/ }).click();
  await page.getByRole('button', { name: 'Empty Trash' }).click();
  await page
    .getByRole('dialog', { name: 'Empty Trash?' })
    .getByRole('button', { name: 'Empty Trash' })
    .click();
  await expect(page.locator('.empty-list')).toContainText('Trash is empty');
  await page
    .locator('.primary-nav')
    .getByRole('button', { name: /All notes/ })
    .click();

  // Search matches word beginnings and marks them in the list.
  await page.getByLabel('Search notes').fill('attach prev');
  await expect(page.locator('.note-card')).toHaveCount(1);
  await expect(page.locator('.note-card mark').first()).toBeVisible();
  await page.getByLabel('Clear search').click();
  await expect(page.getByLabel('Search notes')).toHaveValue('');

  // Create overflow in all panes and ensure wheel/touchpad scrolling is local.
  for (let index = 0; index < 12; index += 1) {
    await page.getByTitle('New stack').click();
    const prompt = page.getByRole('dialog', { name: 'New stack' });
    await prompt.getByLabel('Stack name').fill(`Overflow stack ${index + 1}`);
    await prompt.getByRole('button', { name: 'Create' }).click();
    await expect(prompt).toHaveCount(0);
  }
  // A name that is taken is refused with an explanation, not silently.
  await page.getByTitle('New stack').click();
  await page.getByRole('dialog', { name: 'New stack' }).getByLabel('Stack name').fill('overflow STACK 1');
  await page.getByRole('dialog', { name: 'New stack' }).getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('.error-toast')).toContainText('already exists');
  await page.locator('.error-toast').getByLabel('Dismiss').click();
  await checkIndependentWheel(page, '.sidebar-scroll');
  await page.getByLabel('Search notes').fill('');
  for (let index = 0; index < 18; index += 1) {
    await page.keyboard.press('Control+n');
    await page.waitForTimeout(30);
  }
  await checkIndependentWheel(page, '.note-list');
  await page.locator('.note-prose').click();
  await page.locator('.note-prose').pressSequentially('Offline scrolling test.\n\n'.repeat(55));
  await checkIndependentWheel(page, '.document-column');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect((await page.locator('.app-shell').boundingBox()).y).toBe(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Back to notes').click();
  await page.locator('.editor-panel').evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  await expect(page.locator('.notes-panel')).toBeInViewport();
  await page.screenshot({ path: 'test-results/bever-mobile.png', fullPage: true });
  await page.getByLabel('Open navigation').click();
  await page.locator('.sidebar.is-open').waitFor();
  await page.locator('.sidebar').evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  await expect(page.locator('.sidebar')).toBeInViewport();
  await page.getByLabel('Actions for Inbox').click();
  await checkFullyInViewport(page, page.getByRole('menu'));
  await page.getByRole('menuitemradio', { name: 'Learning', exact: true }).click();
  await expect(page.locator('.stack-children').getByText('Inbox', { exact: true })).toBeVisible();
  await page.getByLabel('Actions for Inbox').click();
  await page.getByRole('menuitemradio', { name: 'No stack', exact: true }).click();
  await expect(page.locator('.stack-children').getByText('Inbox', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/bever-mobile-navigation.png', fullPage: true });
  await page.getByRole('button', { name: 'Settings & sync' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.screenshot({ path: 'test-results/bever-mobile-settings.png', fullPage: true });
  const settingsBounds = await page.getByRole('dialog', { name: 'Settings' }).boundingBox();
  expect(settingsBounds).not.toBeNull();
  expect(settingsBounds.x).toBeGreaterThanOrEqual(0);
  expect(settingsBounds.x + settingsBounds.width).toBeLessThanOrEqual(390);
  expect(settingsBounds.y).toBeGreaterThanOrEqual(0);
  expect(settingsBounds.y + settingsBounds.height).toBeLessThanOrEqual(844);
  await page.getByRole('button', { name: 'Close settings' }).click();
  // Settings replaces the drawer entry, so Back cannot expose a hidden drawer.
  await expect(page.locator('.sidebar.is-open')).toHaveCount(0);

  // History Back unwinds the editor instead of closing the application.
  await page.locator('.note-card').first().click();
  await expect(page.locator('.app-shell')).toHaveClass(/mobile-has-note/);
  // On a phone the toolbar is one scrolling row. The table tools are at its
  // far end and come into view when the cursor is in a table.
  await page.locator('.note-prose').click();
  await page.keyboard.press('Control+End');
  await page.getByRole('button', { name: 'Insert table' }).scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Insert table' }).click();
  await checkFullyInViewport(page, page.getByRole('dialog', { name: 'Insert table' }));
  await page.getByRole('button', { name: '2 columns by 2 rows' }).click();
  await expect(page.getByRole('button', { name: 'Table options' })).toBeInViewport();
  await page.getByRole('button', { name: 'Table options' }).click();
  await checkFullyInViewport(page, page.getByRole('menu', { name: 'Table options' }));
  await page.screenshot({ path: 'test-results/bever-mobile-table.png', fullPage: true });
  await page.getByRole('menuitem', { name: 'Delete table', exact: true }).click();
  await expect(page.locator('.note-prose table')).toHaveCount(0);
  await page.evaluate(() => window.history.back());
  await expect(page.locator('.app-shell')).not.toHaveClass(/mobile-has-note/);
  await expect(page.locator('.notes-panel')).toBeInViewport();
  expect(await page.evaluate(() => document.querySelector('.app-shell') !== null)).toBe(true);

  // Real Chromium touch events exercise horizontal edge gestures without
  // claiming that browser emulation verifies a physical Android device.
  const touch = await page.context().newCDPSession(page);
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 4, y: 320 }],
  });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: 100, y: 322 }],
  });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('.sidebar.is-open')).toBeVisible();
  await page.evaluate(() => window.history.back());
  await expect(page.locator('.sidebar.is-open')).toHaveCount(0);
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 200, y: 320 }],
  });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: 202, y: 410 }],
  });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('.sidebar.is-open')).toHaveCount(0);
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  const safeAreaCss = await page.locator('html').evaluate(() => {
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSStyleRule && rule.selectorText === ':root') {
          return rule.style.getPropertyValue('--safe-bottom');
        }
      }
    }
    return '';
  });
  expect(safeAreaCss).toContain('safe-area-inset-bottom');
  expect(await page.locator('.app-shell').evaluate((element) => getComputedStyle(element).height)).toBe(
    '844px',
  );
  expect(await page.locator('html').getAttribute('data-platform')).toBe('other');
  await page.screenshot({ path: 'test-results/bever-mobile-touch.png', fullPage: true });
  // A large library: the count is the real total and scrolling loads the rest.
  const large = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
  large.on('pageerror', (error) => errors.push(error.message));
  await large.goto('http://127.0.0.1:7100/?demoNotes=640', { waitUntil: 'domcontentloaded' });
  await large.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
  await expect(large.locator('.notes-header h1 span')).toHaveText('643');
  await expect(large.locator('.primary-nav .row-count')).toHaveText('643');
  for (let pass = 0; pass < 40; pass += 1) {
    await large.locator('.note-list').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await large.waitForTimeout(120);
    if (await large.getByRole('heading', { name: 'Field note 0640', exact: true }).count()) break;
  }
  await expect(large.getByRole('heading', { name: 'Field note 0640', exact: true })).toBeVisible();
  await large.screenshot({ path: 'test-results/bever-large-library.png' });
  await large.close();

  // A web clipping is shown the way it was clipped, in a frame of its own.
  const clipped = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
  clipped.on('pageerror', (error) => errors.push(error.message));
  clipped.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const webRequests = [];
  clipped.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:7100') && !request.url().startsWith('data:')) {
      webRequests.push(request.url());
    }
  });
  await clipped.goto('http://127.0.0.1:7100/?demoClip', { waitUntil: 'domcontentloaded' });
  await clipped.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
  await clipped.getByRole('heading', { name: 'Clipped: Why beavers build' }).click();
  await expect(clipped.locator('.web-clip')).toHaveCount(1);
  const clipFrame = clipped.frameLocator('iframe.web-clip-frame');
  await expect(clipFrame.getByRole('heading', { name: 'Why beavers build' })).toBeVisible();
  const styleOf = (locator, property) =>
    locator.evaluate((element, name) => getComputedStyle(element)[name], property);
  // The page's own styles are kept, and the application's do not reach it.
  expect(await styleOf(clipFrame.locator('h1'), 'fontFamily')).toBe('Georgia, serif');
  expect(await styleOf(clipFrame.locator('ul'), 'display')).toBe('flex');
  expect(await styleOf(clipFrame.locator('a').first(), 'color')).toBe('rgb(255, 255, 255)');
  expect(await styleOf(clipFrame.locator('body'), 'backgroundColor')).toBe('rgb(255, 255, 255)');
  // A banner the page pinned to the window stays inside the clipping.
  expect(await styleOf(clipFrame.getByText('Subscribe to keep reading'), 'position')).toBe('static');
  // The note's attachment is shown; the image on the web is not requested.
  await expect
    .poll(() =>
      clipFrame
        .locator('img')
        .first()
        .evaluate((image) => image.naturalWidth),
    )
    .toBe(220);
  await expect(clipFrame.locator('img')).toHaveCount(1);
  await expect(clipped.getByRole('button', { name: /Load 1 web image/ })).toBeVisible();
  expect(webRequests).toEqual([]);
  // The frame is as tall as the clipping: the note scrolls, the frame does not.
  const frameBox = await clipped.locator('iframe.web-clip-frame').boundingBox();
  const pageHeight = await clipFrame
    .locator('.content')
    .evaluate((content) => content.getBoundingClientRect().height);
  expect(Math.abs(frameBox.height - pageHeight)).toBeLessThanOrEqual(1);
  await clipped.screenshot({ path: 'test-results/bever-web-clip.png', fullPage: true });
  // Text in the clipping can be selected; the editor does not prevent it.
  const clipText = await clipFrame.locator('p').first().boundingBox();
  await clipped.mouse.move(clipText.x + 4, clipText.y + 14);
  await clipped.mouse.down();
  await clipped.mouse.move(clipText.x + 220, clipText.y + 14, { steps: 8 });
  await clipped.mouse.up();
  expect(
    await clipFrame.locator('body').evaluate(() => document.getSelection().toString().length),
  ).toBeGreaterThan(10);
  // Writing around the clipping leaves it as it was.
  await clipped.locator('.note-prose > p').last().click();
  await clipped.keyboard.press('End');
  await clipped.keyboard.type(' Written after the clipping.');
  await expect(clipped.getByText('Saved locally', { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(clipped.locator('.web-clip')).toHaveCount(1);
  await expect(clipFrame.locator('ul')).toHaveCount(1);
  // A link in the clipping is followed by the application, not by the frame.
  await clipFrame.getByRole('link', { name: 'Welcome' }).click();
  await expect(clipped.getByLabel('Note title')).toHaveValue('Welcome to Bever');
  await clipped.getByRole('heading', { name: 'Clipped: Why beavers build' }).click();
  await expect(clipped.locator('.web-clip')).toHaveCount(1);
  await expect(clipped.locator('.note-prose')).toContainText('Written after the clipping.');
  // A selected clipping is not replaced by what is typed next.
  await clipped.locator('.web-clip-label').click();
  await expect(clipped.locator('.web-clip.selected')).toHaveCount(1);
  await clipped.keyboard.type('Typed with the clipping selected.');
  await expect(clipped.locator('.web-clip')).toHaveCount(1);
  await expect(clipped.locator('.note-prose')).toContainText('Typed with the clipping selected.');
  await expect(clipFrame.locator('ul')).toHaveCount(1);
  // "Make editable" turns the clipping into ordinary note content.
  await clipped.getByRole('button', { name: 'Make editable' }).click();
  const editableDialog = clipped.getByRole('dialog', { name: 'Make this clipping editable?' });
  await editableDialog.getByRole('button', { name: 'Make editable' }).click();
  await expect(clipped.locator('.web-clip')).toHaveCount(0);
  await expect(clipped.locator('.note-prose h1')).toHaveText('Why beavers build');
  await expect(clipped.locator('.note-prose .attachment-image img')).toHaveCount(1);
  expect(webRequests).toEqual([]);
  await clipped.close();

  // Notebooks and tags are listed as they are: a notebook in the stack it
  // was put in, a tag under the tag it was put under, and names in the order
  // a person reads them. Nothing is grouped by how names happen to begin.
  const grouped = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
  grouped.on('pageerror', (error) => errors.push(error.message));
  grouped.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const groupedRequests = [];
  grouped.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:7100') && !request.url().startsWith('data:')) {
      groupedRequests.push(request.url());
    }
  });
  await grouped.goto('http://127.0.0.1:7100/?demoGroups', { waitUntil: 'domcontentloaded' });
  await grouped.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
  const notebooks = grouped.locator('.sidebar-section').nth(1);
  await expect(notebooks.locator('.notebook-row > .tree-row > span')).toHaveText([
    'Feeds Astronomy',
    'Feeds CS',
    'Feeds CS - AI',
    'Feeds CS - Go',
    'Inbox',
    'Recipes',
    'Learning',
    'Reading',
  ]);
  await expect(notebooks.locator('.stack-children').getByText('Reading', { exact: true })).toBeVisible();
  await notebooks.locator('.tree-row', { hasText: 'Feeds CS - AI' }).click();
  await expect(grouped.locator('.note-card')).toHaveCount(1);
  // The list of notebooks folds away, and stays so.
  await notebooks.getByRole('button', { name: 'Collapse Notebooks', exact: true }).click();
  await expect(notebooks.locator('.notebook-row')).toHaveCount(0);
  await grouped.reload({ waitUntil: 'domcontentloaded' });
  await grouped.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
  await notebooks.getByRole('button', { name: 'Expand Notebooks', exact: true }).click();
  await expect(notebooks.locator('.notebook-row')).toHaveCount(8);
  // Shortcuts, notebooks and tags are three boxes that fold alike, and each
  // says how many it holds.
  const boxes = grouped.locator('.sidebar-section');
  await expect(boxes).toHaveCount(3);
  await expect(boxes.locator('.section-heading .section-open > span')).toHaveText([
    'Shortcuts',
    'Notebooks',
    'Tags',
  ]);
  await expect(notebooks.locator('.section-count')).toHaveText('7');
  // What a box holds is in it, and a notebook of a stack begins further in
  // than the stack: under the stack's name, not under its picture.
  const frame = await notebooks.boundingBox();
  for (const row of await notebooks.locator('.notebook-row').all()) {
    const place = await row.boundingBox();
    expect(place.x).toBeGreaterThan(frame.x);
    expect(place.x + place.width).toBeLessThan(frame.x + frame.width);
  }
  const pictureAt = async (row) => (await row.locator('.tree-row > svg').first().boundingBox()).x;
  const stackRow = notebooks.locator('.stack-row', { hasText: 'Learning' });
  const insideStack = notebooks.locator('.stack-children .notebook-row', { hasText: 'Reading' });
  expect((await pictureAt(insideStack)) - (await pictureAt(stackRow))).toBeGreaterThanOrEqual(16);
  const outside = notebooks.locator('.section-body > .notebook-row', { hasText: 'Inbox' });
  expect(await pictureAt(outside)).toBe(await pictureAt(stackRow));
  // The shortcuts fold as the others do, by the arrow or by their name,
  // and stay folded.
  const shortcutBox = boxes.first();
  await expect(shortcutBox.locator('.section-body')).toBeVisible();
  await shortcutBox.getByRole('button', { name: 'Collapse Shortcuts', exact: true }).click();
  await expect(shortcutBox.locator('.section-body')).toHaveCount(0);
  await grouped.reload({ waitUntil: 'domcontentloaded' });
  await grouped.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
  await expect(shortcutBox.getByRole('button', { name: 'Expand Shortcuts', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await shortcutBox.locator('.section-open').click();
  await expect(shortcutBox.locator('.section-body')).toBeVisible();
  // A tag that is inside another is under it, and shown when that is
  // unfolded. Numbers in names count as numbers: 2 comes before 10.
  const tags = grouped.locator('.sidebar-tag-tree');
  await expect(tags.getByText('course | 1 Introduction')).toHaveCount(0);
  await tags.getByRole('button', { name: 'Expand tag Course', exact: true }).click();
  await expect(tags.locator('.stack-children .tree-row > span')).toHaveText([
    'course | 1 Introduction',
    'course | 2 Equations',
    'course | 10 Review',
  ]);
  await grouped.screenshot({ path: 'test-results/bever-sidebar-tree.png', fullPage: true });
  await tags.locator('.tree-row', { hasText: 'Feeds CS - AI' }).click();
  await expect(grouped.locator('.note-card')).toHaveCount(1);
  // A tag is marked by an icon, not by a sign in front of its name.
  await expect(grouped.locator('.notes-header h1')).toContainText('Feeds CS - AI');
  await expect(grouped.locator('.notes-header h1 .title-icon')).toHaveCount(1);
  expect(await grouped.locator('.notes-panel').innerText()).not.toContain('#');

  // The screen of all tags: find one, see where it is, place it under
  // another, and delete one without losing what it holds.
  await grouped.locator('.sidebar').getByRole('button', { name: 'Tags', exact: true }).click();
  const allTags = grouped.getByRole('region', { name: 'Tags', exact: true });
  await expect(allTags).toContainText('12 tags');
  await allTags.getByRole('button', { name: 'Expand Course', exact: true }).click();
  await expect(allTags.locator('.organizer-name')).toHaveText([
    'Course',
    'course | 1 Introduction',
    'course | 2 Equations',
    'course | 10 Review',
    'Feeds Astronomy',
    'Feeds CS',
    'Feeds CS - AI',
    'Feeds CS - Go',
    'ideas',
    'local-first',
    'Recipes',
  ]);
  await allTags.getByLabel('Find tags').fill('lesson');
  await expect(allTags.locator('.organizer-open')).toHaveText([
    /^course \| 1 \| 1 First lesson\s*Course › course \| 1 Introduction$/,
  ]);
  await allTags.getByLabel('Find tags').fill('');
  await allTags.getByLabel('Order').selectOption('count');
  await expect(allTags.locator('.organizer-name').first()).toHaveText('ideas');
  await allTags.getByLabel('Order').selectOption('name');
  await allTags.getByRole('button', { name: 'Actions for Recipes', exact: true }).click();
  await grouped.getByRole('menuitem', { name: 'Move under…' }).click();
  const placing = grouped.getByRole('dialog', { name: 'Move “Recipes” under' });
  await placing.getByLabel('Find a tag').fill('ideas');
  await placing.getByRole('button', { name: 'ideas' }).click();
  await expect(allTags.locator('.organizer-row', { hasText: 'ideas' })).toContainText('1 tag');
  await allTags.getByRole('button', { name: 'Expand ideas', exact: true }).click();
  await expect(allTags.locator('.organizer-name', { hasText: 'Recipes' })).toBeVisible();
  // A tag cannot go under itself or under what it holds: those are not offered.
  await allTags.getByRole('button', { name: 'Actions for ideas', exact: true }).click();
  await grouped.getByRole('menuitem', { name: 'Move under…' }).click();
  const offered = grouped.getByRole('dialog', { name: 'Move “ideas” under' });
  await expect(offered.getByRole('button', { name: 'local-first' })).toHaveCount(1);
  await expect(offered.getByRole('button', { name: 'Recipes' })).toHaveCount(0);
  await offered.getByRole('button', { name: 'Cancel', exact: true }).last().click();
  await allTags.getByRole('button', { name: 'Actions for ideas', exact: true }).click();
  await grouped.getByRole('menuitem', { name: 'Delete…' }).click();
  const deleting = grouped.getByRole('dialog', { name: 'Delete the tag “ideas”?' });
  await expect(deleting).toContainText('The tag inside it is kept and moves up one level.');
  await deleting.getByRole('button', { name: 'Delete tag' }).click();
  await expect(allTags.locator('.organizer-name', { hasText: 'Recipes' })).toBeVisible();
  await expect(allTags.locator('.organizer-name', { hasText: /^ideas$/ })).toHaveCount(0);
  await grouped.screenshot({ path: 'test-results/bever-tags-screen.png', fullPage: true });
  // A tag opens its notes.
  await allTags.locator('.organizer-open', { hasText: 'Feeds CS - AI' }).click();
  await expect(allTags).toHaveCount(0);
  await expect(grouped.locator('.note-card')).toHaveCount(1);

  // The screen of all notebooks, stacks among them.
  await grouped.locator('.sidebar').getByRole('button', { name: 'Notebooks', exact: true }).click();
  const allNotebooks = grouped.getByRole('region', { name: 'Notebooks', exact: true });
  await expect(allNotebooks).toContainText('7 notebooks · 1 stack');
  await expect(allNotebooks.locator('.organizer-name')).toHaveText([
    'Feeds Astronomy',
    'Feeds CS',
    'Feeds CS - AI',
    'Feeds CS - Go',
    'Inbox',
    'Learning',
    'Reading',
    'Recipes',
  ]);
  await allNotebooks.getByLabel('Find notebooks').fill('read');
  await expect(allNotebooks.locator('.organizer-open')).toHaveText([/^Reading\s*Learning$/]);
  await grouped.screenshot({ path: 'test-results/bever-notebooks-screen.png', fullPage: true });
  // Escape empties the field first, and then leaves the screen.
  await grouped.keyboard.press('Escape');
  await expect(allNotebooks.getByLabel('Find notebooks')).toHaveValue('');
  await grouped.keyboard.press('Escape');
  await expect(allNotebooks).toHaveCount(0);
  await expect(grouped.locator('.note-card')).toHaveCount(1);

  // A long title is shown whole, also in a note longer than the window.
  await grouped.locator('.note-card .note-open').first().click();
  const titleField = grouped.getByLabel('Note title');
  const titleFits = () =>
    titleField.evaluate((field) => ({
      cut: field.scrollHeight - field.clientHeight,
      lines: Math.round(field.clientHeight / parseFloat(getComputedStyle(field).lineHeight)),
    }));
  await expect.poll(async () => (await titleFits()).cut).toBeLessThanOrEqual(1);
  expect((await titleFits()).lines).toBeGreaterThanOrEqual(2);
  await grouped.screenshot({ path: 'test-results/bever-long-title.png', fullPage: true });
  await grouped.setViewportSize({ width: 1000, height: 920 });
  await expect.poll(async () => (await titleFits()).cut).toBeLessThanOrEqual(1);
  expect((await titleFits()).lines).toBeGreaterThanOrEqual(3);
  await grouped.setViewportSize({ width: 1440, height: 920 });

  // Laid-out HTML pasted into a note keeps its layout, as one block.
  await expect(grouped.locator('.web-clip')).toHaveCount(1);
  await expect(grouped.locator('.web-clip-label')).toContainText('HTML content');
  const pastedFrame = grouped.frameLocator('iframe.web-clip-frame');
  await expect(pastedFrame.getByText('Simplify')).toBeVisible();
  expect(
    await pastedFrame.getByText('1/2', { exact: true }).evaluate((cell) => getComputedStyle(cell).display),
  ).toBe('table-cell');
  // A small block gets a small frame, not a fixed one.
  await expect
    .poll(async () => (await grouped.locator('iframe.web-clip-frame').boundingBox()).height)
    .toBeLessThan(90);
  await grouped.screenshot({ path: 'test-results/bever-html-content.png', fullPage: true });

  // A web link clicked while writing is not opened; it can be edited in place.
  const webLink = grouped.locator('.note-prose a', { hasText: 'a web link' });
  await webLink.click();
  const bubble = grouped.getByRole('toolbar', { name: 'Link' });
  await expect(bubble).toContainText('https://example.com/exponents');
  await checkFullyInViewport(grouped, bubble);
  await grouped.screenshot({ path: 'test-results/bever-link-bubble.png', fullPage: true });
  // A phone's keyboard makes the window lower when it opens and higher when
  // it closes. The bubble stays through both, next to its link.
  const linkBottom = (await webLink.boundingBox()).y + 30;
  await grouped.setViewportSize({ width: 1440, height: Math.round(Math.max(linkBottom + 150, 420)) });
  await grouped.waitForTimeout(150);
  await expect(bubble).toBeVisible();
  await checkFullyInViewport(grouped, bubble);
  await grouped.setViewportSize({ width: 1440, height: 920 });
  await grouped.waitForTimeout(150);
  await expect(bubble).toContainText('https://example.com/exponents');
  const underLink = async () => (await bubble.boundingBox()).y - (await webLink.boundingBox()).y;
  expect(await underLink()).toBeGreaterThan(0);
  expect(await underLink()).toBeLessThan(60);
  await bubble.getByRole('button', { name: 'Edit' }).click();
  const editLink = grouped.getByRole('dialog', { name: 'Edit link' });
  await expect(editLink.getByLabel('Web address')).toHaveValue('https://example.com/exponents');
  await editLink.getByLabel('Web address').fill('https://example.org/corrected');
  await editLink.getByRole('button', { name: 'Apply' }).click();
  await expect(webLink).toHaveAttribute('href', 'https://example.org/corrected');
  await expect(webLink).toHaveText('a web link');
  await grouped.waitForTimeout(700);
  await webLink.click();
  await bubble.getByRole('button', { name: 'Remove' }).click();
  await expect(grouped.locator('.note-prose a', { hasText: 'a web link' })).toHaveCount(0);
  await expect(grouped.locator('.note-prose')).toContainText('with a web link and');
  // With Ctrl held, a link is followed at once.
  await grouped.locator('.note-prose a', { hasText: 'the welcome note' }).click({ modifiers: ['Control'] });
  await expect(grouped.getByLabel('Note title')).toHaveValue('Welcome to Bever');
  await expect(bubble).toHaveCount(0);

  // "Make editable" leaves the characters of the formula, once.
  await grouped.getByRole('heading', { name: /^Fractional exponents, tough/ }).click();
  await grouped.getByRole('button', { name: 'Make editable' }).click();
  await grouped
    .getByRole('dialog', { name: 'Make this content editable?' })
    .getByRole('button', { name: 'Make editable' })
    .click();
  await expect(grouped.locator('.web-clip')).toHaveCount(0);
  await expect(grouped.locator('.note-prose')).toContainText('Simplify x1/2');
  await expect(grouped.locator('.note-prose')).not.toContainText('to the power of');
  expect(groupedRequests).toEqual([]);
  await grouped.close();

  // Pictures have the size and the place the note gives them.
  const pictured = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
  pictured.on('pageerror', (error) => errors.push(error.message));
  pictured.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await pictured.goto('http://127.0.0.1:7100/?demoImages', { waitUntil: 'domcontentloaded' });
  await pictured.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
  await pictured.getByRole('heading', { name: 'Domain and range, with pictures' }).click();
  const pictures = pictured.locator('.note-prose .attachment-image');
  await expect(pictures).toHaveCount(3);
  const boxOf = async (index) => {
    const box = await pictures.nth(index).boundingBox();
    return { ...box, right: box.x + box.width, ratio: box.width / box.height };
  };
  const line = async () => {
    const box = await pictured.locator('.note-prose').boundingBox();
    return { ...box, right: box.x + box.width, centre: box.x + box.width / 2 };
  };
  await expect.poll(async () => Math.round((await boxOf(0)).width)).toBe(250);
  expect(Math.round((await boxOf(1)).width)).toBe(163);
  // Two small pictures stand side by side, each in its own proportions.
  expect((await boxOf(1)).x).toBeGreaterThan((await boxOf(0)).right);
  expect(Math.abs((await boxOf(1)).y - (await boxOf(0)).y)).toBeLessThanOrEqual(1);
  expect(Math.abs((await boxOf(0)).ratio - 350 / 266)).toBeLessThan(0.02);
  expect(Math.abs((await boxOf(1)).ratio - 370 / 388)).toBeLessThan(0.02);
  // The third is 400 pixels wide and centred.
  expect(Math.round((await boxOf(2)).width)).toBe(400);
  const centred = await boxOf(2);
  expect(Math.abs(centred.x + centred.width / 2 - (await line()).centre)).toBeLessThanOrEqual(2);
  await pictured.screenshot({ path: 'test-results/bever-pictures.png', fullPage: true });

  // A picture's menu stays open while the window changes size under it.
  await pictures.nth(0).hover();
  await pictures
    .nth(0)
    .getByRole('button', { name: /^Actions for/ })
    .click();
  const pictureMenu = pictured.getByRole('menu', { name: /^Actions for/ });
  await expect(pictureMenu.getByRole('menuitem', { name: 'Use as note thumbnail' })).toBeVisible();
  await pictured.setViewportSize({ width: 1440, height: 560 });
  await pictured.waitForTimeout(150);
  await expect(pictureMenu).toBeVisible();
  await checkFullyInViewport(pictured, pictureMenu);
  await pictured.setViewportSize({ width: 1440, height: 920 });
  await pictured.waitForTimeout(150);
  await expect(pictureMenu).toBeVisible();
  await pictured.keyboard.press('Escape');
  await expect(pictureMenu).toHaveCount(0);

  // A selected picture can be placed and sized.
  await pictures.nth(2).locator('img').click();
  const pictureTools = pictured.getByRole('toolbar', { name: 'Picture size and placement' });
  await expect(pictureTools).toBeVisible();
  await expect(pictureTools.getByRole('button', { name: 'Align center' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await pictureTools.getByRole('button', { name: 'Align right' }).click();
  await expect
    .poll(async () => Math.abs((await boxOf(2)).right - (await line()).right))
    .toBeLessThanOrEqual(2);
  expect(Math.round((await boxOf(2)).width)).toBe(400);
  await pictureTools.getByRole('button', { name: 'Fill the width' }).click();
  await expect
    .poll(async () => Math.abs((await boxOf(2)).width - (await line()).width))
    .toBeLessThanOrEqual(2);
  expect(Math.abs((await boxOf(2)).ratio - 643 / 150)).toBeLessThan(0.05);
  await pictureTools.getByRole('button', { name: 'Align left' }).click();
  // Its own size again, on the left.
  await expect.poll(async () => Math.round((await boxOf(2)).width)).toBe(643);
  expect(Math.abs((await boxOf(2)).x - (await line()).x)).toBeLessThanOrEqual(2);
  // Dragging its corner changes the width and keeps the proportions.
  const handle = pictures.nth(2).locator('.image-resize-handle');
  const grip = await handle.boundingBox();
  await pictured.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await pictured.mouse.down();
  await pictured.mouse.move(grip.x + grip.width / 2 - 243, grip.y + 40, { steps: 8 });
  await expect(pictures.nth(2).locator('.image-size-note')).toContainText('400 px wide');
  await pictured.mouse.up();
  await expect.poll(async () => Math.round((await boxOf(2)).width)).toBe(400);
  expect(Math.abs((await boxOf(2)).ratio - 643 / 150)).toBeLessThan(0.05);
  await pictured.screenshot({ path: 'test-results/bever-picture-tools.png', fullPage: true });
  await pictureTools.getByRole('button', { name: 'Align center' }).click();
  await expect(pictured.getByText('Saved locally', { exact: true })).toBeVisible({ timeout: 10000 });
  // What was chosen is kept in the note.
  await pictured.getByRole('heading', { name: 'Welcome to Bever' }).click();
  await pictured.getByRole('heading', { name: 'Domain and range, with pictures' }).click();
  await expect(pictures).toHaveCount(3);
  await expect.poll(async () => Math.round((await boxOf(2)).width)).toBe(400);
  const kept = await boxOf(2);
  expect(Math.abs(kept.x + kept.width / 2 - (await line()).centre)).toBeLessThanOrEqual(2);
  // On a phone the two small pictures still fit, and a wide one shrinks.
  await pictured.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await boxOf(2)).width).toBeLessThanOrEqual((await line()).width + 1);
  expect(Math.abs((await boxOf(2)).ratio - 643 / 150)).toBeLessThan(0.05);
  expect(Math.round((await boxOf(0)).width)).toBe(250);
  // The drawer that the narrow layout brings with it slides away first.
  await pictured.waitForTimeout(600);
  await pictured.screenshot({ path: 'test-results/bever-pictures-mobile.png', fullPage: true });
  await pictured.setViewportSize({ width: 1440, height: 920 });

  // The note alone: the notebooks and the list of notes are put away.
  const columnWidth = async () => (await pictured.locator('.editor-panel').boundingBox()).width;
  const besideLists = await columnWidth();
  await pictured.getByRole('button', { name: 'Expand the note' }).click();
  await expect(pictured.locator('.sidebar')).toBeHidden();
  await expect(pictured.locator('.notes-panel')).toBeHidden();
  expect(await columnWidth()).toBe(1440);
  expect((await line()).width).toBeGreaterThan(900);
  await pictured.screenshot({ path: 'test-results/bever-note-focus.png', fullPage: true });
  // It is remembered, and Ctrl+\ switches it as the button does.
  await pictured.reload({ waitUntil: 'domcontentloaded' });
  await pictured.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
  await expect(pictured.locator('.sidebar')).toBeVisible();
  await pictured.getByRole('heading', { name: 'Domain and range, with pictures' }).click();
  await expect(pictured.locator('.notes-panel')).toBeHidden();
  await pictured.keyboard.press('Control+Backslash');
  await expect(pictured.locator('.notes-panel')).toBeVisible();
  expect(await columnWidth()).toBe(besideLists);
  await pictured.keyboard.press('Control+Backslash');
  await expect(pictured.locator('.sidebar')).toBeHidden();
  await pictured.getByRole('button', { name: 'Show notebooks and notes' }).click();
  await expect(pictured.locator('.sidebar')).toBeVisible();
  await pictured.close();

  // What a search found is shown in the note it opened: in its text, and in
  // the text recognised in its pictures.
  const searching = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
  searching.on('pageerror', (error) => errors.push(error.message));
  searching.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await searching.goto('http://127.0.0.1:7100/?demoImages', { waitUntil: 'domcontentloaded' });
  await searching.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
  // The list shows a note by its largest picture.
  const pictureCard = searching.locator('.note-card', { hasText: 'Domain and range, with pictures' });
  const thumbnail = pictureCard.locator('.note-thumbnail');
  await expect.poll(() => thumbnail.evaluate((image) => image.naturalWidth)).toBe(370);
  await expect(searching.locator('.note-card', { hasText: 'Welcome to Bever' }).locator('img')).toHaveCount(
    0,
  );
  await searching.screenshot({ path: 'test-results/bever-thumbnails.png', fullPage: true });
  await searching.getByLabel('Search notes').fill('range inter');
  await expect(searching.locator('.note-card')).toHaveCount(1);
  await pictureCard.getByRole('heading').click();
  const marks = searching.locator('.note-prose .note-find-match');
  await expect(marks).toHaveCount(2);
  await expect(marks.nth(0)).toHaveText('range');
  // A word of the search may go on, as it may in the library's index.
  await expect(marks.nth(1)).toHaveText('inter');
  const found = searching.locator('.note-prose .image-found');
  await expect(found).toHaveCount(2);
  // The first picture's text says where its words are: the word is marked
  // where it stands.
  await expect(found.nth(0).locator('span')).toHaveCount(1);
  const word = await found.nth(0).locator('span').boundingBox();
  const around = await searching.locator('.note-prose .attachment-image').nth(0).boundingBox();
  expect(Math.abs((word.x + word.width / 2 - around.x) / around.width - (238 + 45) / 350)).toBeLessThan(0.02);
  expect(Math.abs((word.y + word.height / 2 - around.y) / around.height - (216 + 17) / 266)).toBeLessThan(
    0.02,
  );
  // The last picture's text is known without places: it is marked as a whole.
  await expect(found.nth(1)).toHaveClass(/whole/);
  await expect(found.nth(1).locator('span')).toHaveCount(0);
  await searching.screenshot({ path: 'test-results/bever-search-highlight.png', fullPage: true });
  // The marks can be put away, and that is remembered.
  const highlightToggle = searching.getByRole('button', { name: 'Highlight search matches' });
  await expect(highlightToggle).toHaveAttribute('aria-pressed', 'true');
  await highlightToggle.click();
  await expect(marks).toHaveCount(0);
  await expect(found).toHaveCount(0);
  expect(await searching.evaluate(() => window.localStorage.getItem('bever.highlightSearch'))).toBe('off');
  await highlightToggle.click();
  await expect(marks).toHaveCount(2);
  await expect(found).toHaveCount(2);

  // Find looks in the note's text and in its pictures, and steps through both.
  await searching.getByRole('button', { name: 'Find in this note' }).click();
  const findBar = searching.getByRole('dialog', { name: 'Find in note' });
  const findField = findBar.getByLabel('Find in note content');
  await findField.fill('domain');
  await expect(findBar).toContainText('1 / 1');
  // What the library was searched for steps aside while Find is used.
  await expect(marks).toHaveCount(0);
  await expect(found).toHaveCount(1);
  await expect(found.nth(0)).toHaveClass(/active/);
  await findField.fill('the');
  await expect(findBar).toContainText('1 / 3');
  await expect(found).toHaveCount(0);
  await findField.press('Enter');
  await expect(findBar).toContainText('2 / 3');
  await expect(searching.locator('.note-find-match.active')).toHaveText('the');
  // The picture stands before the line that says the same.
  await findField.fill('interval');
  await expect(findBar).toContainText('1 / 2');
  await expect(found).toHaveCount(1);
  await expect(found.nth(0)).toHaveClass(/whole/);
  await expect(found.nth(0)).toHaveClass(/active/);
  await searching.screenshot({ path: 'test-results/bever-find-picture.png', fullPage: true });
  await findField.press('Enter');
  await expect(findBar).toContainText('2 / 2');
  await expect(found.nth(0)).not.toHaveClass(/active/);
  await expect(searching.locator('.note-find-match.active')).toHaveText('interval');
  await findField.press('Escape');
  await expect(findBar).toHaveCount(0);
  await expect(marks).toHaveCount(2);

  // A picture of the note can be chosen to stand for it in the list.
  const chosenPicture = searching.locator('.note-prose .attachment-image').nth(0);
  const pictureActions = searching.getByRole('menu', { name: /^Actions for/ });
  await chosenPicture.click({ button: 'right' });
  await pictureActions.getByRole('menuitem', { name: 'Use as note thumbnail' }).click();
  await expect(searching.getByText('The list of notes now shows this note by this picture.')).toBeVisible();
  await expect.poll(() => thumbnail.evaluate((image) => image.naturalWidth), { timeout: 10000 }).toBe(350);
  await searching.screenshot({ path: 'test-results/bever-thumbnail-chosen.png', fullPage: true });
  await chosenPicture.click({ button: 'right' });
  await pictureActions.getByRole('menuitem', { name: 'Stop using as thumbnail' }).click();
  await expect.poll(() => thumbnail.evaluate((image) => image.naturalWidth), { timeout: 10000 }).toBe(370);
  // On a phone the note's header still holds its buttons.
  await searching.setViewportSize({ width: 390, height: 844 });
  await searching.waitForTimeout(600);
  await checkFullyInViewport(searching, highlightToggle);
  await checkFullyInViewport(searching, searching.getByRole('button', { name: 'Find in this note' }));
  await checkFullyInViewport(searching, searching.getByRole('button', { name: 'Move to Trash' }));
  await searching.screenshot({ path: 'test-results/bever-search-highlight-mobile.png', fullPage: true });
  await searching.getByRole('button', { name: 'Back to notes' }).click();
  await searching.waitForTimeout(600);
  await searching.screenshot({ path: 'test-results/bever-thumbnails-mobile.png', fullPage: true });
  await searching.close();

  // A picture annotated in Evernote: its marks are separate things that can
  // be moved, reworded and removed, and new ones are stored the same way.
  const annotated = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScale: 1 });
  annotated.on('pageerror', (error) => errors.push(error.message));
  annotated.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await annotated.goto('http://127.0.0.1:7100/?demoAnnotated', { waitUntil: 'domcontentloaded' });
  await annotated.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
  await annotated.getByRole('heading', { name: 'A picture with annotations' }).click();
  const notePicture = annotated.locator('.note-prose .attachment-image img');
  await expect.poll(() => notePicture.evaluate((image) => image.naturalWidth)).toBe(420);
  const firstSource = await notePicture.getAttribute('src');
  const openAnnotator = async () => {
    await notePicture.click();
    await annotated
      .getByRole('toolbar', { name: 'Picture size and placement' })
      .getByRole('button', { name: 'Annotate' })
      .click();
    await expect(annotated.getByRole('dialog', { name: /^Annotate / })).toBeVisible();
    await expect(annotated.getByLabel('Picture to annotate')).toBeVisible();
  };
  const drawing = annotated.getByLabel('Picture to annotate');
  /** The colour of the picture's pixel at (x, y), as "r,g,b". */
  const pixel = (x, y) =>
    drawing.evaluate(
      (canvas, [left, top]) =>
        [...canvas.getContext('2d').getImageData(left, top, 1, 1).data.slice(0, 3)].join(','),
      [x, y],
    );
  /** Where the picture's pixel (x, y) is on screen. */
  const onScreen = async (x, y) => {
    const box = await drawing.boundingBox();
    return [box.x + (x * box.width) / 420, box.y + (y * box.height) / 260];
  };
  const dragOnPicture = async (from, to) => {
    await annotated.mouse.move(...(await onScreen(...from)));
    await annotated.mouse.down();
    await annotated.mouse.move(...(await onScreen(...to)), { steps: 6 });
    await annotated.mouse.up();
  };
  const tools = annotated.getByRole('toolbar', { name: 'Annotation tools' });
  const RED = '232,38,45';
  const SKY = '219,231,243';

  await openAnnotator();
  // The three marks Evernote stored are there as three marks.
  await expect(drawing).toHaveAttribute('data-marks', '3');
  await expect(tools.getByRole('button', { name: 'Select, move, and reword marks' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(await pixel(150, 60)).toBe(RED);
  await annotated.screenshot({ path: 'test-results/bever-annotator.png', fullPage: true });
  // Moving the rectangle moves only the rectangle; the picture under it is whole.
  await dragOnPicture([150, 61], [210, 91]);
  await expect.poll(() => pixel(210, 90)).toBe(RED);
  expect(await pixel(150, 60)).toBe(SKY);
  // The text is reworded where it stands.
  await annotated.mouse.dblclick(...(await onScreen(290, 45)));
  const wording = annotated.getByLabel('Text on the picture');
  await expect(wording).toHaveValue('Out of domain');
  await wording.fill('Undefined here');
  await wording.press('Enter');
  await expect(wording).toHaveCount(0);
  // The eraser takes a whole mark away and leaves the picture.
  await tools.getByRole('button', { name: 'Eraser: removes a mark' }).click();
  await annotated.mouse.click(...(await onScreen(290, 185)));
  await expect(drawing).toHaveAttribute('data-marks', '2');
  expect(await pixel(290, 185)).toBe(SKY);
  // New marks: a pen stroke, a shape chosen from the list, a stamp, a text.
  await tools.getByRole('button', { name: 'Pen', exact: true }).click();
  await dragOnPicture([40, 230], [120, 240]);
  await expect(drawing).toHaveAttribute('data-marks', '3');
  await tools.getByRole('button', { name: 'Shape', exact: true }).click();
  await annotated.getByRole('menu', { name: 'Shape' }).getByRole('menuitemradio', { name: 'Circle' }).click();
  await dragOnPicture([300, 60], [380, 120]);
  await tools.getByRole('button', { name: 'Stamp', exact: true }).click();
  await annotated
    .getByRole('menu', { name: 'Stamp' })
    .getByRole('menuitemradio', { name: 'Rejected' })
    .click();
  await annotated.mouse.click(...(await onScreen(60, 60)));
  await tools.getByRole('button', { name: 'Colour' }).click();
  await annotated
    .getByRole('menu', { name: 'Colour' })
    .getByRole('menuitemradio', { name: '#1c7ed6' })
    .click();
  await tools.getByRole('button', { name: 'Text', exact: true }).click();
  await annotated.mouse.click(...(await onScreen(150, 215)));
  await wording.fill('Added in Bever');
  await wording.press('Enter');
  await expect(drawing).toHaveAttribute('data-marks', '6');
  // Undo takes the last mark back, Redo returns it.
  await tools.getByRole('button', { name: 'Undo' }).click();
  await expect(drawing).toHaveAttribute('data-marks', '5');
  await tools.getByRole('button', { name: 'Redo' }).click();
  await expect(drawing).toHaveAttribute('data-marks', '6');
  // An arrow is the same on both sides of its line, up to its tip.
  await tools.getByRole('button', { name: 'Shape', exact: true }).click();
  await annotated.getByRole('menu', { name: 'Shape' }).getByRole('menuitemradio', { name: 'Arrow' }).click();
  await dragOnPicture([40, 150], [130, 150]);
  await expect(drawing).toHaveAttribute('data-marks', '7');
  const arrowColour = await pixel(90, 150);
  expect(arrowColour).not.toBe(SKY);
  const reach = async (x, direction) => {
    let distance = 0;
    while (distance < 30 && (await pixel(x, 150 + direction * (distance + 1))) === arrowColour) distance += 1;
    return distance;
  };
  for (const x of [60, 90, 108, 114, 120]) {
    expect(Math.abs((await reach(x, -1)) - (await reach(x, 1)))).toBeLessThanOrEqual(1);
  }
  expect(await reach(114, 1)).toBeGreaterThan(await reach(60, 1));
  await annotated.screenshot({ path: 'test-results/bever-annotator-arrow.png', fullPage: true });
  await tools.getByRole('button', { name: 'Undo' }).click();
  await expect(drawing).toHaveAttribute('data-marks', '6');
  // A selected mark is removed by the button beside the select tool; with
  // nothing selected there is nothing for it to remove.
  const removeMark = tools.getByRole('button', { name: 'Remove selected' });
  await tools.getByRole('button', { name: 'Select, move, and reword marks' }).click();
  await expect(removeMark).toBeDisabled();
  await annotated.mouse.click(...(await onScreen(80, 235)));
  await expect(removeMark).toBeEnabled();
  await removeMark.click();
  await expect(drawing).toHaveAttribute('data-marks', '5');
  await expect(removeMark).toBeDisabled();
  await tools.getByRole('button', { name: 'Undo' }).click();
  await expect(drawing).toHaveAttribute('data-marks', '6');
  await annotated.screenshot({ path: 'test-results/bever-annotator-edited.png', fullPage: true });
  await annotated.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(annotated.getByRole('dialog', { name: /^Annotate / })).toHaveCount(0);
  // The note shows the new picture, at the size and place the old one had.
  await expect.poll(() => notePicture.getAttribute('src')).not.toBe(firstSource);
  await expect.poll(() => notePicture.evaluate((image) => image.naturalWidth)).toBe(420);
  await expect(annotated.getByText('Saved locally', { exact: true })).toBeVisible({ timeout: 10000 });
  await annotated.screenshot({ path: 'test-results/bever-annotated-note.png', fullPage: true });

  // Opened again, every mark is still a mark: the saved file carries them.
  await openAnnotator();
  await expect(drawing).toHaveAttribute('data-marks', '6');
  expect(await pixel(210, 90)).toBe(RED);
  await dragOnPicture([210, 91], [150, 61]);
  await expect.poll(() => pixel(150, 60)).toBe(RED);
  await annotated.mouse.dblclick(...(await onScreen(290, 45)));
  await expect(wording).toHaveValue('Undefined here');
  await wording.press('Escape');
  // Clearing the annotations brings the original picture back, untouched.
  await tools.getByRole('button', { name: 'Clear annotations' }).click();
  await expect(drawing).toHaveAttribute('data-marks', '0');
  for (const [x, y] of [
    [150, 60],
    [60, 60],
    [340, 90],
    [80, 235],
  ])
    expect(await pixel(x, y)).toBe(SKY);
  expect(await pixel(200, 192)).toBe('163,80,30');
  await tools.getByRole('button', { name: 'Undo' }).click();
  await expect(drawing).toHaveAttribute('data-marks', '6');
  // Cancel leaves the note as it was.
  const savedSource = await notePicture.getAttribute('src');
  await annotated.getByRole('button', { name: 'Cancel' }).click();
  await expect(annotated.getByRole('dialog', { name: /^Annotate / })).toHaveCount(0);
  expect(await notePicture.getAttribute('src')).toBe(savedSource);
  await annotated.close();

  // A sketch drawn in Evernote: its strokes are read from the picture, can be
  // added to, removed, and moved, and are stored the same way.
  const sketching = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  sketching.on('pageerror', (error) => errors.push(error.message));
  sketching.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await sketching.goto('http://127.0.0.1:7100/?demoSketch', { waitUntil: 'domcontentloaded' });
  await sketching.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
  await sketching.getByRole('heading', { name: 'A sketch' }).click();
  const sketchPicture = sketching.locator('.note-prose .attachment-image img');
  await expect.poll(() => sketchPicture.evaluate((image) => image.naturalWidth)).toBeGreaterThan(100);
  const sketchSource = await sketchPicture.getAttribute('src');
  const sketchWidth = await sketchPicture.evaluate((image) => image.naturalWidth);
  const sketchDialog = sketching.getByRole('dialog', { name: /^Sketch / });
  const paper = sketching.getByLabel('Sketch', { exact: true });
  const openSketch = async () => {
    await sketchPicture.click();
    // A sketch is not annotated: its own strokes are changed.
    await sketching
      .getByRole('toolbar', { name: 'Picture size and placement' })
      .getByRole('button', { name: 'Edit sketch' })
      .click();
    await expect(sketchDialog).toBeVisible();
    await expect(paper).toBeVisible();
  };
  /** Where the sketch's own point (x, y) is on screen. */
  const onPaper = async (x, y) => {
    const box = await paper.boundingBox();
    const [left, top, zoom] = (await paper.getAttribute('data-view')).split(',').map(Number);
    return [box.x + (x - left) * zoom, box.y + (y - top) * zoom];
  };
  /** The colour drawn at the sketch's point (x, y), as "r,g,b". */
  const inkAt = async (x, y) => {
    const box = await paper.boundingBox();
    const [screenX, screenY] = await onPaper(x, y);
    return paper.evaluate(
      (canvas, [left, top]) => {
        const scale = canvas.width / canvas.getBoundingClientRect().width;
        const data = canvas
          .getContext('2d')
          .getImageData(Math.round(left * scale), Math.round(top * scale), 1, 1).data;
        return [...data.slice(0, 3)].join(',');
      },
      [screenX - box.x, screenY - box.y],
    );
  };
  /** Draws through the sketch's points with the pointer held down. */
  const stroke = async (points) => {
    await sketching.mouse.move(...(await onPaper(...points[0])));
    await sketching.mouse.down();
    for (const point of points.slice(1)) await sketching.mouse.move(...(await onPaper(...point)));
    await sketching.mouse.up();
  };
  const view = sketching.getByRole('toolbar', { name: 'Sketch view and paper' });
  const rail = sketching.getByRole('toolbar', { name: 'Sketch tools' });

  await openSketch();
  // The four strokes Evernote stored are there, drawn where they were drawn.
  await expect(paper).toHaveAttribute('data-strokes', '4');
  await expect(paper).toHaveAttribute('data-paper', '#ffffff,3,false');
  expect(await inkAt(300, 270)).toBe('234,70,67');
  expect(await inkAt(390, 330)).toBe('91,26,123');
  // The highlighter lets the paper through.
  expect(await inkAt(390, 360)).toBe('254,249,216');
  expect(await inkAt(360, 270)).toBe('255,255,255');
  await sketching.screenshot({ path: 'test-results/bever-sketch.png', fullPage: true });

  // A stroke of the pen.
  await stroke([
    [520, 200],
    [540, 215],
    [560, 205],
    [580, 225],
    [600, 215],
    [620, 235],
  ]);
  await expect(paper).toHaveAttribute('data-strokes', '5');
  await expect(paper).toHaveAttribute('data-last', 'pen');
  // With Snap to shape, a circle drawn by hand becomes an ellipse, a
  // straight stroke a line, and a box a rectangle.
  await view.getByRole('button', { name: 'Snap to shape' }).click();
  await stroke(
    Array.from({ length: 33 }, (_, index) => [
      570 + 44 * Math.cos((index / 32) * Math.PI * 2) + (index % 3),
      300 + 32 * Math.sin((index / 32) * Math.PI * 2),
    ]),
  );
  await expect(paper).toHaveAttribute('data-last', 'ellipse');
  await stroke(Array.from({ length: 12 }, (_, index) => [520 + index * 10, 360 + (index % 2)]));
  await expect(paper).toHaveAttribute('data-last', 'line');
  const corners = [
    [520, 390],
    [620, 389],
    [621, 430],
    [519, 431],
  ];
  await stroke([
    ...corners.flatMap(([x, y], index) => {
      const [nextX, nextY] = corners[(index + 1) % 4];
      return Array.from({ length: 10 }, (_, step) => [
        x + ((nextX - x) * step) / 10,
        y + ((nextY - y) * step) / 10 + (step % 2),
      ]);
    }),
    [520, 392],
  ]);
  await expect(paper).toHaveAttribute('data-last', 'rectangle');
  await expect(paper).toHaveAttribute('data-strokes', '8');
  await view.getByRole('button', { name: 'Snap to shape' }).click();
  // The highlighter, in another colour and size.
  await rail.getByRole('button', { name: 'Highlighter' }).click();
  await rail.getByRole('button', { name: 'Colour' }).click();
  await sketching
    .getByRole('menu', { name: 'Colour' })
    .getByRole('menuitemradio', { name: '#7ae571' })
    .click();
  await rail.getByRole('button', { name: 'Pen size' }).click();
  await sketching
    .getByRole('menu', { name: 'Pen size' })
    .getByRole('menuitemradio', { name: 'Size 02' })
    .click();
  await stroke([
    [300, 420],
    [360, 420],
    [420, 420],
  ]);
  await expect(paper).toHaveAttribute('data-last', 'highlighter');
  await expect(paper).toHaveAttribute('data-strokes', '9');
  // The eraser takes a whole stroke; Undo brings it back.
  await rail.getByRole('button', { name: 'Eraser: removes a stroke' }).click();
  await sketching.mouse.click(...(await onPaper(390, 330)));
  await expect(paper).toHaveAttribute('data-strokes', '8');
  expect(await inkAt(390, 330)).toBe('255,255,255');
  await view.getByRole('button', { name: 'Undo' }).click();
  await expect(paper).toHaveAttribute('data-strokes', '9');
  expect(await inkAt(390, 330)).toBe('91,26,123');
  await view.getByRole('button', { name: 'Redo' }).click();
  await expect(paper).toHaveAttribute('data-strokes', '8');
  // Strokes inside a box are selected, moved together, and removed together.
  await rail.getByRole('button', { name: 'Select and move strokes' }).click();
  await stroke([
    [280, 232],
    [350, 280],
    [440, 310],
  ]);
  await expect(paper).toHaveAttribute('data-selected', '1');
  await stroke([
    [360, 240],
    [380, 250],
    [400, 260],
  ]);
  await expect(paper).toHaveAttribute('data-strokes', '8');
  await expect.poll(() => inkAt(340, 290)).toBe('234,70,67');
  expect(await inkAt(300, 250)).toBe('255,255,255');
  // What is selected is made larger by a corner; the opposite corner stays.
  const selectionBox = async () => (await paper.getAttribute('data-selection')).split(',').map(Number);
  const [left, top, right, bottom] = await selectionBox();
  const zoomNow = Number((await paper.getAttribute('data-view')).split(',')[2]);
  const margin = 5 / zoomNow;
  await sketching.screenshot({ path: 'test-results/bever-sketch-selection.png', fullPage: true });
  await stroke([
    [right + margin, bottom + margin],
    [right + (right - left) * 0.25, bottom + (bottom - top) * 0.25],
    [left + (right - left) * 1.5 + margin, top + (bottom - top) * 1.5 + margin],
  ]);
  const larger = await selectionBox();
  expect(Math.abs(larger[0] - left)).toBeLessThanOrEqual(1);
  expect(Math.abs(larger[1] - top)).toBeLessThanOrEqual(1);
  expect((larger[2] - larger[0]) / (right - left)).toBeGreaterThan(1.4);
  expect((larger[2] - larger[0]) / (right - left)).toBeLessThan(1.55);
  expect(
    Math.abs((larger[2] - larger[0]) / (larger[3] - larger[1]) - (right - left) / (bottom - top)),
  ).toBeLessThan(0.05);
  await expect(paper).toHaveAttribute('data-strokes', '8');
  // A colour and a size chosen now are given to it.
  const inkBefore = await paper.getAttribute('data-selected-ink');
  expect(inkBefore.startsWith('#ea4643,')).toBe(true);
  await rail.getByRole('button', { name: 'Colour' }).click();
  await sketching
    .getByRole('menu', { name: 'Colour' })
    .getByRole('menuitemradio', { name: '#7ae571' })
    .click();
  await expect
    .poll(async () => (await paper.getAttribute('data-selected-ink')).split(',')[0])
    .toBe('#7ae571');
  await rail.getByRole('button', { name: 'Pen size' }).click();
  await sketching
    .getByRole('menu', { name: 'Pen size' })
    .getByRole('menuitemradio', { name: 'Size 07' })
    .click();
  await expect(paper).toHaveAttribute('data-selected-ink', '#7ae571,6');
  await expect(paper).toHaveAttribute('data-selected', '1');
  await sketching.screenshot({ path: 'test-results/bever-sketch-selection-changed.png', fullPage: true });
  // Each of the three is one step to undo; undoing lets go of the selection.
  for (let step = 0; step < 3; step += 1) await view.getByRole('button', { name: 'Undo' }).click();
  await expect(paper).toHaveAttribute('data-selected', '0');
  await expect(paper).toHaveAttribute('data-strokes', '8');
  await expect.poll(() => inkAt(340, 290)).toBe('234,70,67');
  await stroke([
    [500, 380],
    [560, 400],
    [640, 440],
  ]);
  await expect(paper).toHaveAttribute('data-selected', '1');
  // The selected stroke is removed by the button on the rail, which a
  // phone has in place of a Delete key, and by the key.
  const removeStrokes = rail.getByRole('button', { name: 'Remove selected' });
  await expect(removeStrokes).toBeEnabled();
  await removeStrokes.click();
  await expect(paper).toHaveAttribute('data-strokes', '7');
  await expect(removeStrokes).toBeDisabled();
  await view.getByRole('button', { name: 'Undo' }).click();
  await expect(paper).toHaveAttribute('data-strokes', '8');
  await stroke([
    [500, 380],
    [560, 400],
    [640, 440],
  ]);
  await expect(paper).toHaveAttribute('data-selected', '1');
  await sketching.keyboard.press('Delete');
  await expect(paper).toHaveAttribute('data-strokes', '7');
  // The view: zoom, the whole sketch, and the size it was drawn at.
  await expect(view.getByLabel('Zoom', { exact: true })).toHaveText('100%');
  await view.getByRole('button', { name: 'Zoom in' }).click();
  await expect(view.getByLabel('Zoom', { exact: true })).toHaveText('125%');
  await view.getByRole('button', { name: 'Fit to window' }).click();
  await expect(view.getByLabel('Zoom', { exact: true })).not.toHaveText('125%');
  expect(await inkAt(340, 290)).toBe('234,70,67');
  await view.getByRole('button', { name: 'Reset zoom' }).click();
  await expect(view.getByLabel('Zoom', { exact: true })).toHaveText('100%');
  // The paper: its colour, its pattern, and whether the pattern is saved.
  await view.getByRole('button', { name: 'Background colour' }).click();
  await sketching
    .getByRole('menu', { name: 'Background colour' })
    .getByRole('menuitemradio', { name: '#ffef9e' })
    .click();
  await view.getByRole('button', { name: 'Background pattern' }).click();
  const patterns = sketching.getByRole('menu', { name: 'Background pattern' });
  await expect(patterns.getByRole('menuitemradio', { name: 'Lines', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await patterns.getByRole('menuitemradio', { name: 'Grid', exact: true }).click();
  await patterns.getByLabel('Save sketch with pattern').check();
  await expect(paper).toHaveAttribute('data-paper', '#ffef9e,2,true');
  await sketching.screenshot({ path: 'test-results/bever-sketch-edited.png', fullPage: true });
  await sketchDialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(sketchDialog).toHaveCount(0);
  // The note shows the new picture, which is wider now that there is more on it.
  await expect.poll(() => sketchPicture.getAttribute('src')).not.toBe(sketchSource);
  await expect.poll(() => sketchPicture.evaluate((image) => image.naturalWidth)).toBeGreaterThan(sketchWidth);
  await expect(sketching.getByText('Saved locally', { exact: true })).toBeVisible({ timeout: 10000 });
  await sketching.screenshot({ path: 'test-results/bever-sketch-note.png', fullPage: true });

  // Opened again, every stroke is still a stroke, and the paper is as it was left.
  await openSketch();
  await expect(paper).toHaveAttribute('data-strokes', '7');
  await expect(paper).toHaveAttribute('data-paper', '#ffef9e,2,true');
  expect(await inkAt(340, 290)).toBe('234,70,67');
  const savedSketch = await sketchPicture.getAttribute('src');
  await sketchDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(sketchDialog).toHaveCount(0);
  expect(await sketchPicture.getAttribute('src')).toBe(savedSketch);

  // A new sketch is begun from the toolbar, on empty paper, and cannot be
  // kept while nothing is drawn on it.
  const notePictures = sketching.locator('.note-prose .attachment-image img');
  const picturesBefore = await notePictures.count();
  await sketching.locator('.note-prose').getByText('Text after it.').click();
  await sketching.getByRole('button', { name: 'New sketch', exact: true }).click();
  const newSketch = sketching.getByRole('dialog', { name: 'Sketch New sketch' });
  await expect(newSketch).toBeVisible();
  await expect(paper).toHaveAttribute('data-strokes', '0');
  await expect(newSketch.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  // A pen that says how hard it is pressed draws a thin line where it
  // barely touches and a thick one where it is pressed, as in Evernote.
  const penSession = await sketching.context().newCDPSession(sketching);
  const pen = (type, x, y, force) =>
    penSession.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
      pointerType: 'pen',
      force,
    });
  const [penX, penY] = await onPaper(200, 200);
  await pen('mousePressed', penX, penY, 0.05);
  for (let step = 1; step <= 40; step += 1) {
    await pen('mouseMoved', penX + step * 6, penY, step <= 20 ? 0.05 : 0.95);
  }
  await pen('mouseReleased', penX + 240, penY, 0);
  await expect(paper).toHaveAttribute('data-strokes', '1');
  /** How many pixels of ink lie above and below the sketch's point (x, y). */
  const inkHeight = async (x, y) => {
    const box = await paper.boundingBox();
    const [screenX, screenY] = await onPaper(x, y);
    return paper.evaluate(
      (canvas, [left, top]) => {
        const scale = canvas.width / canvas.getBoundingClientRect().width;
        const column = canvas
          .getContext('2d')
          .getImageData(
            Math.round(left * scale),
            Math.round((top - 12) * scale),
            1,
            Math.round(24 * scale),
          ).data;
        let dark = 0;
        for (let index = 0; index < column.length; index += 4) if (column[index] < 128) dark += 1;
        return dark;
      },
      [screenX - box.x, screenY - box.y],
    );
  };
  const lightLine = await inkHeight(260, 200);
  const firmLine = await inkHeight(420, 200);
  expect(lightLine).toBeLessThanOrEqual(2);
  expect(firmLine).toBeGreaterThanOrEqual(lightLine + 2);
  await sketching.screenshot({ path: 'test-results/bever-sketch-new.png', fullPage: true });
  await newSketch.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(newSketch).toHaveCount(0);
  // It is in the note, where the typing was, and opens again as a sketch.
  await expect(notePictures).toHaveCount(picturesBefore + 1);
  await notePictures.last().click();
  await sketching
    .getByRole('toolbar', { name: 'Picture size and placement' })
    .getByRole('button', { name: 'Edit sketch' })
    .click();
  await expect(paper).toHaveAttribute('data-strokes', '1');
  await sketching
    .getByRole('dialog', { name: /^Sketch / })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await sketching.close();

  // On a phone the same editor fits: the tools, the paper, and Done.
  const phoneSketch = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  phoneSketch.on('pageerror', (error) => errors.push(error.message));
  await phoneSketch.goto('http://127.0.0.1:7100/?demoSketch', { waitUntil: 'domcontentloaded' });
  await phoneSketch.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
  await phoneSketch.getByRole('heading', { name: 'A sketch' }).click();
  await phoneSketch.locator('.note-prose .attachment-image img').click();
  await phoneSketch
    .getByRole('toolbar', { name: 'Picture size and placement' })
    .getByRole('button', { name: 'Edit sketch' })
    .click();
  const phonePaper = phoneSketch.getByLabel('Sketch', { exact: true });
  await expect(phonePaper).toHaveAttribute('data-strokes', '4');
  for (const name of [
    'Done',
    'Cancel',
    'Zoom in',
    'Background pattern',
    'Pen',
    'Select and move strokes',
    'Pen size',
  ]) {
    await expect(phoneSketch.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
  }
  expect(await phoneSketch.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect((await phonePaper.boundingBox()).height).toBeGreaterThan(500);
  await phoneSketch.screenshot({ path: 'test-results/bever-sketch-phone.png', fullPage: true });
  await phoneSketch.close();

  // A phone, by touch. The on-screen keyboard is stood in for by a shorter
  // window, which is what the Android shell makes of it.
  const PHONE = { width: 412, height: 915 };
  const PHONE_WITH_KEYBOARD = { width: 412, height: 520 };
  const phoneContext = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });
  const phone = await phoneContext.newPage();
  phone.on('pageerror', (error) => errors.push(error.message));
  phone.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const fingers = await phoneContext.newCDPSession(phone);
  /** A finger drawn across the screen, as the browser itself receives one. */
  const swipe = async ([fromX, fromY], [toX, toY], steps = 8, pause = 16) => {
    await fingers.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: fromX, y: fromY }],
    });
    for (let step = 1; step <= steps; step += 1) {
      await fingers.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: fromX + ((toX - fromX) * step) / steps, y: fromY + ((toY - fromY) * step) / steps },
        ],
      });
      await phone.waitForTimeout(pause);
    }
    await fingers.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await phone.goto('http://127.0.0.1:7100/?demoAnnotated', { waitUntil: 'domcontentloaded' });
  await phone.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
  const drawer = phone.locator('.sidebar');
  const shell = phone.locator('.app-shell');
  const openDrawer = async () => {
    // Once the drawer has slid away and no longer lies over the button.
    await expect.poll(async () => (await drawer.boundingBox()).x).toBeLessThanOrEqual(-300);
    await phone.getByRole('button', { name: 'Open navigation' }).tap();
    await expect(drawer).toHaveClass(/is-open/);
    // And once it has slid in, so that a touch meant for it lands on it.
    await expect.poll(async () => (await drawer.boundingBox()).x).toBeGreaterThanOrEqual(0);
  };
  const historyLayer = () => phone.evaluate(() => window.history.state?.bever ?? null);
  // A touch on the dimmed area closes the drawer and goes no further: the
  // note underneath is not opened by it.
  await openDrawer();
  await phone.touchscreen.tap(380, 500);
  await expect(drawer).not.toHaveClass(/is-open/);
  await phone.waitForTimeout(400);
  await expect(shell).not.toHaveClass(/mobile-has-note/);
  expect(await historyLayer()).toBeNull();
  // So does a swipe that begins on the dimmed area,
  await openDrawer();
  await swipe([380, 500], [200, 500]);
  await expect(drawer).not.toHaveClass(/is-open/);
  // a touch there that wanders up or down,
  await openDrawer();
  await swipe([380, 500], [384, 440]);
  await expect(drawer).not.toHaveClass(/is-open/);
  // and a short, quick flick on the drawer itself. A short, slow one does not.
  await openDrawer();
  await swipe([250, 420], [200, 420], 2, 0);
  await expect(drawer).not.toHaveClass(/is-open/);
  await openDrawer();
  await swipe([250, 420], [200, 420], 30);
  await phone.waitForTimeout(300);
  await expect(drawer).toHaveClass(/is-open/);
  await swipe([250, 420], [60, 420]);
  await expect(drawer).not.toHaveClass(/is-open/);
  expect(await historyLayer()).toBeNull();
  // A swipe from the window's edge opens it; a new note made from it is
  // then shown, and one step back returns to the list of notes.
  await swipe([6, 500], [220, 500]);
  await expect(drawer).toHaveClass(/is-open/);
  // The tap that follows a swipe at once is not lost: the swipe leaves the
  // browser no fling for the tap to be spent on.
  await phone.locator('.new-note-button').tap();
  await expect(shell).toHaveClass(/mobile-has-note/);
  await expect(drawer).not.toHaveClass(/is-open/);
  await phone.evaluate(() => window.history.back());
  await expect(shell).not.toHaveClass(/mobile-has-note/);
  expect(await historyLayer()).toBeNull();

  // The keyboard opening under a long note: where the typing goes stays in view.
  await phone.getByRole('heading', { name: 'Welcome to Bever' }).tap();
  await expect(shell).toHaveClass(/mobile-has-note/);
  await phone.locator('.note-prose').evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    element.focus();
  });
  const caretBottom = () =>
    phone.evaluate(() => {
      const range = window.getSelection()?.getRangeAt(0);
      const box = range?.getClientRects()[0] ?? range?.startContainer.parentElement?.getBoundingClientRect();
      return box ? box.bottom : Number.POSITIVE_INFINITY;
    });
  expect(await caretBottom()).toBeGreaterThan(PHONE_WITH_KEYBOARD.height);
  await phone.setViewportSize(PHONE_WITH_KEYBOARD);
  await expect.poll(caretBottom).toBeLessThanOrEqual(PHONE_WITH_KEYBOARD.height);
  await phone.screenshot({ path: 'test-results/bever-phone-keyboard.png' });
  await phone.setViewportSize(PHONE);
  await phone.evaluate(() => window.history.back());
  await expect(shell).not.toHaveClass(/mobile-has-note/);

  // Text on a picture: when the keyboard opens the picture moves up, and the
  // field that is typed into stays on its place in the picture.
  await phone.getByRole('heading', { name: 'A picture with annotations' }).tap();
  await phone.locator('.note-prose .attachment-image img').tap();
  await phone
    .getByRole('toolbar', { name: 'Picture size and placement' })
    .getByRole('button', { name: 'Annotate' })
    .tap();
  const phonePicture = phone.getByLabel('Picture to annotate');
  await expect(phonePicture).toBeVisible();
  const phoneTools = phone.getByRole('toolbar', { name: 'Annotation tools' });
  await expect(phoneTools.getByRole('button', { name: 'Remove selected' })).toBeInViewport({ ratio: 1 });
  await phoneTools.getByRole('button', { name: 'Text', exact: true }).tap();
  const marksBefore = Number(await phonePicture.getAttribute('data-marks'));
  const pictureBefore = await phonePicture.boundingBox();
  await phone.touchscreen.tap(
    pictureBefore.x + pictureBefore.width * 0.3,
    pictureBefore.y + pictureBefore.height * 0.6,
  );
  const phoneField = phone.getByLabel('Text on the picture');
  await expect(phoneField).toBeFocused();
  await phone.setViewportSize(PHONE_WITH_KEYBOARD);
  await expect.poll(async () => (await phonePicture.boundingBox()).y).toBeLessThan(pictureBefore.y - 50);
  /** How far the field is from three tenths across the picture and six tenths down it. */
  const fieldOffPlace = async () => {
    const picture = await phonePicture.boundingBox();
    const field = await phoneField.boundingBox();
    return Math.max(
      Math.abs((field.x - picture.x) / picture.width - 0.3),
      Math.abs((field.y - picture.y) / picture.height - 0.6),
    );
  };
  await expect.poll(fieldOffPlace).toBeLessThan(0.02);
  await checkFullyInViewport(phone, phonePicture);
  await phoneField.pressSequentially('here');
  await phone.screenshot({ path: 'test-results/bever-phone-annotator-keyboard.png' });
  await phoneField.press('Enter');
  await expect(phonePicture).toHaveAttribute('data-marks', String(marksBefore + 1));
  // The keyboard closing moves the picture back; a field opened then is in its place too.
  await phone.setViewportSize(PHONE);
  await expect.poll(async () => (await phonePicture.boundingBox()).y).toBeGreaterThan(pictureBefore.y - 50);
  await phone.getByRole('button', { name: 'Cancel', exact: true }).tap();
  await expect(phone.getByRole('dialog', { name: /^Annotate / })).toHaveCount(0);
  // A list far longer than the window, on a phone: a handle appears at its
  // edge while it moves, and dragged to the bottom shows the last note.
  const longPhone = await phoneContext.newPage();
  longPhone.on('pageerror', (error) => errors.push(error.message));
  await longPhone.goto('http://127.0.0.1:7100/?demoMany=1500', { waitUntil: 'domcontentloaded' });
  await longPhone.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
  const phoneList = longPhone.locator('.note-list');
  await expect(longPhone.locator('.list-scroller')).toHaveCount(1);
  await expect(longPhone.locator('.list-scroller.showing')).toHaveCount(0);
  const longFingers = await phoneContext.newCDPSession(longPhone);
  const drag = async ([fromX, fromY], [toX, toY], steps = 10) => {
    await longFingers.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: fromX, y: fromY }],
    });
    for (let step = 1; step <= steps; step += 1) {
      await longFingers.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: fromX + ((toX - fromX) * step) / steps, y: fromY + ((toY - fromY) * step) / steps },
        ],
      });
      await longPhone.waitForTimeout(16);
    }
    await longFingers.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  // Scrolling with a finger shows the handle; it goes again when the list rests.
  await drag([200, 700], [200, 300]);
  await expect(longPhone.locator('.list-scroller.showing')).toHaveCount(1);
  const listHandle = await longPhone.locator('.list-scroller').boundingBox();
  const listBox = await phoneList.boundingBox();
  // Taken by the handle and drawn to the bottom of the list.
  await drag(
    [listHandle.x + listHandle.width - 6, listHandle.y + listHandle.height / 2],
    [listHandle.x + listHandle.width - 6, listBox.y + listBox.height + 40],
    14,
  );
  await expect(longPhone.getByRole('heading', { name: 'Many 1500', exact: true })).toBeVisible();
  expect(
    await phoneList.evaluate((list) => list.scrollTop + list.clientHeight >= list.scrollHeight - 2),
  ).toBe(true);
  await longPhone.screenshot({ path: 'test-results/bever-phone-list-handle.png' });
  await expect(longPhone.locator('.list-scroller.showing')).toHaveCount(0, { timeout: 5000 });
  // The handle does not keep a tap from the note under where it was.
  await longPhone.getByRole('heading', { name: 'Many 1500', exact: true }).tap();
  await expect(longPhone.getByLabel('Note title')).toHaveValue('Many 1500');
  await longPhone.close();
  await phoneContext.close();

  // A list far longer than the window, with a mouse: the scroll bar is that
  // of the whole list from the beginning. Moved to the end it shows the last
  // note, and the list is no longer than before; what was passed over is
  // not loaded.
  const long = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  long.on('pageerror', (error) => errors.push(error.message));
  long.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await long.goto('http://127.0.0.1:7100/?demoMany=1500', { waitUntil: 'domcontentloaded' });
  await long.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
  await expect(long.locator('.notes-header h1')).toContainText('1,503');
  const longList = long.locator('.note-list');
  const heightAtFirst = await longList.evaluate((list) => list.scrollHeight);
  expect(heightAtFirst).toBeGreaterThan(1503 * 130);
  await expect(long.locator('.list-scroller')).toHaveCount(0);
  await longList.evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  await expect(long.getByRole('heading', { name: 'Many 1500', exact: true })).toBeVisible();
  expect(await longList.evaluate((list) => list.scrollHeight)).toBe(heightAtFirst);
  // The middle of the list is places without notes until it is looked at.
  await longList.evaluate((list) => {
    list.scrollTop = list.scrollHeight / 2;
  });
  await expect(long.locator('.note-card.placeholder').first()).toBeVisible();
  await expect(long.getByRole('heading', { name: /^Many 07\d\d$/ }).first()).toBeVisible();
  await expect(long.locator('.note-card.placeholder')).toHaveCount(0);
  // The screen of notebooks lies over the open note and all of it, the
  // note's toolbar too.
  await long
    .getByRole('heading', { name: /^Many 07\d\d$/ })
    .first()
    .click();
  await expect(long.locator('.editor-toolbar')).toBeVisible();
  await long.locator('.sidebar').getByRole('button', { name: 'Notebooks', exact: true }).click();
  await expect(long.getByRole('region', { name: 'Notebooks', exact: true })).toBeVisible();
  await expect(long.locator('.editor-toolbar')).toBeHidden();
  await expect(long.locator('.note-card').first()).toBeHidden();
  await long.screenshot({ path: 'test-results/bever-notebooks-over-note.png', fullPage: true });
  await long.keyboard.press('Escape');
  await expect(long.locator('.editor-toolbar')).toBeVisible();
  // A search that finds nothing says so, and one that finds something
  // shows it in place of what was there.
  await long.getByLabel('Search notes').fill('Many 0042');
  await expect(long.locator('.note-card')).toHaveCount(1);
  await expect(long.locator('.notes-header h1')).toContainText('1');
  await long.getByLabel('Search notes').fill('nothing-like-this');
  await expect(long.getByRole('heading', { name: 'No notes here' })).toBeVisible();
  await long.screenshot({ path: 'test-results/bever-long-list.png', fullPage: true });
  await long.close();

  {
    // A note is stored anew only when it was changed. Placing and moving the
    // cursor, a letter typed and taken away again, and a space at the end of a
    // line leave it as it is, to its date. What can be seen is a change.
    const careful = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    careful.on('pageerror', (error) => errors.push(error.message));
    careful.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await careful.goto('http://127.0.0.1:7100', { waitUntil: 'domcontentloaded' });
    await careful.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
    await careful.locator('.note-list').getByRole('heading', { name: 'Bring your notes along' }).click();
    const changedAt = () => careful.locator('.note-identity time').getAttribute('datetime');
    const savedCount = () => careful.evaluate(() => window.__beverDemoSaves ?? 0);
    const storedAt = await changedAt();
    expect(await savedCount()).toBe(0);
    await careful.locator('.note-prose p').first().click();
    for (const key of [
      'ArrowRight',
      'ArrowRight',
      'ArrowDown',
      'End',
      'Home',
      'Shift+ArrowRight',
      'Control+End',
    ]) {
      await careful.keyboard.press(key);
    }
    await careful.keyboard.type('x');
    await careful.keyboard.press('Backspace');
    await careful.keyboard.type('  ');
    await careful.waitForTimeout(1600);
    expect(await savedCount()).toBe(0);
    expect(await changedAt()).toBe(storedAt);
    await expect(careful.getByText('Saved locally', { exact: true })).toBeVisible();
    // The same for a title typed again as it was, and a tag added and removed.
    await careful.getByLabel('Note title').fill('Bring your notes along!');
    await careful.getByLabel('Note title').fill('Bring your notes along');
    await careful.waitForTimeout(1200);
    expect(await savedCount()).toBe(0);
    // A letter that stays is a change, and is stored.
    await careful.locator('.note-prose p').first().click();
    await careful.keyboard.type('!');
    await expect.poll(savedCount, { timeout: 10000 }).toBe(1);
    await expect.poll(changedAt).not.toBe(storedAt);

    // A note is pinned to the top of its notebook, which is said about it and
    // not written in it: its date stays.
    await careful.locator('.notebook-row', { hasText: 'Reading' }).locator('.tree-row').click();
    const listed = careful.locator('.note-list .note-card h2');
    await expect(listed).toHaveText(['Bring your notes along', 'Local attachment preview']);
    await careful.locator('.note-list').getByRole('heading', { name: 'Local attachment preview' }).click();
    await expect(careful.getByLabel('Note title')).toHaveValue('Local attachment preview');
    const pinnedAt = await changedAt();
    await careful.getByRole('button', { name: 'Pin to notebook' }).click();
    await expect(careful.getByText('1 note pinned to the top of its notebook.')).toBeVisible();
    await expect(listed).toHaveText(['Local attachment preview', 'Bring your notes along']);
    await expect(careful.locator('.note-card').first()).toHaveClass(/pinned/);
    await expect(careful.locator('.note-card').first().locator('.pinned-mark')).toBeVisible();
    await expect(careful.getByRole('button', { name: 'Unpin from notebook' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await changedAt()).toBe(pinnedAt);
    await careful.screenshot({ path: 'test-results/bever-pinned.png', fullPage: true });
    // Among all notes it is where its date puts it, and shown as pinned.
    await careful
      .locator('.primary-nav')
      .getByRole('button', { name: /All notes/ })
      .click();
    await expect(listed.last()).toHaveText('Local attachment preview');
    await expect(careful.locator('.note-card.pinned')).toHaveCount(1);
    // Several are pinned, and taken down, together.
    await careful.getByLabel('Select Welcome to Bever').check();
    await careful.getByLabel('Select Bring your notes along').check();
    const selection = careful.getByRole('toolbar', { name: 'Selected note actions' });
    await selection.getByRole('button', { name: 'Pin', exact: true }).click();
    await expect(careful.getByText('2 notes pinned to the top of their notebooks.')).toBeVisible();
    await expect(careful.locator('.note-card.pinned')).toHaveCount(3);
    await selection.getByRole('button', { name: 'Unpin', exact: true }).click();
    await expect(careful.getByText('2 notes no longer pinned.')).toBeVisible();
    await expect(careful.locator('.note-card.pinned')).toHaveCount(1);
    await selection.getByRole('button', { name: 'Clear note selection' }).click();
    // In the note's information too, which is where a phone has it.
    await careful.getByRole('button', { name: 'Note information' }).click();
    const pinnedBox = careful.getByRole('checkbox', { name: 'Pinned to the top of its notebook' });
    await expect(pinnedBox).toBeChecked();
    await pinnedBox.uncheck();
    await expect(careful.locator('.note-card.pinned')).toHaveCount(0);
    await expect(careful.getByRole('button', { name: 'Pin to notebook' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await careful.getByRole('button', { name: 'Close note information' }).click();

    // With Ctrl and the wheel the note is made larger, as a page of a PDF is:
    // its lines stay as they are.
    const wideLine = careful.locator('.note-prose p').first();
    const narrow = await wideLine.boundingBox();
    await careful.mouse.move(narrow.x + 40, narrow.y + 8);
    await careful.keyboard.down('Control');
    await careful.mouse.wheel(0, -240);
    await careful.keyboard.up('Control');
    const zoomFrame = careful.locator('.note-zoom');
    await expect(zoomFrame).toHaveClass(/zoomed/);
    const wheelZoom = Number(
      await zoomFrame.evaluate((element) => getComputedStyle(element).getPropertyValue('--note-zoom')),
    );
    expect(wheelZoom).toBeGreaterThan(1.5);
    const wide = await wideLine.boundingBox();
    expect(wide.height / narrow.height).toBeCloseTo(wheelZoom, 1);
    await expect(careful.locator('.zoom-chip')).toContainText(`${Math.round(wheelZoom * 100)}%`);
    await careful.screenshot({ path: 'test-results/bever-zoomed.png', fullPage: true });
    await careful.locator('.zoom-chip').click();
    await expect(zoomFrame).not.toHaveClass(/zoomed/);
    expect((await wideLine.boundingBox()).height).toBeCloseTo(narrow.height, 0);
    // Making a note larger to look at is no change of it.
    expect(await savedCount()).toBe(1);
    await careful.close();

    // A note's thumbnail is taken away, and brought back.
    const plain = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    plain.on('pageerror', (error) => errors.push(error.message));
    plain.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await plain.goto('http://127.0.0.1:7100/?demoImages', { waitUntil: 'domcontentloaded' });
    await plain.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
    const withPictures = plain.locator('.note-card', { hasText: 'Domain and range, with pictures' });
    await expect(withPictures.locator('img.note-thumbnail')).toHaveCount(1);
    await withPictures.getByRole('button', { name: /^Open note/ }).click();
    const shownAt = await plain.locator('.note-identity time').getAttribute('datetime');
    await plain.getByRole('button', { name: 'Note information' }).click();
    const thumbnailSelect = plain.getByLabel('Thumbnail in the list of notes');
    await expect(thumbnailSelect).toHaveValue('automatic');
    await thumbnailSelect.selectOption('none');
    await expect(plain.getByText('The list of notes now shows this note without a picture.')).toBeVisible();
    await expect(withPictures.locator('img.note-thumbnail')).toHaveCount(0);
    await expect(thumbnailSelect).toHaveValue('none');
    // Said about the note, not written in it.
    expect(await plain.locator('.note-identity time').getAttribute('datetime')).toBe(shownAt);
    await plain.screenshot({ path: 'test-results/bever-thumbnail-none.png', fullPage: true });
    await thumbnailSelect.selectOption('automatic');
    await expect(withPictures.locator('img.note-thumbnail')).toHaveCount(1);
    await plain.close();

    // On a phone, two fingers spread on a note make it larger. Nothing is
    // wrapped anew; what does not fit is reached by moving the note.
    const phoneWithTouch = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const zooming = await phoneWithTouch.newPage();
    zooming.on('pageerror', (error) => errors.push(error.message));
    zooming.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await zooming.goto('http://127.0.0.1:7100', { waitUntil: 'domcontentloaded' });
    await zooming.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
    await zooming.locator('.note-list').getByRole('heading', { name: 'Welcome to Bever' }).tap();
    const paragraph = zooming.locator('.note-prose p').first();
    await expect(paragraph).toBeVisible();
    await zooming.locator('.editor-panel').evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    const small = await paragraph.boundingBox();
    const titleWidth = (await zooming.getByLabel('Note title').boundingBox()).width;
    const touch = await phoneWithTouch.newCDPSession(zooming);
    const fingers = (type, points) =>
      touch.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map(([x, y], id) => ({ x: Math.round(x), y: Math.round(y), id })),
      });
    const middle = { x: small.x + small.width / 2, y: small.y + small.height / 2 };
    await fingers('touchStart', [
      [middle.x - 30, middle.y],
      [middle.x + 30, middle.y],
    ]);
    for (let spread = 40; spread <= 90; spread += 10) {
      await fingers('touchMove', [
        [middle.x - spread, middle.y],
        [middle.x + spread, middle.y],
      ]);
      await zooming.waitForTimeout(40);
    }
    await fingers('touchEnd', []);
    const phoneFrame = zooming.locator('.note-zoom');
    await expect(phoneFrame).toHaveClass(/zoomed/);
    const pinched = Number(
      await phoneFrame.evaluate((element) => getComputedStyle(element).getPropertyValue('--note-zoom')),
    );
    // The fingers went from 60 apart to 180.
    expect(pinched).toBeGreaterThan(2.6);
    expect(pinched).toBeLessThanOrEqual(3.05);
    const large = await paragraph.boundingBox();
    // Larger by as much each way: the lines are the lines they were.
    expect(large.height / small.height).toBeCloseTo(pinched, 1);
    expect(large.width / small.width).toBeCloseTo(pinched, 1);
    expect(await phoneFrame.evaluate((element) => element.scrollWidth > element.clientWidth + 20)).toBe(true);
    // What was between the fingers is still between them, sideways.
    expect(Math.abs(large.x + (middle.x - small.x) * pinched - middle.x)).toBeLessThan(4);
    // The note is larger, not the window, and not what stands around the note.
    expect(await zooming.evaluate(() => window.visualViewport.scale)).toBe(1);
    expect((await zooming.getByLabel('Note title').boundingBox()).width).toBeCloseTo(titleWidth, 0);
    await zooming.screenshot({ path: 'test-results/bever-mobile-zoomed.png' });
    // It is moved sideways with a finger, and brought back to its own size.
    await phoneFrame.evaluate((element) => {
      element.scrollLeft = 120;
    });
    expect(await phoneFrame.evaluate((element) => element.scrollLeft)).toBe(120);
    await zooming.locator('.zoom-chip').tap();
    await expect(phoneFrame).not.toHaveClass(/zoomed/);
    expect((await paragraph.boundingBox()).width).toBeCloseTo(small.width, 0);
    // Fingers brought together again make it no smaller than it is.
    await fingers('touchStart', [
      [middle.x - 90, middle.y],
      [middle.x + 90, middle.y],
    ]);
    await fingers('touchMove', [
      [middle.x - 30, middle.y],
      [middle.x + 30, middle.y],
    ]);
    await zooming.waitForTimeout(60);
    await fingers('touchEnd', []);
    await expect(phoneFrame).not.toHaveClass(/zoomed/);
    await phoneWithTouch.close();
  }

  // A synchronization that only pretends (?demoSync): a run can be stopped
  // where it was started, says how it ended, and is in the record of runs.
  const syncing = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  syncing.on('pageerror', (error) => errors.push(error.message));
  syncing.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await syncing.goto('http://127.0.0.1:7100/?demoSync', { waitUntil: 'domcontentloaded' });
  await syncing.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
  await syncing.getByRole('button', { name: 'Settings & sync' }).click();
  const syncSettings = syncing.getByRole('dialog', { name: 'Settings' });
  const syncNow = syncSettings.getByRole('button', { name: 'Sync now', exact: true });
  const stop = syncSettings.getByRole('button', { name: 'Stop', exact: true });
  await expect(syncNow).toBeEnabled();
  await expect(stop).toHaveCount(0);
  // The record is open by itself, because the latest run held a note back.
  const runs = syncSettings.locator('.sync-runs');
  await expect(runs.locator('summary')).toHaveText('Recent runs');
  await expect(runs.locator('li')).toHaveCount(4);
  await expect(runs.locator('li').nth(0)).toBeVisible();
  await expect(runs.locator('li').nth(0)).toContainText('Completed in 95:00; 1 note held back');
  await expect(runs.locator('li').nth(0)).toContainText(
    '↑ 4,831 notes, 7,785 attachments, 6.2 GB · 3 requests repeated, 1 of them because the storage service asked for fewer',
  );
  await expect(runs.locator('li').nth(1)).toContainText(
    'Failed after 17:00: No connection to the storage service; this device may be offline (No such host is known. (os error 11001))',
  );
  await expect(runs.locator('li').nth(2)).toContainText(
    'Did not finish; last seen at work after 12:00: Bever was closed, or the device slept or was turned off, while it ran.',
  );
  await expect(runs.locator('li').nth(3)).toContainText('Stopped after 42.0 s');
  await expect(runs.locator('li.trouble')).toHaveCount(3);
  await syncing.screenshot({ path: 'test-results/bever-sync-runs.png', fullPage: true });

  // A run is started, and stopped while it goes.
  await syncNow.click();
  await expect(stop).toBeVisible();
  await expect(syncSettings.getByRole('button', { name: 'Synchronizing…' })).toBeDisabled();
  await expect(syncSettings.locator('.sync-progress')).toContainText(/Uploading notes \(\d+ of 40\)/);
  // The record stays open, with the run that is going at its head.
  await expect(runs.locator('li').first()).toBeVisible();
  await expect(runs.locator('li').first()).toContainText('Running');
  await syncing.screenshot({ path: 'test-results/bever-sync-running.png', fullPage: true });
  await stop.click();
  await expect(syncSettings.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
  await expect(syncSettings.locator('.sync-progress')).toContainText('Stopping synchronization…');
  await expect(
    syncSettings.getByText(/Synchronization stopped after .* What was transferred is kept/),
  ).toBeVisible();
  await expect(stop).toHaveCount(0);
  await expect(syncNow).toBeEnabled();
  // Stopping is nobody's failure.
  await expect(syncSettings.locator('.sync-message.error')).toHaveCount(0);
  await expect(runs.locator('li')).toHaveCount(5);
  await expect(runs.locator('li').first()).toContainText('Stopped after');
  await expect(runs.locator('li').first()).not.toHaveClass(/trouble/);
  await syncing.screenshot({ path: 'test-results/bever-sync-stopped.png', fullPage: true });

  // On a phone Stop is within reach beside the run; and a run that is left
  // to itself ends, and says what it moved.
  await syncing.setViewportSize({ width: 390, height: 844 });
  await syncNow.scrollIntoViewIfNeeded();
  await syncNow.click();
  await expect(stop).toBeVisible();
  await stop.scrollIntoViewIfNeeded();
  await checkFullyInViewport(syncing, stop);
  await syncing.screenshot({ path: 'test-results/bever-mobile-sync-running.png', fullPage: true });
  await expect(syncSettings.getByText(/Sync complete in/)).toBeVisible({ timeout: 30000 });
  await expect(syncSettings.getByText('40 notes uploaded', { exact: false })).toBeVisible();
  await expect(stop).toHaveCount(0);
  await expect(runs.locator('li').first()).toContainText('Completed in');
  await expect(runs.locator('li').first()).toContainText('↑ 40 notes, 0 attachments');
  await syncing.close();

  // Importing from the Evernote application on this computer: the source is
  // asked for, the notebooks are shown by stack, and any of them can be left out.
  const importing = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  importing.on('pageerror', (error) => errors.push(error.message));
  importing.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await importing.goto('http://127.0.0.1:7100/?demoEvernote', { waitUntil: 'domcontentloaded' });
  await importing.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
  await importing.getByRole('button', { name: 'Import notes' }).click();
  const sources = importing.getByRole('dialog', { name: 'Import notes', exact: true });
  await expect(sources.getByRole('button', { name: /ENEX files/ })).toBeVisible();
  await importing.screenshot({ path: 'test-results/bever-import-source.png', fullPage: true });
  await sources.getByRole('button', { name: /Evernote on this computer/ }).click();
  const fromEvernote = importing.getByRole('dialog', { name: 'Import from Evernote on this computer' });
  const list = fromEvernote.getByRole('group', { name: 'Notebooks to import' });
  // Every notebook that has notes is chosen to begin with; an empty one is not.
  await expect(list.getByRole('checkbox', { name: /^Astronomy/ })).toBeChecked();
  await expect(list.getByRole('checkbox', { name: /^Empty notebook/ })).not.toBeChecked();
  await expect(fromEvernote.getByRole('button', { name: 'Import 4 notebooks' })).toBeEnabled();
  await expect(fromEvernote).toContainText('4 notebooks, 377 notes');
  // What Evernote does not have whole is said before anything is imported,
  // and the notes are named: Evernote does not say which they are.
  await expect(fromEvernote).toContainText('2 notes cannot be imported whole');
  await expect(fromEvernote).toContainText('Open each of them in Evernote while online');
  await expect(list.getByText('2 not downloaded')).toBeVisible();
  const lacking = fromEvernote.getByRole('list', { name: 'Notes Evernote does not have whole' });
  await expect(lacking.getByRole('listitem')).toHaveText([
    /^Sorting networks in Computer science.*2 of 3 attachments missing$/,
    /^Untitled in Computer science.*text missing$/,
  ]);
  // The one that lacks only attachments can be taken without them.
  const withoutMissing = fromEvernote.getByRole('checkbox', { name: /^Import this note now, without/ });
  await expect(withoutMissing).not.toBeChecked();
  await expect(fromEvernote).toContainText('1 note without text cannot be imported');
  // A long name is cut short; the list does not scroll sideways, and the
  // whole dialog is in the window.
  expect(await list.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(fromEvernote.getByRole('button', { name: 'Import 4 notebooks' })).toBeInViewport({ ratio: 1 });
  await expect(
    fromEvernote.getByRole('heading', { name: 'Import from Evernote on this computer' }),
  ).toBeInViewport({
    ratio: 1,
  });
  // A stack takes or leaves all of its notebooks.
  await list.getByRole('checkbox', { name: 'Feeds', exact: true }).uncheck();
  await expect(list.getByRole('checkbox', { name: /^Astronomy/ })).not.toBeChecked();
  await expect(list.getByRole('checkbox', { name: /^Computer science/ })).not.toBeChecked();
  await expect(fromEvernote.getByRole('button', { name: 'Import 2 notebooks' })).toBeEnabled();
  await expect(fromEvernote).not.toContainText('cannot be imported whole');
  await expect(withoutMissing).toHaveCount(0);
  await list.getByRole('checkbox', { name: /^Astronomy/ }).check();
  await expect(list.getByRole('checkbox', { name: 'Feeds', exact: true })).not.toBeChecked();
  // With some chosen, "All notebooks" first takes them all, then none.
  await list.getByRole('checkbox', { name: 'All notebooks' }).click();
  await expect(fromEvernote.getByRole('button', { name: 'Import 6 notebooks' })).toBeEnabled();
  await list.getByRole('checkbox', { name: 'All notebooks' }).click();
  await expect(fromEvernote.getByRole('button', { name: 'Import 0 notebooks' })).toBeDisabled();
  await list.getByRole('checkbox', { name: 'All notebooks' }).click();
  await list.getByRole('checkbox', { name: /^Empty notebook/ }).uncheck();
  await list.getByRole('checkbox', { name: /^A notebook whose name/ }).uncheck();
  await importing.screenshot({ path: 'test-results/bever-import-evernote.png', fullPage: true });
  await fromEvernote.getByRole('button', { name: 'Import 4 notebooks' }).click();
  const finished = importing.getByRole('dialog', { name: 'Import finished' });
  await expect(finished).toContainText('375 notes and 750 attachments imported from 4 notebooks');
  // Importing again is how changes made in Evernote arrive.
  await expect(finished).toContainText('3 notes that were here brought up to what Evernote has');
  // What came as something else, and what was left in Evernote, is said.
  await expect(finished).toContainText('9 tasks in 2 notes brought as checklists');
  await expect(finished).toContainText('5 tags that no note has added');
  await expect(finished.locator('.import-left')).toHaveText(
    'Not brought: 2 notes in Evernote’s trash; 1 shortcut that leads to something Evernote has no more, or that is not in the library.',
  );
  await expect(finished).toContainText('1 note changed both here and in Evernote');
  // The notes that were left out are named in the summary too.
  await expect(finished).toContainText(
    '2 notes were not imported because Evernote does not have all of them on this computer: “Sorting networks” in “Computer science”',
  );
  await importing.screenshot({ path: 'test-results/bever-import-evernote-done.png', fullPage: true });
  await finished.getByRole('button', { name: 'Done' }).click();
  await expect(finished).toHaveCount(0);
  // Asked to, the import takes a note without the attachments that are
  // missing, and says which note that was.
  await importing.getByRole('button', { name: 'Import notes' }).click();
  await sources.getByRole('button', { name: /Evernote on this computer/ }).click();
  await withoutMissing.check();
  await expect(fromEvernote.getByRole('button', { name: 'Import 4 notebooks' })).toBeInViewport({ ratio: 1 });
  await importing.screenshot({ path: 'test-results/bever-import-evernote-incomplete.png', fullPage: true });
  await fromEvernote.getByRole('button', { name: 'Import 4 notebooks' }).click();
  await expect(finished).toContainText('1 note imported without attachments Evernote does not have');
  await expect(finished).toContainText('“Sorting networks” in “Computer science” (2 of 3)');
  await expect(finished).toContainText('1 note was not imported because Evernote does not have all of it');
  await finished.getByRole('button', { name: 'Done' }).click();
  await expect(finished).toHaveCount(0);
  // The other source is still there.
  await importing.getByRole('button', { name: 'Import notes' }).click();
  await expect(sources.getByRole('button', { name: /Evernote on this computer/ })).toBeVisible();
  await importing.keyboard.press('Escape');
  await expect(sources).toHaveCount(0);
  await importing.close();

  // Removing everything from this device, for a clean uninstall: the word
  // has to be typed, and afterwards the library is empty.
  const erasing = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  erasing.on('pageerror', (error) => errors.push(error.message));
  erasing.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await erasing.goto('http://127.0.0.1:7100', { waitUntil: 'domcontentloaded' });
  await erasing.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
  const noteCount = erasing.locator('.notes-header h1 span');
  const notesAtStart = await noteCount.innerText();
  await erasing.getByRole('button', { name: 'New note', exact: false }).first().click();
  await erasing.getByLabel('Note title').fill('A note that will be removed');
  await erasing.getByText('Saved locally', { exact: true }).waitFor({ timeout: 10000 });
  await expect(noteCount).not.toHaveText(notesAtStart);
  await erasing.evaluate(() => localStorage.setItem('bever-theme', 'dark'));
  await erasing.getByRole('button', { name: 'Settings & sync' }).click();
  const removeAll = erasing.getByRole('button', { name: 'Remove all data from this device…' });
  await removeAll.scrollIntoViewIfNeeded();
  await erasing.screenshot({ path: 'test-results/bever-settings-erase.png', fullPage: true });
  await removeAll.click();
  const eraseDialog = erasing.getByRole('dialog', { name: 'Remove all data from this device?' });
  await expect(eraseDialog).toContainText('It cannot be undone.');
  await expect(eraseDialog).toContainText('stay in pCloud');
  await erasing.screenshot({ path: 'test-results/bever-erase-dialog.png', fullPage: true });
  const confirmErase = eraseDialog.getByRole('button', { name: 'Remove everything' });
  // Nothing typed, or the wrong thing typed, removes nothing.
  await confirmErase.click();
  await expect(eraseDialog.getByRole('alert')).toHaveText('Type ERASE to confirm.');
  await eraseDialog.getByLabel('Type ERASE to confirm').fill('erase');
  await confirmErase.click();
  await expect(eraseDialog.getByRole('alert')).toHaveText('Type ERASE, in capital letters, to confirm.');
  await eraseDialog.getByRole('button', { name: 'Cancel', exact: true }).last().click();
  await expect(eraseDialog).toHaveCount(0);
  await erasing.getByRole('button', { name: 'Close settings' }).click();
  await expect(erasing.getByRole('heading', { name: 'A note that will be removed' })).toBeVisible();
  // The word typed: the notes and the preferences are gone.
  await erasing.getByRole('button', { name: 'Settings & sync' }).click();
  await removeAll.click();
  await eraseDialog.getByLabel('Type ERASE to confirm').fill('ERASE');
  await confirmErase.click();
  await expect(erasing.getByRole('heading', { name: 'A note that will be removed' })).toHaveCount(0, {
    timeout: 20000,
  });
  await erasing.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
  await expect(noteCount).toHaveText(notesAtStart);
  expect(await erasing.evaluate(() => localStorage.getItem('bever-theme'))).not.toBe('dark');
  await erasing.close();

  // Going back and forward among the places one has been, as in a browser.
  {
    const ways = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    ways.on('pageerror', (error) => errors.push(error.message));
    ways.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await ways.goto('http://127.0.0.1:7100', { waitUntil: 'domcontentloaded' });
    await ways.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
    const goBack = ways.getByRole('button', { name: 'Back', exact: true });
    const goForward = ways.getByRole('button', { name: 'Forward', exact: true });
    const listed = ways.locator('.notes-header h1');
    const titleField = ways.getByLabel('Note title');
    await expect(goBack).toBeDisabled();
    await expect(goForward).toBeDisabled();
    await ways.getByRole('heading', { name: 'Welcome to Bever', exact: true }).click();
    await expect(titleField).toHaveValue('Welcome to Bever');
    await ways
      .locator('.sidebar')
      .getByRole('button', { name: /^Reading/ })
      .click();
    await expect(listed).toContainText('Reading');
    await ways.getByRole('heading', { name: 'Bring your notes along', exact: true }).click();
    await expect(titleField).toHaveValue('Bring your notes along');
    await expect(goForward).toBeDisabled();
    // Back: the note that was open before, then the list that was, then nothing open.
    await goBack.click();
    await expect(titleField).toHaveValue('Welcome to Bever');
    await expect(listed).toContainText('Reading');
    await goBack.click();
    await expect(listed).toContainText('All notes');
    await expect(titleField).toHaveValue('Welcome to Bever');
    await goBack.click();
    await expect(ways.getByText('A quiet place for your thoughts')).toBeVisible();
    await expect(goBack).toBeDisabled();
    // Forward, by the buttons, the keys, and the buttons of a mouse.
    await goForward.click();
    await expect(titleField).toHaveValue('Welcome to Bever');
    await ways.keyboard.press('Alt+ArrowRight');
    await expect(listed).toContainText('Reading');
    await ways.evaluate(() => window.dispatchEvent(new MouseEvent('mouseup', { button: 4 })));
    await expect(titleField).toHaveValue('Bring your notes along');
    await expect(goForward).toBeDisabled();
    await ways.keyboard.press('Alt+ArrowLeft');
    await expect(titleField).toHaveValue('Welcome to Bever');
    // Going somewhere else from here drops what lay ahead.
    await ways
      .locator('.sidebar')
      .getByRole('button', { name: /^All notes/ })
      .click();
    await expect(listed).toContainText('All notes');
    await expect(goForward).toBeDisabled();
    // A screen is a place too: left, it stays ahead to return to.
    const notebooksScreen = ways.getByRole('region', { name: 'Notebooks', exact: true });
    await ways.locator('.sidebar').getByRole('button', { name: 'Notebooks', exact: true }).click();
    await expect(notebooksScreen).toBeVisible();
    await ways.keyboard.press('Escape');
    await expect(notebooksScreen).toBeHidden();
    await goForward.click();
    await expect(notebooksScreen).toBeVisible();
    await goBack.click();
    await expect(notebooksScreen).toBeHidden();
    // A search that is typed changes the place one is at; it is not many places.
    await ways.getByLabel('Search notes').fill('lossless');
    await expect(ways.locator('.note-card')).toHaveCount(1);
    await ways.getByRole('heading', { name: 'Bring your notes along', exact: true }).click();
    await expect(titleField).toHaveValue('Bring your notes along');
    await goBack.click();
    await expect(ways.getByLabel('Search notes')).toHaveValue('lossless');
    await expect(titleField).toHaveValue('Welcome to Bever');
    await goBack.click();
    await expect(ways.getByLabel('Search notes')).toHaveValue('');
    await ways.screenshot({ path: 'test-results/bever-back-forward.png', fullPage: true });

    // A search kept among the shortcuts, by its words.
    await ways.getByLabel('Search notes').fill('lossless');
    await ways.getByRole('button', { name: 'Add search shortcut' }).click();
    const shortcuts = ways.locator('.sidebar-section').first();
    await expect(shortcuts.getByRole('button', { name: 'lossless', exact: true })).toBeVisible();
    await ways.getByLabel('Clear search').click();
    await expect(ways.locator('.note-card')).not.toHaveCount(1);
    await shortcuts.getByRole('button', { name: 'lossless', exact: true }).click();
    await expect(ways.getByLabel('Search notes')).toHaveValue('lossless');
    await expect(ways.locator('.note-card')).toHaveCount(1);
    await expect(ways.getByRole('button', { name: 'Remove search shortcut' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await ways.getByRole('button', { name: 'Remove search shortcut' }).click();
    await expect(shortcuts.getByRole('button', { name: 'lossless', exact: true })).toHaveCount(0);
    await ways.getByLabel('Clear search').click();

    // A note locked against changes, and changes taken back.
    await ways.getByRole('heading', { name: 'Welcome to Bever', exact: true }).click();
    await expect(ways.locator('.editor-toolbar')).toBeVisible();
    await ways.getByRole('button', { name: 'Lock this note' }).click();
    await expect(ways.getByText('Read-only', { exact: true })).toBeVisible();
    await expect(ways.locator('.editor-toolbar')).toHaveCount(0);
    await expect(titleField).toHaveAttribute('readonly', '');
    await expect(ways.getByLabel('Add a tag')).toHaveCount(0);
    const proseBefore = await ways.locator('.note-prose').innerText();
    await ways.locator('.note-prose').click();
    await ways.keyboard.type('typed by mistake');
    expect(await ways.locator('.note-prose').innerText()).toBe(proseBefore);
    await ways.screenshot({ path: 'test-results/bever-note-locked.png', fullPage: true });
    await ways.getByRole('button', { name: 'Unlock this note' }).click();
    await expect(ways.locator('.editor-toolbar')).toBeVisible();
    const discard = ways.getByRole('button', { name: 'Discard changes' });
    await expect(discard).toHaveCount(0);
    await titleField.fill('Welcome to Bever, spoilt');
    await ways.locator('.note-prose').click();
    await ways.keyboard.type('typed by mistake ');
    await ways.getByText('Saved locally', { exact: true }).waitFor({ timeout: 10000 });
    await expect(ways.getByRole('heading', { name: 'Welcome to Bever, spoilt', exact: true })).toBeVisible();
    await expect(discard).toBeVisible();
    await ways.screenshot({ path: 'test-results/bever-discard-changes.png', fullPage: true });
    await discard.click();
    const question = ways.getByRole('dialog', { name: 'Discard the changes?' });
    await question.getByRole('button', { name: 'Discard changes' }).click();
    await expect(titleField).toHaveValue('Welcome to Bever');
    expect(await ways.locator('.note-prose').innerText()).toBe(proseBefore);
    await expect(ways.getByRole('heading', { name: 'Welcome to Bever', exact: true })).toBeVisible();
    await expect(discard).toHaveCount(0);
    // What was discarded is kept, and can be put back.
    await ways.getByRole('button', { name: 'Note information' }).click();
    const earlier = ways.getByRole('region', { name: 'Earlier versions' });
    await expect(earlier.locator('li')).toHaveCount(2);
    await expect(earlier.locator('li').first()).toContainText('Welcome to Bever, spoilt');
    await ways.screenshot({ path: 'test-results/bever-earlier-versions.png', fullPage: true });
    await earlier.locator('li').first().getByRole('button', { name: 'Put back' }).click();
    await ways
      .getByRole('dialog', { name: 'Put this version back?' })
      .getByRole('button', { name: 'Put it back' })
      .click();
    await expect(titleField).toHaveValue('Welcome to Bever, spoilt');
    await expect(ways.locator('.note-prose')).toContainText('typed by mistake');
    await ways.getByRole('button', { name: 'Close note information' }).click();

    // A note put out of sight stops playing. Something that plays is put
    // into the note's panel, and says when it was stopped.
    const playing = () =>
      ways.evaluate(() => {
        document.querySelector('.editor-panel .stand-in')?.remove();
        const audio = document.createElement('audio');
        audio.className = 'stand-in';
        audio.pause = () => {
          audio.dataset.stopped = 'yes';
        };
        document.querySelector('.editor-panel').append(audio);
      });
    const stopped = () =>
      ways.evaluate(() => document.querySelector('.editor-panel .stand-in')?.dataset.stopped === 'yes');
    await playing();
    await ways.locator('.sidebar').getByRole('button', { name: 'Tags', exact: true }).click();
    await expect(ways.getByRole('region', { name: 'Tags', exact: true })).toBeVisible();
    expect(await stopped()).toBe(true);
    await ways.keyboard.press('Escape');
    await ways.setViewportSize({ width: 390, height: 844 });
    await ways.waitForTimeout(400);
    await ways.getByRole('heading', { name: 'Bring your notes along', exact: true }).click();
    await expect(ways.getByRole('button', { name: 'Back to notes' })).toBeVisible();
    await playing();
    expect(await stopped()).toBe(false);
    await ways.getByRole('button', { name: 'Back to notes' }).click();
    await expect.poll(stopped).toBe(true);
    await ways.setViewportSize({ width: 1440, height: 920 });

    // The order chosen for a list is this device's: it is there after a
    // restart, in another notebook, and after a search.
    await ways.getByLabel('Sort notes').selectOption('titleAsc');
    await ways.locator('.sidebar').getByRole('button', { name: 'Notebooks', exact: true }).click();
    await ways.getByLabel('Order').selectOption('count');
    await ways.keyboard.press('Escape');
    // Notes open read-only from now on, by this device's choice.
    await ways.getByRole('button', { name: 'Settings & sync' }).click();
    await ways.getByLabel('Open notes read-only; the padlock in a note unlocks it').check();
    await ways.getByRole('button', { name: 'Close settings' }).click();
    await ways.reload({ waitUntil: 'domcontentloaded' });
    await ways.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
    await expect(ways.getByLabel('Sort notes')).toHaveValue('titleAsc');
    await expect(ways.locator('.note-card h2').first()).toHaveText('Bring your notes along');
    await ways
      .locator('.sidebar')
      .getByRole('button', { name: /^Reading/ })
      .click();
    await expect(ways.getByLabel('Sort notes')).toHaveValue('titleAsc');
    await ways.getByLabel('Search notes').fill('notes');
    await expect(ways.getByLabel('Sort notes')).toHaveValue('relevance');
    await ways.getByLabel('Clear search').click();
    await expect(ways.getByLabel('Sort notes')).toHaveValue('titleAsc');
    await ways.locator('.sidebar').getByRole('button', { name: 'Notebooks', exact: true }).click();
    await expect(ways.getByLabel('Order')).toHaveValue('count');
    await ways.keyboard.press('Escape');
    await ways.getByRole('heading', { name: 'Bring your notes along', exact: true }).click();
    await expect(ways.getByText('Read-only', { exact: true })).toBeVisible();
    await expect(ways.locator('.editor-toolbar')).toHaveCount(0);
    await expect(ways.getByRole('button', { name: 'Unlock this note' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // A note just made is for writing in.
    await ways.getByRole('button', { name: 'New note', exact: false }).first().click();
    await expect(ways.locator('.editor-toolbar')).toBeVisible();
    await expect(ways.getByRole('button', { name: 'Lock this note' })).toBeVisible();
    await ways.close();
  }

  // Hundreds of tags, on a phone: the filter is one list that a finger
  // moves, with a place to type a tag's name that stays in reach.
  {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
    });
    const tagged = await context.newPage();
    tagged.on('pageerror', (error) => errors.push(error.message));
    tagged.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const fingers = await context.newCDPSession(tagged);
    /** A finger that goes `first` in four small steps and then straight up or down. */
    const swipe = async (first, then) => {
      let x = 220;
      let y = 600;
      await fingers.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      const steps = [
        ...Array.from({ length: 4 }, () => [first[0] / 4, first[1] / 4]),
        ...Array.from({ length: 12 }, () => [0, then]),
      ];
      for (const [dx, dy] of steps) {
        x += dx;
        y += dy;
        await fingers.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
        await tagged.waitForTimeout(16);
      }
      await tagged.waitForTimeout(80);
      await fingers.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await tagged.waitForTimeout(700);
    };
    await tagged.goto('http://127.0.0.1:7100/?demoTags=600', { waitUntil: 'domcontentloaded' });
    await tagged.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
    await tagged.getByRole('button', { name: /Filters/ }).click();
    const rows = tagged.locator('.filter-tags-list .checkbox-label');
    await expect(rows.first()).toBeVisible();
    // Every tag a note has is offered; "Zulu time", which no note has, is not.
    expect(await rows.count()).toBeGreaterThan(600);
    await expect(tagged.getByLabel('Zulu time', { exact: true })).toHaveCount(0);
    const body = tagged.locator('.filter-body');
    const scrolled = () => body.evaluate((element) => element.scrollTop);
    // One thing scrolls, the panel: the list of tags does not scroll in it.
    expect(
      await tagged
        .locator('.filter-tags-list')
        .evaluate((element) => element.scrollHeight - element.clientHeight),
    ).toBe(0);
    expect(await body.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    // A swipe moves it, also one that begins more sideways than upward, as
    // a thumb's does: a list that only takes swipes up and down ignores
    // the whole of such a swipe.
    let from = await scrolled();
    await swipe([0, -20], -15);
    expect((await scrolled()) - from).toBeGreaterThan(120);
    from = await scrolled();
    await swipe([-15, -13], -15);
    expect((await scrolled()) - from).toBeGreaterThan(120);
    from = await scrolled();
    await swipe([-17, -10], -15);
    expect((await scrolled()) - from).toBeGreaterThan(90);
    from = await scrolled();
    await swipe([15, 13], 15);
    expect((await scrolled()) - from).toBeLessThan(-120);
    // And it moved up and down only: no name of a tag, however long, makes
    // the panel wider than its place.
    expect(await body.evaluate((element) => element.scrollLeft)).toBe(0);
    await expect(rows.first()).toContainText('A tag whose name is longer');
    expect((await rows.first().boundingBox()).width).toBeLessThanOrEqual((await body.boundingBox()).width);
    // Far down the list, the place to type in is still at the top of it.
    await body.evaluate((element) => (element.scrollTop = element.scrollHeight));
    const find = tagged.getByLabel('Find a tag');
    await expect(find).toBeInViewport();
    const panelTop = (await tagged.locator('.filter-panel').boundingBox()).y;
    expect((await find.boundingBox()).y - panelTop).toBeLessThan(120);
    // A tag that begins with z, without scrolling to the end for it.
    await find.fill('z');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('zebra crossing');
    await expect(tagged.locator('.filter-tags-note')).toContainText('1 more tag with “z” in its name');
    await tagged.screenshot({ path: 'test-results/bever-phone-tag-find.png' });
    await tagged.getByLabel('zebra crossing', { exact: true }).tap();
    await expect(tagged.locator('.notes-header h1 span')).toHaveText('1');
    await expect(find).toHaveValue('');
    // What is left to choose is what that one note also has.
    await expect(rows).toHaveCount(4);
    await expect(rows.first()).toContainText('zebra crossing');
    await expect(tagged.getByLabel('zebra crossing', { exact: true })).toBeChecked();
    await tagged.screenshot({ path: 'test-results/bever-phone-tag-chosen.png' });
    await tagged.getByRole('button', { name: /^Show all \d+ tags$/ }).tap();
    await expect(tagged.getByLabel('Zulu time', { exact: true })).toBeAttached();
    await tagged.getByRole('button', { name: 'Clear filters', exact: true }).tap();
    await expect(tagged.getByLabel('zebra crossing', { exact: true })).not.toBeChecked();
    await context.close();
  }

  // A PDF of forty pages: scrolled through, made larger about the place
  // looked at, and drawn again at the size it is shown.
  {
    const pdf = pdfOfPages(40);
    const serve = (target) =>
      target.route('**/demo-attachments/demo-pdf', (route) =>
        route.fulfill({ body: pdf, contentType: 'application/pdf' }),
      );
    const open = async (target, press) => {
      await target.goto('http://127.0.0.1:7100', { waitUntil: 'domcontentloaded' });
      await target.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
      await target.getByLabel('Search notes').fill('Local attachment preview');
      await press(target.locator('.note-card').getByText('Local attachment preview', { exact: true }));
      await press(target.getByRole('button', { name: 'Preview PDF', exact: true }));
      await expect(target.locator('.pdf-sheet[data-page="1"] canvas.pdf-whole')).toBeVisible({
        timeout: 30000,
      });
    };
    /** What is drawn, and how large. */
    const drawn = (target) =>
      target.evaluate(() => ({
        sheets: document.querySelectorAll('.pdf-sheet').length,
        widths: new Set(
          [...document.querySelectorAll('.pdf-sheet')].map((sheet) => Math.round(sheet.clientWidth)),
        ).size,
        wholes: [...document.querySelectorAll('.pdf-whole')].map((canvas) => ({
          page: Number(canvas.parentElement.dataset.page),
          pixels: canvas.width * canvas.height,
          scale: Number(canvas.parentElement.dataset.drawn),
        })),
        parts: [...document.querySelectorAll('.pdf-part')].map((canvas) => ({
          page: Number(canvas.parentElement.dataset.page),
          pixels: canvas.width * canvas.height,
        })),
        noteZoomed: document.querySelector('.note-zoom')?.classList.contains('zoomed') ?? false,
      }));
    const sheetBox = (target, number) => target.locator(`.pdf-sheet[data-page="${number}"]`).boundingBox();

    const desk = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
    desk.on('pageerror', (error) => errors.push(error.message));
    desk.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await serve(desk);
    await open(desk, (locator) => locator.click());
    let state = await drawn(desk);
    expect(state.sheets).toBe(40);
    // Upright pages and pages on their side are all as wide as the view.
    expect(state.widths).toBe(1);
    // Only what is in view and near it is drawn.
    expect(state.wholes.length).toBeLessThanOrEqual(4);
    const view = await desk.locator('.pdf-scroll').boundingBox();
    await desk.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
    for (let turn = 0; turn < 12; turn += 1) {
      await desk.mouse.wheel(0, 900);
      await desk.waitForTimeout(50);
    }
    await expect(desk.getByLabel('PDF page', { exact: true })).not.toHaveValue('1');
    await desk.getByLabel('PDF page', { exact: true }).fill('31');
    await desk.getByLabel('PDF page', { exact: true }).press('Enter');
    await expect(desk.locator('.pdf-sheet[data-page="31"] canvas.pdf-whole')).toBeVisible({ timeout: 30000 });
    await expect(desk.getByLabel('PDF page', { exact: true })).toHaveValue('31');
    await desk.waitForTimeout(400);
    state = await drawn(desk);
    // The pages passed on the way gave their drawings back.
    expect(state.wholes.length).toBeLessThanOrEqual(5);
    expect(state.wholes.every((whole) => whole.page >= 28)).toBe(true);
    const fitted = state.wholes.find((whole) => whole.page === 31).scale;

    // Ctrl and the wheel: larger, about the pointer.
    const before = await sheetBox(desk, 31);
    const pointer = { x: before.x + before.width * 0.3, y: before.y + before.height * 0.3 };
    await desk.mouse.move(pointer.x, pointer.y);
    await desk.keyboard.down('Control');
    for (let turn = 0; turn < 4; turn += 1) {
      await desk.mouse.wheel(0, -120);
      await desk.waitForTimeout(30);
    }
    await desk.keyboard.up('Control');
    const after = await sheetBox(desk, 31);
    expect(after.width / before.width).toBeGreaterThan(3);
    expect(Math.abs(after.x + after.width * 0.3 - pointer.x)).toBeLessThan(6);
    expect(Math.abs(after.y + after.height * 0.3 - pointer.y)).toBeLessThan(6);
    // Once it rests, the page is drawn again, finer; and where the whole
    // page would be more than a drawing may have, the part in view is
    // drawn over it at the size it is shown.
    await expect(desk.locator('.pdf-sheet[data-page="31"] canvas.pdf-part')).toBeAttached({ timeout: 15000 });
    state = await drawn(desk);
    expect(state.wholes.find((whole) => whole.page === 31).scale).toBeGreaterThan(fitted * 1.5);
    expect(state.wholes.every((whole) => whole.pixels <= 9_100_000)).toBe(true);
    expect(state.parts.every((part) => part.pixels <= 8_100_000)).toBe(true);
    await desk.screenshot({ path: 'test-results/bever-pdf-zoomed.png', fullPage: true });
    // The mouse takes the page and moves it.
    const place = () =>
      desk.locator('.pdf-scroll').evaluate((element) => [element.scrollLeft, element.scrollTop]);
    const held = await place();
    await desk.mouse.move(view.x + 400, view.y + 400);
    await desk.mouse.down();
    await desk.mouse.move(view.x + 300, view.y + 250, { steps: 6 });
    await desk.mouse.up();
    const moved = await place();
    expect(moved[0] - held[0]).toBeGreaterThan(90);
    expect(moved[1] - held[1]).toBeGreaterThan(140);
    // The note it was opened from is as it was.
    expect((await drawn(desk)).noteZoomed).toBe(false);
    await desk.getByRole('button', { name: /Fit the width/ }).click();
    await expect(desk.locator('.pdf-zoom-level')).toHaveText('100%');
    expect(Math.abs((await sheetBox(desk, 31)).width - before.width)).toBeLessThan(1);
    await desk.keyboard.press('Escape');
    await expect(desk.locator('.pdf-backdrop')).toHaveCount(0);
    await desk.close();

    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
    });
    const handheld = await context.newPage();
    handheld.on('pageerror', (error) => errors.push(error.message));
    handheld.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const fingers = await context.newCDPSession(handheld);
    await serve(handheld);
    await open(handheld, (locator) => locator.tap());
    // On a phone the document has the whole screen.
    const modal = await handheld.locator('.pdf-modal').boundingBox();
    expect(modal.width).toBe(412);
    expect(modal.height).toBe(915);
    await handheld.waitForTimeout(300);
    // Two fingers spread about a point: what was between them stays there.
    const first = await sheetBox(handheld, 1);
    const centre = { x: 280, y: 420 };
    const share = { x: (centre.x - first.x) / first.width, y: (centre.y - first.y) / first.height };
    const two = (spread) => [
      { x: centre.x - spread, y: centre.y - spread * 0.4, id: 1 },
      { x: centre.x + spread, y: centre.y + spread * 0.4, id: 2 },
    ];
    await fingers.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: two(40) });
    for (let step = 1; step <= 20; step += 1) {
      await fingers.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: two(40 + step * 4) });
      await handheld.waitForTimeout(16);
    }
    await handheld.waitForTimeout(60);
    await fingers.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const spread = await sheetBox(handheld, 1);
    expect(spread.width / first.width).toBeCloseTo(3, 1);
    expect(Math.abs(spread.x + share.x * spread.width - centre.x)).toBeLessThan(3);
    expect(Math.abs(spread.y + share.y * spread.height - centre.y)).toBeLessThan(3);
    // The preview is what became larger, and not the note under it.
    expect((await drawn(handheld)).noteZoomed).toBe(false);
    await expect(handheld.locator('.pdf-sheet[data-page="1"] canvas.pdf-part')).toBeAttached({
      timeout: 15000,
    });
    // A phone is not asked for more memory than a page may take there.
    expect((await drawn(handheld)).wholes.every((whole) => whole.pixels <= 4_100_000)).toBe(true);
    await handheld.screenshot({ path: 'test-results/bever-phone-pdf-zoomed.png' });
    // One finger moves the larger page, sideways too.
    const beforePan = await handheld.locator('.pdf-scroll').evaluate((element) => element.scrollLeft);
    await fingers.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: 500 }] });
    for (let step = 1; step <= 6; step += 1) {
      await fingers.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: 300 - step * 30, y: 500 }],
      });
      await handheld.waitForTimeout(16);
    }
    await fingers.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await handheld.waitForTimeout(600);
    expect(
      (await handheld.locator('.pdf-scroll').evaluate((element) => element.scrollLeft)) - beforePan,
    ).toBeGreaterThan(100);
    // A double tap goes back to the width of the screen, and another closer.
    const tapTwice = async () => {
      for (let tap = 0; tap < 2; tap += 1) {
        await fingers.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: 200, y: 400 }],
        });
        await handheld.waitForTimeout(40);
        await fingers.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await handheld.waitForTimeout(90);
      }
    };
    await tapTwice();
    await expect.poll(async () => (await sheetBox(handheld, 1)).width).toBeCloseTo(first.width, 0);
    await handheld.waitForTimeout(400);
    await tapTwice();
    await expect.poll(async () => (await sheetBox(handheld, 1)).width / first.width).toBeCloseTo(2.5, 1);
    await handheld.getByLabel('Close PDF preview').tap();
    await expect(handheld.locator('.pdf-backdrop')).toHaveCount(0);
    await context.close();
  }

  // Going back, on a phone: whatever was opened last is what closes, and
  // nothing is passed by. Back is a step back in the window's history,
  // which is what Android's button makes of it.
  {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
    });
    const walk = await context.newPage();
    walk.on('pageerror', (error) => errors.push(error.message));
    walk.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await walk.goto('http://127.0.0.1:7100/?demoAnnotated', { waitUntil: 'domcontentloaded' });
    await walk.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
    const goBack = () => walk.evaluate(() => window.history.back());
    /** How many things the history says are open. */
    const open = () => walk.evaluate(() => window.history.state?.depth ?? 0);
    const shellOf = walk.locator('.app-shell');
    const drawerOf = walk.locator('.sidebar');

    // The filter.
    await walk.getByRole('button', { name: /Filters/ }).tap();
    await expect(walk.locator('.filter-panel')).toBeVisible();
    expect(await open()).toBe(1);
    await goBack();
    await expect(walk.locator('.filter-panel')).toHaveCount(0);
    await expect.poll(open).toBe(0);

    // A selection of notes, and a dialog opened from it: the dialog first.
    await walk.getByLabel('Select Welcome to Bever', { exact: true }).check();
    await expect(walk.locator('.bulk-toolbar')).toBeVisible();
    await walk.locator('.bulk-toolbar').getByRole('button', { name: 'Tag', exact: true }).tap();
    await expect(walk.getByRole('dialog', { name: 'Add tags', exact: true })).toBeVisible();
    await goBack();
    await expect(walk.getByRole('dialog', { name: 'Add tags', exact: true })).toHaveCount(0);
    await expect(walk.locator('.bulk-toolbar')).toBeVisible();
    await goBack();
    await expect(walk.locator('.bulk-toolbar')).toHaveCount(0);
    await expect.poll(open).toBe(0);

    // The drawer, a menu in it, and a question asked from the menu.
    await walk.getByRole('button', { name: 'Open navigation' }).tap();
    await expect(drawerOf).toHaveClass(/is-open/);
    await expect.poll(async () => (await drawerOf.boundingBox()).x).toBeGreaterThanOrEqual(0);
    await walk.getByLabel('Actions for Reading', { exact: true }).tap();
    await expect(walk.locator('.context-menu')).toBeVisible();
    await goBack();
    await expect(walk.locator('.context-menu')).toHaveCount(0);
    await expect(drawerOf).toHaveClass(/is-open/);
    await walk.getByLabel('Actions for Reading', { exact: true }).tap();
    await walk.getByRole('menuitem', { name: 'Rename…' }).tap();
    await expect(walk.getByRole('dialog', { name: 'Rename notebook' })).toBeVisible();
    await goBack();
    await expect(walk.getByRole('dialog', { name: 'Rename notebook' })).toHaveCount(0);
    await expect(drawerOf).toHaveClass(/is-open/);
    await goBack();
    await expect(drawerOf).not.toHaveClass(/is-open/);
    await expect.poll(open).toBe(0);

    // The settings, opened from the drawer, and the screen of all tags.
    await walk.getByRole('button', { name: 'Open navigation' }).tap();
    await expect.poll(async () => (await drawerOf.boundingBox()).x).toBeGreaterThanOrEqual(0);
    await walk.getByRole('button', { name: 'Settings & sync' }).tap();
    await expect(walk.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await goBack();
    await expect(walk.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    await expect(drawerOf).not.toHaveClass(/is-open/);
    await expect.poll(open).toBe(0);
    await walk.getByRole('button', { name: 'Open navigation' }).tap();
    await expect.poll(async () => (await drawerOf.boundingBox()).x).toBeGreaterThanOrEqual(0);
    await drawerOf.getByRole('button', { name: 'Tags', exact: true }).tap();
    await expect(walk.getByRole('region', { name: 'Tags', exact: true })).toBeVisible();
    await goBack();
    await expect(walk.getByRole('region', { name: 'Tags', exact: true })).toHaveCount(0);
    await expect.poll(open).toBe(0);

    // A note, and what opens over it: each closes by itself, the note stays.
    await walk.getByLabel('Search notes').fill('Local attachment preview');
    await walk.locator('.note-card').getByText('Local attachment preview', { exact: true }).tap();
    await expect(shellOf).toHaveClass(/mobile-has-note/);
    await walk.getByRole('button', { name: 'Preview PDF', exact: true }).tap();
    await expect(walk.getByRole('dialog', { name: 'Preview Bever preview.pdf' })).toBeVisible();
    await goBack();
    await expect(walk.locator('.pdf-backdrop')).toHaveCount(0);
    await expect(shellOf).toHaveClass(/mobile-has-note/);
    await walk.getByLabel('Actions for Bever preview.pdf').tap();
    await expect(walk.locator('.context-menu')).toBeVisible();
    await goBack();
    await expect(walk.locator('.context-menu')).toHaveCount(0);
    await walk.getByLabel('Note information').tap();
    await expect(walk.locator('.metadata-panel')).toBeVisible();
    await goBack();
    await expect(walk.locator('.metadata-panel')).toHaveCount(0);
    await walk.getByLabel('Find in this note').tap();
    await expect(walk.locator('.note-find')).toBeVisible();
    await goBack();
    await expect(walk.locator('.note-find')).toHaveCount(0);
    await expect(shellOf).toHaveClass(/mobile-has-note/);
    // The preview open, and Back twice: the preview, then the note. It is
    // not left open over the list, as it was.
    await walk.getByRole('button', { name: 'Preview PDF', exact: true }).tap();
    await expect(walk.locator('.pdf-backdrop')).toBeVisible();
    await goBack();
    await expect(walk.locator('.pdf-backdrop')).toHaveCount(0);
    await goBack();
    await expect(shellOf).not.toHaveClass(/mobile-has-note/);
    await expect.poll(open).toBe(0);

    // The editor of a picture: a menu in it first, and a text being written;
    // with nothing changed it closes; with a mark made it saves and closes.
    await walk.getByLabel('Clear search').tap();
    await walk.getByRole('heading', { name: 'A picture with annotations' }).tap();
    const annotate = async () => {
      // A picture that was just saved is still the one selected, with its
      // tools showing; a tap on it would put them away.
      const tools = walk.getByRole('toolbar', { name: 'Picture size and placement' });
      await walk.waitForTimeout(400);
      if (!(await tools.isVisible())) await walk.locator('.note-prose .attachment-image img').tap();
      await tools.getByRole('button', { name: 'Annotate' }).tap();
      await expect(walk.getByLabel('Picture to annotate')).toBeVisible();
    };
    const annotator = walk.getByRole('dialog', { name: /^Annotate / });
    await annotate();
    await walk
      .getByRole('toolbar', { name: 'Annotation tools' })
      .getByRole('button', { name: 'Colour' })
      .tap();
    await expect(walk.getByRole('menu', { name: 'Colour' })).toBeVisible();
    await goBack();
    await expect(walk.getByRole('menu', { name: 'Colour' })).toHaveCount(0);
    await expect(annotator).toBeVisible();
    await goBack();
    await expect(annotator).toHaveCount(0);
    await expect(shellOf).toHaveClass(/mobile-has-note/);
    await annotate();
    const marksBefore = Number(await walk.getByLabel('Picture to annotate').getAttribute('data-marks'));
    await walk
      .getByRole('toolbar', { name: 'Annotation tools' })
      .getByRole('button', { name: 'Text', exact: true })
      .tap();
    const picture = await walk.getByLabel('Picture to annotate').boundingBox();
    await walk.touchscreen.tap(picture.x + picture.width * 0.3, picture.y + picture.height * 0.6);
    await walk.getByLabel('Text on the picture').pressSequentially('here');
    // Back while a text is being written puts the writing away, no more.
    await goBack();
    await expect(walk.getByLabel('Text on the picture')).toHaveCount(0);
    await expect(annotator).toBeVisible();
    await walk.touchscreen.tap(picture.x + picture.width * 0.3, picture.y + picture.height * 0.6);
    await walk.getByLabel('Text on the picture').pressSequentially('here');
    await walk.getByLabel('Text on the picture').press('Enter');
    await expect(walk.getByLabel('Picture to annotate')).toHaveAttribute(
      'data-marks',
      String(marksBefore + 1),
    );
    // Back with a mark made keeps it: the picture is saved, as by its
    // button, and the editor closes. The note stays open.
    await goBack();
    await expect(annotator).toHaveCount(0);
    await expect(shellOf).toHaveClass(/mobile-has-note/);
    await annotate();
    await expect(walk.getByLabel('Picture to annotate')).toHaveAttribute(
      'data-marks',
      String(marksBefore + 1),
    );
    await goBack();
    await expect(annotator).toHaveCount(0);
    await expect(shellOf).toHaveClass(/mobile-has-note/);
    await goBack();
    await expect(shellOf).not.toHaveClass(/mobile-has-note/);
    // Nothing is left open, on the screen or in the history: the next step
    // back is out of the application.
    await expect.poll(open).toBe(0);
    await expect(walk.locator('.modal-backdrop, .context-menu, .annotator, .filter-panel')).toHaveCount(0);
    await context.close();
  }

  // The filter and the PDF preview in windows of every size: phones upright,
  // on their side and with the keyboard up, tablets, a small window, a
  // laptop, a large monitor. Everything is in the window and in reach.
  for (const [name, width, height, finger] of [
    ['a small phone', 360, 640, true],
    ['a phone', 412, 915, true],
    ['a phone with its keyboard up', 412, 520, true],
    ['a phone on its side', 915, 412, true],
    ['a tablet', 820, 1180, true],
    ['a tablet on its side', 1180, 820, true],
    ['a small window', 800, 500, false],
    ['a laptop', 1366, 768, false],
    ['a large monitor', 2560, 1440, false],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: finger ? 2 : 1,
      hasTouch: finger,
      isMobile: finger,
    });
    const sized = await context.newPage();
    sized.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
    const press = (locator) => (finger ? locator.tap() : locator.click());
    const inWindow = async (locator, what) => {
      const box = await locator.boundingBox();
      const told = `${what} in ${name} (${width} x ${height})`;
      expect(box, told).not.toBeNull();
      expect(box.x, told).toBeGreaterThanOrEqual(0);
      expect(box.y, told).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, told).toBeLessThanOrEqual(width + 0.5);
      expect(box.y + box.height, told).toBeLessThanOrEqual(height + 0.5);
      return box;
    };
    await sized.goto('http://127.0.0.1:7100/?demoTags=600', { waitUntil: 'domcontentloaded' });
    await sized.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
    await press(sized.getByRole('button', { name: /Filters/ }));
    await expect(sized.locator('.filter-tags-list .checkbox-label').first()).toBeVisible();
    const panel = await inWindow(sized.locator('.filter-panel'), 'the filter');
    await inWindow(sized.getByLabel('Close filters'), 'the button that closes the filter');
    expect(
      await sized.locator('.filter-body').evaluate((element) => element.scrollWidth - element.clientWidth),
      `the filter is no wider than its place in ${name}`,
    ).toBe(0);
    // A name typed is answered where it can be seen: the place to type in
    // and at least two of the tags found are in the panel.
    await sized.getByLabel('Find a tag').fill('topic 01');
    await inWindow(sized.getByLabel('Find a tag'), 'the place to type a tag in');
    const seen = await sized
      .locator('.filter-tags-list .checkbox-label')
      .evaluateAll(
        (rows, bottom) => rows.filter((row) => row.getBoundingClientRect().bottom <= bottom + 0.5).length,
        panel.y + panel.height,
      );
    expect(seen, `tags found that are in view in ${name}`).toBeGreaterThanOrEqual(2);
    await press(sized.getByRole('button', { name: 'Clear filters', exact: true }));
    await press(sized.getByLabel('Close filters'));

    await sized.getByLabel('Search notes').fill('Local attachment preview');
    await press(sized.locator('.note-card').getByText('Local attachment preview', { exact: true }));
    await press(sized.getByRole('button', { name: 'Preview PDF', exact: true }));
    await expect(sized.locator('.pdf-sheet[data-page="1"] canvas.pdf-whole')).toBeVisible({ timeout: 30000 });
    await inWindow(sized.locator('.pdf-modal'), 'the PDF preview');
    await inWindow(sized.getByLabel('Close PDF preview'), 'the button that closes the PDF');
    await inWindow(sized.getByLabel('PDF page', { exact: true }), 'the number of the page');
    const pages = await inWindow(sized.locator('.pdf-scroll'), 'the pages of the PDF');
    expect(pages.height, `room for the pages in ${name}`).toBeGreaterThan(200);
    // A page is as wide as its place and no wider, with nothing to move sideways.
    const sheet = await sized.locator('.pdf-sheet[data-page="1"]').boundingBox();
    expect(sheet.width, `a page in ${name}`).toBeLessThanOrEqual(pages.width);
    expect(sheet.width, `a page in ${name}`).toBeGreaterThan(Math.min(pages.width, 1000) * 0.8);
    expect(
      await sized.locator('.pdf-scroll').evaluate((element) => element.scrollWidth - element.clientWidth),
      `the pages are no wider than their place in ${name}`,
    ).toBe(0);
    await sized.screenshot({ path: `test-results/bever-pdf-${width}x${height}.png` });
    await press(sized.getByLabel('Close PDF preview'));
    await expect(sized.locator('.pdf-backdrop')).toHaveCount(0);
    await context.close();
  }

  if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
  console.log('Visual and interaction checks passed.');
} finally {
  await browser?.close();
  await server.close();
}

/**
 * A PDF of `count` pages of small print and thin lines, made here so that
 * none has to be kept in the repository. Every fifth page lies on its side.
 */
function pdfOfPages(count) {
  const objects = [];
  const add = (body) => objects.push(body);
  const catalog = add(null);
  const tree = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (let page = 1; page <= count; page += 1) {
    const [width, height] = page % 5 === 0 ? [842, 595] : [595, 842];
    let stream = `BT /F1 48 Tf 72 ${height - 120} Td (Page ${page}) Tj ET\n`;
    for (let line = 0; line < 30; line += 1) {
      stream += `BT /F1 7 Tf 72 ${height - 160 - line * 12} Td (Line ${line + 1} of page ${page}: small print that reads well only when it is drawn sharp.) Tj ET\n`;
    }
    stream += `0.4 w 72 ${height - 140} m ${width - 72} ${height - 140} l S\n`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] =
    `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(' ')}] /Count ${count} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function checkFullyInViewport(page, locator) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  const viewport = page.viewportSize();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
}

async function checkIndependentWheel(page, selector) {
  const locator = page.locator(selector);
  await locator.evaluate((element) => {
    element.scrollTop = 0;
  });
  expect(await locator.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await locator.hover();
  await page.mouse.wheel(0, 420);
  await page.waitForTimeout(250);
  expect(await locator.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect((await page.locator('.app-shell').boundingBox()).y).toBe(0);
}
