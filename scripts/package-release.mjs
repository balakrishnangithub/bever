// Collects the artifacts of a release into release/ with checksums.
//
//   node scripts/package-release.mjs [--allow-missing]
//
// Build first: `npm run tauri -- build` (Windows installers) and
// `npm run android:build` (APK). The source archive is made by `git archive`
// from the current commit, so it holds exactly the tracked files: no build
// output, no private test data, nothing untracked. A missing artifact is an
// error unless --allow-missing is given, so a release cannot silently lack one.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const release = join(root, 'release');
const allowMissing = process.argv.includes('--allow-missing');

const artifacts = [
  {
    source: `target/release/bundle/nsis/Bever_${version}_x64-setup.exe`,
    name: `Bever_${version}_x64-setup.exe`,
  },
  {
    source: `target/release/bundle/msi/Bever_${version}_x64_en-US.msi`,
    name: `Bever_${version}_x64_en-US.msi`,
  },
  {
    source: 'src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk',
    name: `Bever_${version}_arm64-debug.apk`,
    // An APK without the native library installs and then crashes at start.
    mustContain: 'lib/arm64-v8a/libbever_lib.so',
  },
];

/** Names of the entries of a ZIP file, read from its central directory. */
function zipEntries(path) {
  const data = readFileSync(path);
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error(`${path} is not a ZIP file`);
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  const names = [];
  for (let index = 0; index < count; index += 1) {
    if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error(`${path} has a damaged directory`);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    names.push(data.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

function sha256(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => done(hash.digest('hex')))
      .on('error', fail);
  });
}

mkdirSync(release, { recursive: true });

const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
if (dirty) {
  console.warn('Warning: uncommitted changes are not part of the source archive.');
}
const sourceName = `Bever-${version}-source.zip`;
execFileSync(
  'git',
  ['archive', '--format=zip', `--prefix=Bever-${version}-source/`, '-o', join(release, sourceName), 'HEAD'],
  { cwd: root, stdio: 'inherit' },
);
const delivered = [sourceName];
console.log(`${sourceName}: ${zipEntries(join(release, sourceName)).length} entries from the current commit`);

const missing = [];
for (const artifact of artifacts) {
  const source = join(root, artifact.source);
  if (!existsSync(source)) {
    missing.push(artifact.source);
    continue;
  }
  if (artifact.mustContain && !zipEntries(source).includes(artifact.mustContain)) {
    throw new Error(`${artifact.source} does not contain ${artifact.mustContain}`);
  }
  copyFileSync(source, join(release, artifact.name));
  delivered.push(artifact.name);
}

const lines = [];
for (const name of delivered) {
  const path = join(release, name);
  lines.push(`${await sha256(path)}  ${name}`);
  console.log(`${name}: ${statSync(path).size.toLocaleString('en-US')} bytes`);
}
writeFileSync(join(release, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
console.log('SHA256SUMS.txt written');

if (missing.length) {
  console.error(`Not built, and so not in this release:\n  ${missing.join('\n  ')}`);
  if (!allowMissing) process.exit(1);
}
