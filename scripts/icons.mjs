// Regenerates every icon of the application from public/bever.svg.
//
//   node scripts/icons.mjs
//
// The mark is a pencil whose point a beaver has gnawed, standing as the stem
// of a "b", with a beaver's tail for its bowl. It was drawn for this project.
//
// The desktop icons go to src-tauri/icons. The Android launcher icons go to
// the maintained Android overlay (src-tauri/android), which every Android
// build copies over the generated project: `tauri android init` creates a
// project with Tauri's own launcher icon, and that project is not kept in
// source control.
//
// Android shows an "adaptive" icon: a foreground drawn over a background and
// cut to whatever shape the launcher uses. Only the middle two thirds of the
// foreground are guaranteed to be visible, so the mark is drawn smaller there
// than in the desktop icon and the colour fills the whole background.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const icon = readFileSync(join(root, 'public/bever.svg'), 'utf8');

const background = /<rect width="128" height="128"[^>]*fill="(#[0-9a-fA-F]{6})"[^>]*\/>/.exec(icon);
if (!background) throw new Error('public/bever.svg no longer starts with a full-size background.');
const shapes = icon
  .replace(background[0], '')
  .replace(/<title[^>]*>.*?<\/title>/s, '')
  .replace(/^<svg[^>]*>/, '')
  .replace(/<\/svg>\s*$/, '');

const work = mkdtempSync(join(tmpdir(), 'bever-icons-'));
try {
  const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${body}</svg>\n`;
  writeFileSync(join(work, 'app-icon.svg'), icon);
  // Centred on the mark and scaled to sit inside the visible two thirds.
  writeFileSync(
    join(work, 'foreground.svg'),
    svg(`<g transform="translate(64 64) scale(0.55) translate(-67 -61)">${shapes}</g>`),
  );
  writeFileSync(
    join(work, 'background.svg'),
    svg(`<rect width="128" height="128" fill="${background[1]}"/>`),
  );
  writeFileSync(
    join(work, 'manifest.json'),
    JSON.stringify({
      default: 'app-icon.svg',
      bg_color: background[1],
      android_bg: 'background.svg',
      android_fg: 'foreground.svg',
      android_fg_scale: 100,
    }),
  );
  execFileSync(
    process.execPath,
    [join(root, 'scripts/tauri.cjs'), 'icon', join(work, 'manifest.json'), '-o', join(work, 'out')],
    // The generator lists every file on stderr; it is shown only on failure.
    { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  cpSync(join(work, 'out/android'), join(root, 'src-tauri/android/app/src/main/res'), { recursive: true });
  rmSync(join(work, 'out/android'), { recursive: true, force: true });

  // Android before version 8 shows a plain picture instead, cut to a circle
  // or a rounded square: the mark on its colour, with room around it.
  writeFileSync(
    join(work, 'plain.svg'),
    svg(
      `<rect width="128" height="128" fill="${background[1]}"/><g transform="translate(64 64) scale(0.78) translate(-67 -61)">${shapes}</g>`,
    ),
  );
  writeFileSync(join(work, 'plain.json'), JSON.stringify({ default: 'plain.svg', bg_color: background[1] }));
  execFileSync(
    process.execPath,
    [join(root, 'scripts/tauri.cjs'), 'icon', join(work, 'plain.json'), '-o', join(work, 'plain')],
    { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
      cpSync(
        join(work, 'plain/android', `mipmap-${density}`, name),
        join(root, 'src-tauri/android/app/src/main/res', `mipmap-${density}`, name),
      );
    }
  }
  cpSync(join(work, 'out'), join(root, 'src-tauri/icons'), { recursive: true });
  console.log('Icons written to src-tauri/icons and src-tauri/android/app/src/main/res.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
