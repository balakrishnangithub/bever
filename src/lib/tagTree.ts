import type { Tag } from '../types';

/** Tags by the tag they are directly inside; the ones at the top are under `null`. */
export function tagChildren(tags: Tag[]): Map<string | null, Tag[]> {
  const known = new Set(tags.map((tag) => tag.id));
  const children = new Map<string | null, Tag[]>();
  for (const tag of tags) {
    // A tag whose parent is not there is shown at the top, not lost.
    const parent = tag.parentId !== null && known.has(tag.parentId) ? tag.parentId : null;
    const siblings = children.get(parent);
    if (siblings) siblings.push(tag);
    else children.set(parent, [tag]);
  }
  return children;
}

/** The names of the tags a tag is inside, outermost first. */
export function tagPath(tag: Tag, tags: Tag[]): string[] {
  const byId = new Map(tags.map((item) => [item.id, item]));
  const path: string[] = [];
  let parent = tag.parentId === null ? undefined : byId.get(tag.parentId);
  // No nesting a person makes is this deep; a loop in damaged data ends here.
  for (let depth = 0; parent && depth < 64; depth += 1) {
    path.unshift(parent.name);
    parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
  }
  return path;
}

/** `tag` and every tag inside it, at any depth, by id. */
export function tagWithDescendants(tag: Tag, tags: Tag[]): Set<string> {
  const children = tagChildren(tags);
  const inside = new Set<string>();
  const add = (id: string) => {
    if (inside.has(id)) return;
    inside.add(id);
    for (const child of children.get(id) ?? []) add(child.id);
  };
  add(tag.id);
  return inside;
}
