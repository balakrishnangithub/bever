// Takes the pictures of the application that the README and the Android
// listing show, from the browser demonstration with its sample notes.
//
//   npm run build && node scripts/screenshots.mjs
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { preview } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readme = join(root, 'docs/screenshots');
const listing = join(root, 'fastlane/metadata/android/en-US/images/phoneScreenshots');
mkdirSync(readme, { recursive: true });
mkdirSync(listing, { recursive: true });

const server = await preview({ root, preview: { host: '127.0.0.1', port: 7102, strictPort: true } });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const address = 'http://127.0.0.1:7102/?demoImages&demoSketch&demoAnnotated&demoClip';

const open = async (viewport, deviceScaleFactor) => {
  const page = await browser.newPage({ viewport, deviceScaleFactor });
  await page.goto(address, { waitUntil: 'domcontentloaded' });
  await page.locator('.loading-screen').waitFor({ state: 'detached', timeout: 90000 });
  return page;
};
const settle = (page) => page.waitForTimeout(700);

try {
  // The library, the list of notes with their pictures, and a note.
  const desktop = await open({ width: 1360, height: 860 }, 1);
  await desktop.getByRole('heading', { name: 'Bring your notes along' }).click();
  await settle(desktop);
  await desktop.screenshot({ path: join(readme, 'library.png') });

  // What a search found, in a note's text and in its pictures.
  await desktop.getByLabel('Search notes').fill('range inter');
  await desktop.locator('.note-card', { hasText: 'Domain and range' }).getByRole('heading').click();
  await desktop.locator('.note-prose .image-found').first().waitFor();
  await settle(desktop);
  await desktop.screenshot({ path: join(readme, 'search.png') });

  // A sketch, with one of its strokes selected.
  await desktop.getByLabel('Search notes').fill('');
  await desktop.getByRole('heading', { name: 'A sketch' }).click();
  await desktop.locator('.note-prose .attachment-image img').click();
  await desktop
    .getByRole('toolbar', { name: 'Picture size and placement' })
    .getByRole('button', { name: 'Edit sketch' })
    .click();
  const paper = desktop.getByLabel('Sketch', { exact: true });
  await paper.waitFor();
  await desktop
    .getByRole('toolbar', { name: 'Sketch tools' })
    .getByRole('button', { name: 'Select and move strokes' })
    .click();
  const box = await paper.boundingBox();
  const [left, top, zoom] = (await paper.getAttribute('data-view')).split(',').map(Number);
  const at = (x, y) => [box.x + (x - left) * zoom, box.y + (y - top) * zoom];
  await desktop.mouse.move(...at(280, 232));
  await desktop.mouse.down();
  await desktop.mouse.move(...at(360, 280), { steps: 4 });
  await desktop.mouse.move(...at(440, 310), { steps: 4 });
  await desktop.mouse.up();
  await settle(desktop);
  await desktop.screenshot({ path: join(readme, 'sketch.png') });
  await desktop.close();

  // On a phone: the list, a note, and a search.
  const phone = await open({ width: 390, height: 780 }, 2);
  await settle(phone);
  await phone.screenshot({ path: join(listing, '1_notes.png') });
  await phone.screenshot({ path: join(readme, 'phone.png') });
  await phone.getByRole('heading', { name: 'Bring your notes along' }).click();
  await settle(phone);
  await phone.screenshot({ path: join(listing, '2_note.png') });
  await phone.getByRole('button', { name: 'Back to notes' }).click();
  await phone.getByLabel('Search notes').fill('range inter');
  await phone.locator('.note-card', { hasText: 'Domain and range' }).getByRole('heading').click();
  await phone.locator('.note-prose .image-found').first().waitFor();
  await settle(phone);
  await phone.screenshot({ path: join(listing, '3_search.png') });
  await phone.close();
  console.log(`Screenshots written to ${readme} and ${listing}.`);
} finally {
  await browser.close();
  await server.close();
}
