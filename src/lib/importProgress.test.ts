import { describe, expect, it } from 'vitest';

import type { ImportProgress } from '../types';
import { importPercent } from './importProgress';

const progress = (overrides: Partial<ImportProgress>): ImportProgress => ({
  importId: 'id',
  fileIndex: 0,
  fileCount: 1,
  fileName: 'notes.enex',
  phase: 'reading',
  notebookId: 'n',
  noteIndex: 1,
  noteTitle: null,
  notesImported: 0,
  notesSkipped: 0,
  notesFailed: 0,
  resourcesImported: 0,
  bytesRead: 0,
  totalBytes: 1000,
  ...overrides,
});

describe('import progress', () => {
  it('measures one file by the bytes read', () => {
    expect(importPercent(null)).toBe(0);
    expect(importPercent(progress({ bytesRead: 250 }))).toBe(25);
    expect(importPercent(progress({ bytesRead: 1000 }))).toBe(100);
    expect(importPercent(progress({ bytesRead: 5000 }))).toBe(100);
  });

  it('counts finished files when several are imported', () => {
    expect(importPercent(progress({ fileIndex: 1, fileCount: 4, bytesRead: 500 }))).toBe(37);
    expect(importPercent(progress({ fileIndex: 3, fileCount: 4, bytesRead: 1000 }))).toBe(100);
  });

  it('copes with a file whose size is unknown', () => {
    expect(importPercent(progress({ fileIndex: 1, fileCount: 2, totalBytes: 0 }))).toBe(50);
  });
});
