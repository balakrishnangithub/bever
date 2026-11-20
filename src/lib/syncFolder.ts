/**
 * The folder a library is kept in at the storage, as the interface names
 * it. A folder is named by its path from the top, its parts joined by `/`;
 * `/` alone is the top.
 */
export const TOP = '/';
/** The name a library's folder has unless another is given. */
export const DEFAULT_NAME = 'Bever';
/** Where every library was kept before a folder could be chosen. */
export const DEFAULT_FOLDER = `/${DEFAULT_NAME}`;

function parts(path: string): string[] {
  return path.split('/').filter(Boolean);
}

export function joinFolder(path: string, name: string): string {
  return path === TOP ? `/${name}` : `${path}/${name}`;
}

/** The folder that `path` is in; the top is in itself. */
export function parentFolder(path: string): string {
  const above = parts(path).slice(0, -1);
  return above.length ? `/${above.join('/')}` : TOP;
}

/** The folders passed on the way down to `path`, the top left out. */
export function folderTrail(path: string): { name: string; path: string }[] {
  const trail: { name: string; path: string }[] = [];
  for (const name of parts(path)) {
    trail.push({ name, path: joinFolder(trail.at(-1)?.path ?? TOP, name) });
  }
  return trail;
}

/** Why `name` cannot be the name of a folder, or null when it can. */
export function folderNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Give the folder a name.';
  if (/[/\\]/.test(trimmed)) return 'A name cannot have / or \\ in it.';
  if (trimmed === '.' || trimmed === '..') return 'Give the folder a name of its own.';
  if (trimmed.length > 100) return 'That name is too long.';
  return null;
}

/** `wanted`, or the first of `wanted 2`, `wanted 3`… that no folder in `taken` has. */
export function freeFolderName(taken: string[], wanted = DEFAULT_NAME): string {
  const used = new Set(taken.map((name) => name.toLowerCase()));
  if (!used.has(wanted.toLowerCase())) return wanted;
  for (let number = 2; ; number += 1) {
    const name = `${wanted} ${number}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}
