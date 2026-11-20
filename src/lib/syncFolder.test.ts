import { describe, expect, it } from 'vitest';

import { folderNameProblem, folderTrail, freeFolderName, joinFolder, parentFolder } from './syncFolder';

describe('the folder a library is kept in', () => {
  it('is named by its path from the top', () => {
    expect(joinFolder('/', 'Bever')).toBe('/Bever');
    expect(joinFolder('/Family', 'Her notes')).toBe('/Family/Her notes');
    expect(parentFolder('/Family/Her notes')).toBe('/Family');
    expect(parentFolder('/Family')).toBe('/');
    expect(parentFolder('/')).toBe('/');
    expect(folderTrail('/')).toEqual([]);
    expect(folderTrail('/Family/Her notes')).toEqual([
      { name: 'Family', path: '/Family' },
      { name: 'Her notes', path: '/Family/Her notes' },
    ]);
  });

  it('takes a name that a folder can have, and says why another cannot be one', () => {
    expect(folderNameProblem('Bever')).toBeNull();
    expect(folderNameProblem('  Her notes  ')).toBeNull();
    expect(folderNameProblem('   ')).toMatch(/name/);
    expect(folderNameProblem('a/b')).toMatch(/\//);
    expect(folderNameProblem('a\\b')).toMatch(/\\/);
    expect(folderNameProblem('..')).not.toBeNull();
    expect(folderNameProblem('x'.repeat(101))).toMatch(/long/);
  });

  it('offers a name that is not taken where the folder is made', () => {
    expect(freeFolderName(['Documents', 'Photos'])).toBe('Bever');
    expect(freeFolderName(['Documents', 'bever'])).toBe('Bever 2');
    expect(freeFolderName(['Bever', 'Bever 2', 'BEVER 3'])).toBe('Bever 4');
    expect(freeFolderName(['Notes'], 'Notes')).toBe('Notes 2');
  });
});
