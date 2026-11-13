// Sets the version everywhere it is recorded.
//
//   node scripts/set-version.mjs 1.0.0
//
// The version lives in package.json, package-lock.json, the Cargo workspace,
// Cargo.lock, and tauri.conf.json. Changing them by hand has left stale
// numbers behind before, so they are changed together here.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: node scripts/set-version.mjs <major.minor.patch>');
  process.exit(1);
}

/** Replaces exactly one match, so an unexpected file layout is noticed. */
function replaceOnce(file, pattern, replacement) {
  const path = join(root, file);
  const text = readFileSync(path, 'utf8');
  const matches = text.match(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`)) ?? [];
  if (matches.length !== 1) {
    throw new Error(`${file}: expected one place to set the version, found ${matches.length}`);
  }
  writeFileSync(path, text.replace(pattern, replacement));
  console.log(`${file} -> ${version}`);
}

replaceOnce('package.json', /("name": "bever",\s+"version": ")[^"]+(")/, `$1${version}$2`);
replaceOnce('package-lock.json', /^(\{\s+"name": "bever",\s+"version": ")[^"]+(")/, `$1${version}$2`);
replaceOnce(
  'package-lock.json',
  /("packages": \{\s+"": \{\s+"name": "bever",\s+"version": ")[^"]+(")/,
  `$1${version}$2`,
);
replaceOnce('Cargo.toml', /(\[workspace\.package\]\s+version = ")[^"]+(")/, `$1${version}$2`);
replaceOnce('Cargo.lock', /(name = "bever"\nversion = ")[^"]+(")/, `$1${version}$2`);
replaceOnce('Cargo.lock', /(name = "bever-core"\nversion = ")[^"]+(")/, `$1${version}$2`);
replaceOnce(
  'src-tauri/tauri.conf.json',
  /("productName": "Bever",\s+"version": ")[^"]+(")/,
  `$1${version}$2`,
);
