/**
 * The order names are listed in: as a person reads them. Letters compare
 * without regard to case, and digits as the number they write, so "note-2"
 * comes before "note-10". The library lists notebooks, tags, and titles in
 * this order itself; this is the same order for lists made here.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const byName = (a: string, b: string) => collator.compare(a, b);
