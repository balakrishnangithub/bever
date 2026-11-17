import type { Tag } from '../types';
import { byName } from './nameOrder';

/** A tag to narrow a listing by, with how many of the listed notes have it. */
export interface TagChoice {
  tag: Tag;
  count: number;
}

export interface TagChoices {
  /** The tags the listing is narrowed by already. They are always shown. */
  chosen: TagChoice[];
  /** The tags that can be added to them. */
  offered: TagChoice[];
  /**
   * How many tags answer what was typed and are on none of the listed
   * notes, so that they are not offered unless all tags are asked for.
   */
  elsewhere: number;
}

/** A name as it is compared with what was typed: without case or accents. */
const plain = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/**
 * How well a name answers what was typed: 0 when it begins with it, 1 when
 * one of its later words does, 2 when it has it anywhere, and null when it
 * does not have it.
 */
function standing(name: string, typed: string): number | null {
  if (!typed) return 0;
  const at = name.indexOf(typed);
  if (at < 0) return null;
  if (at === 0) return 0;
  for (let from = at; from >= 0; from = name.indexOf(typed, from + 1)) {
    if (!/[\p{L}\p{N}]/u.test(name[from - 1] ?? '')) return 1;
  }
  return 2;
}

/**
 * The tags to choose among when a listing is narrowed by its tags.
 *
 * With hundreds of tags a list of all of them is of no use: what is offered
 * is what the notes now listed have, each with the number of them that have
 * it, which is how many notes are left when it is chosen. Every chosen tag
 * has to be on a note, so a tag none of them has would leave nothing.
 * `all` offers those too. What is typed narrows the offer to the names that
 * have it, those that begin with it first.
 */
export function tagChoices(
  tags: Tag[],
  chosenIds: string[],
  onNotes: Record<string, number>,
  typed: string,
  all: boolean,
): TagChoices {
  const wanted = plain(typed.trim());
  const chosen: TagChoice[] = [];
  const offered: (TagChoice & { standing: number })[] = [];
  let elsewhere = 0;
  for (const tag of tags) {
    const count = onNotes[tag.id] ?? 0;
    if (chosenIds.includes(tag.id)) {
      chosen.push({ tag, count });
      continue;
    }
    const answers = standing(plain(tag.name), wanted);
    if (answers === null) continue;
    if (count > 0 || all) offered.push({ tag, count, standing: answers });
    else if (wanted) elsewhere += 1;
  }
  chosen.sort((a, b) => byName(a.tag.name, b.tag.name));
  offered.sort((a, b) => a.standing - b.standing || byName(a.tag.name, b.tag.name));
  return { chosen, offered: offered.map(({ tag, count }) => ({ tag, count })), elsewhere };
}
