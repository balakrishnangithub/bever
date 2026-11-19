import { describe, expect, it } from 'vitest';

import { endingOf, isPicture, parseTable, previewKind, textOfBytes } from './attachmentKind';

describe('what an attachment is', () => {
  it('reads the ending of a name', () => {
    expect(endingOf('Report.Final.PDF')).toBe('pdf');
    expect(endingOf('folder/notes.md')).toBe('md');
    expect(endingOf('Makefile')).toBe('makefile');
    expect(endingOf('.gitignore')).toBe('gitignore');
    expect(endingOf('')).toBe('');
  });

  it('believes a type that says something, and the name when the type says nothing', () => {
    // A picture by its type, whatever it is called.
    expect(isPicture('image/png', 'chart')).toBe(true);
    expect(isPicture('IMAGE/JPEG', 'photo.heic')).toBe(true);
    // An unknown file with a picture's name is a picture.
    expect(isPicture('application/octet-stream', 'saved.jpg')).toBe(true);
    expect(isPicture('', 'drawing.svg')).toBe(true);
    // Something that says it is something else is that.
    expect(isPicture('application/pdf', 'scan.jpg')).toBe(false);
    expect(isPicture('application/octet-stream', 'archive.zip')).toBe(false);
  });

  it('finds the preview for what can be read', () => {
    expect(previewKind('application/pdf', 'paper.pdf')).toBe('pdf');
    expect(previewKind('application/octet-stream', 'paper.pdf')).toBe('pdf');
    expect(previewKind('application/epub+zip', 'novel.epub')).toBe('book');
    expect(previewKind('application/octet-stream', 'novel.epub')).toBe('book');
    expect(previewKind('text/markdown', 'README.md')).toBe('markdown');
    expect(previewKind('text/plain', 'notes.markdown')).toBe('markdown');
    expect(previewKind('text/csv', 'data.csv')).toBe('table');
    expect(previewKind('application/octet-stream', 'data.tsv')).toBe('table');
    expect(previewKind('application/zip', 'bundle.zip')).toBe('archive');
    expect(previewKind('application/x-zip-compressed', 'bundle')).toBe('archive');
    // Source code under the types it is found under.
    expect(previewKind('text/plain', 'solve.py')).toBe('text');
    expect(previewKind('application/octet-stream', 'solve.py')).toBe('text');
    expect(previewKind('text/x-script.phyton', 'solve.py')).toBe('text');
    expect(previewKind('text/css; charset=utf-8', 'site.css')).toBe('text');
    expect(previewKind('application/xml', 'settings')).toBe('text');
    expect(previewKind('application/octet-stream', 'key.pem')).toBe('text');
  });

  it('offers none for what is shown in the note already, or cannot be read here', () => {
    expect(previewKind('image/svg+xml', 'drawing.svg')).toBeNull();
    expect(previewKind('image/png', 'looks-like.txt')).toBeNull();
    expect(previewKind('audio/mpeg', 'talk.mp3')).toBeNull();
    expect(previewKind('video/mp4', 'clip.mp4')).toBeNull();
    expect(previewKind('application/vnd.ms-word', 'letter.doc')).toBeNull();
    expect(previewKind('application/octet-stream', 'program.exe')).toBeNull();
    expect(previewKind('application/octet-stream', '')).toBeNull();
    // An office document is an archive inside, and is not listed as one.
    expect(
      previewKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'letter.docx'),
    ).toBeNull();
  });
});

describe('a table of text', () => {
  it('is divided as spreadsheets write it: quotes, doubled quotes, lines inside a value', () => {
    const text = 'name,note\r\n"Smith, Ada","said ""no"""\r\nBo,"two\nlines"\r\n\r\nlast,\r\n';
    expect(parseTable(text, 100)).toEqual({
      rows: [
        ['name', 'note'],
        ['Smith, Ada', 'said "no"'],
        ['Bo', 'two\nlines'],
        ['last', ''],
      ],
      more: false,
    });
  });

  it('finds the divider the file uses', () => {
    expect(parseTable('a\tb\tc\n1\t2\t3', 10).rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
    expect(parseTable('\uFEFFa;b\n"1,5";2', 10).rows).toEqual([
      ['a', 'b'],
      ['1,5', '2'],
    ]);
  });

  it('stops at the number of rows it is given, and says that there are more', () => {
    const { rows, more } = parseTable('1\n2\n3\n4\n', 2);
    expect(rows).toEqual([['1'], ['2']]);
    expect(more).toBe(true);
    expect(parseTable('1\n2\n', 2).more).toBe(false);
  });
});

describe('the text of a file', () => {
  const bytes = (...values: number[]) => Uint8Array.from(values);

  it('is read as UTF-8, with or without its mark', () => {
    expect(textOfBytes(new TextEncoder().encode('Grüße, 世界'))).toBe('Grüße, 世界');
    expect(textOfBytes(bytes(0xef, 0xbb, 0xbf, 0x68, 0x69))).toBe('hi');
    // Cut off in the middle of a letter, it is still that.
    expect(textOfBytes(new TextEncoder().encode('Grüße').subarray(0, 3))).toBe('Gr\uFFFD');
  });

  it('is read as older Windows text when it is not UTF-8, and as UTF-16 when it says so', () => {
    expect(textOfBytes(bytes(0x47, 0x72, 0xfc, 0xdf, 0x65, 0x20, 0x61, 0x62, 0x63))).toBe('Grüße abc');
    expect(textOfBytes(bytes(0xff, 0xfe, 0x68, 0x00, 0x69, 0x00))).toBe('hi');
    expect(textOfBytes(bytes(0xfe, 0xff, 0x00, 0x68, 0x00, 0x69))).toBe('hi');
  });
});
