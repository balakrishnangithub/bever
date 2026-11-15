import type {
  EvernoteAccount,
  ImportOutcome,
  LibrarySnapshot,
  Note,
  NoteFilter,
  NoteOrganizationAction,
  NotePage,
  NoteVersion,
  NoteSummary,
  Overview,
  PCloudStatus,
  Resource,
  SaveNote,
  SavedNote,
  Settings,
  ShortcutTarget,
  SyncRun,
  SyncStatus,
} from '../types';
import { chosenThumbnail } from '../types';
import type { BeverApi } from './api';
import { byName } from './nameOrder';
import {
  colorNumber,
  drawStroke,
  freeStroke,
  lineStroke,
  newInk,
  pictureFrame,
  rectangleStroke,
  serializeInk,
} from '../editor/ink';
import { writeAnnotations, writeInk } from '../editor/pngChunks';
import { drawMarks, newDocument, shapeMark, textMark, withMarks } from '../editor/skitch';
import { registerDemoResource } from './demoResources';
import { SNIPPET_END, SNIPPET_START } from './snippet';

/**
 * Browser-only demonstration adapter with sample notes held in memory.
 * It exists to develop and test the interface; the native application always
 * uses the Rust core. `?demoNotes=300` adds that many filler notes.
 */
const now = Date.now();
const inboxId = crypto.randomUUID();
const notes = new Map<string, Note>();
const snapshot: LibrarySnapshot = {
  stacks: [{ id: 'stack-learning', name: 'Learning', createdAt: now, updatedAt: now, revision: 1 }],
  notebooks: [
    { id: inboxId, name: 'Inbox', stackId: null, createdAt: now, updatedAt: now, revision: 1 },
    {
      id: 'notebook-reading',
      name: 'Reading',
      stackId: 'stack-learning',
      createdAt: now,
      updatedAt: now,
      revision: 1,
    },
  ],
  tags: [
    { id: 'tag-local', name: 'local-first', parentId: null, color: null, createdAt: now, updatedAt: now },
    { id: 'tag-ideas', name: 'ideas', parentId: null, color: null, createdAt: now, updatedAt: now },
    // A family of nested tags, with numbers in their names.
    { id: 'tag-course', name: 'Course', parentId: null, color: null, createdAt: now, updatedAt: now },
    ...['course | 10 Review', 'course | 2 Equations', 'course | 1 Introduction'].map((name, index) => ({
      id: `tag-course-${index}`,
      name,
      parentId: 'tag-course',
      color: null,
      createdAt: now,
      updatedAt: now,
    })),
    {
      id: 'tag-course-lesson',
      name: 'course | 1 | 1 First lesson',
      parentId: 'tag-course-2',
      color: null,
      createdAt: now,
      updatedAt: now,
    },
  ],
  shortcuts: [],
};
const settings: Settings = { ocrEnabled: false, loadRemoteImages: false };
const disconnected: PCloudStatus = {
  connected: false,
  email: null,
  hostname: 'api.pcloud.com',
  lastSyncAt: null,
  authorizationPending: false,
};

function addDemo(note: Note) {
  notes.set(note.id, note);
}

addDemo({
  id: 'welcome',
  notebookId: inboxId,
  title: 'Welcome to Bever',
  contentHtml:
    '<h1>Your notes, fully yours.</h1><p>Bever is <strong>local-first</strong>, open source, and works completely offline. Your library is stored on your device—not on a server.</p><blockquote><p>Try the formatting tools, create a checklist, or attach a file.</p></blockquote><ul data-type="taskList"><li data-type="taskItem" data-checked="true">Private by default</li><li data-type="taskItem" data-checked="false">Make this note your own</li></ul><p>Search supports <code>intitle:</code>, <code>tag:</code>, <code>notebook:</code>, phrases, prefixes, and negation.</p>',
  originalEnml: null,
  plainText: 'Your notes, fully yours. Bever is local-first, open source, and works completely offline.',
  createdAt: now - 100000,
  updatedAt: now - 100000,
  deletedAt: null,
  attributes: { author: 'Bever' },
  evernoteGuid: null,
  revision: 1,
  tags: ['local-first', 'ideas'],
  resources: [],
});
addDemo({
  id: 'enex-guide',
  notebookId: 'notebook-reading',
  title: 'Bring your notes along',
  contentHtml:
    '<h2>Lossless by design</h2><p>Import an <strong>.enex</strong> file from the sidebar. Bever keeps the original ENML, note metadata, attachments, and OCR text while making the note editable.</p><hr><p>Use <mark>ENEX export</mark> whenever you want a portable backup.</p><p>Evernote highlights such as <span style="--en-highlight:yellow;background-color: #ffef9e;">this one</span> and code blocks are kept:</p><div style="--en-codeblock:true;"><div>let notes = import("library.enex");</div><div>notes.search("offline");</div></div><p>See also <a href="bever://note/welcome">Welcome to Bever</a>.</p>',
  originalEnml: null,
  plainText: 'Bring your notes along. Lossless by design. Import an ENEX file.',
  createdAt: now - 200000,
  updatedAt: now - 200000,
  deletedAt: null,
  attributes: {},
  evernoteGuid: null,
  tags: ['ideas'],
  resources: [],
  revision: 1,
});
addDemo({
  id: 'pdf-preview-demo',
  notebookId: 'notebook-reading',
  title: 'Local attachment preview',
  contentHtml:
    '<h2>Attachments stay usable offline</h2><p>Right-click any attachment for its actions, or preview this public two-page PDF locally.</p><p><en-media hash="demo-pdf" type="application/pdf" title="Bever preview.pdf"></en-media></p>',
  originalEnml: null,
  plainText: 'Local attachment preview. Attachments stay usable offline.',
  createdAt: now - 300000,
  updatedAt: now - 300000,
  deletedAt: null,
  attributes: {},
  evernoteGuid: null,
  tags: ['ideas'],
  resources: [
    {
      id: 'demo-pdf-resource',
      noteId: 'pdf-preview-demo',
      sha256: 'demo-pdf',
      md5: 'demo-pdf',
      mime: 'application/pdf',
      fileName: 'Bever preview.pdf',
      size: 1800,
      width: null,
      height: null,
      duration: null,
      recognitionXml: null,
      recognitionText: null,
      attributes: { 'file-name': 'Bever preview.pdf', attachment: true },
      alternateSha256: null,
      position: 0,
    },
  ],
  revision: 1,
});

const fillerCount = Number(new URLSearchParams(window.location.search).get('demoNotes') ?? 0);
for (let index = 0; index < Math.min(fillerCount, 5000); index += 1) {
  const number = String(index + 1).padStart(4, '0');
  addDemo({
    id: `filler-${number}`,
    notebookId: inboxId,
    title: `Field note ${number}`,
    contentHtml: `<p>Observation ${number}: the library stays quick with many notes.</p>`,
    plainText: `Observation ${number}: the library stays quick with many notes.`,
    originalEnml: null,
    createdAt: now - 400000 - index * 60000,
    updatedAt: now - 400000 - index * 60000,
    deletedAt: null,
    attributes: {},
    evernoteGuid: null,
    tags: [],
    resources: [],
    revision: 1,
  });
}

// `?demoClip` adds a note holding a web clipping, as Evernote exports one:
// the page's own elements with inline styles inside a marked wrapper.
if (new URLSearchParams(window.location.search).has('demoClip')) {
  registerDemoResource(
    'demo-clip-image',
    `data:image/svg+xml;utf8,${encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 150"><rect width="220" height="150" fill="#bfe3d0"/><path d="M0 110 Q60 80 110 105 T220 95 V150 H0Z" fill="#5b9bd5"/><path d="M60 100 l40 -30 40 30z" fill="#8a5a3c"/></svg>',
    )}`,
  );
  const link =
    'color:rgb(255, 255, 255);text-decoration:none;font-weight:700;text-transform:uppercase;font-size:13px;';
  const card = 'flex:1;background:rgb(238, 242, 247);padding:12px;border-radius:8px;font-size:14px;';
  const clipping =
    '<div style="--en-clipped-content:article; --en-clipped-source-url:https://example.com/beavers?ref=demo&amp;lang=en; --en-clipped-source-title:Why beavers build;">' +
    '<div style="min-height: 100vh; font-size: 16px; display: block; position: relative;">' +
    '<div style="position:fixed;top:0px;left:0px;right:0px;z-index:99;padding:8px;background:rgb(200, 0, 0);color:rgb(255, 255, 255);">Subscribe to keep reading</div>' +
    '<ul style="display:flex;list-style:none;margin:0px;padding:0px;background:rgb(24, 49, 83);">' +
    `<li style="padding:10px 14px;"><a rel="noopener" href="https://example.com/news" style="${link}">News</a></li>` +
    `<li style="padding:10px 14px;"><a rel="noopener" href="https://example.com/nature" style="${link}">Nature</a></li>` +
    `<li style="padding:10px 14px;"><a rel="noopener" href="bever://note/welcome" style="${link}">Welcome</a></li></ul>` +
    '<h1 style="font-family:Georgia, serif;font-size:34px;line-height:1.15;margin:22px 0px 6px;color:rgb(24, 49, 83);">Why beavers build</h1>' +
    '<div style="color:rgb(110, 110, 110);font-size:13px;text-transform:uppercase;letter-spacing:1px;">By A. Castor · 6 min read</div>' +
    '<en-media hash="demo-clip-image" type="image/svg+xml" width="220" height="150" style="float:right;margin:8px 0px 8px 18px;border-radius:10px;"></en-media>' +
    '<p style="font-family:Georgia, serif;font-size:18px;line-height:1.6;">A dam turns a stream into a pond, and a pond keeps a lodge safe. The clipping keeps the layout of the page it came from.</p>' +
    '<div style="background:rgb(255, 244, 214);border-left:4px solid rgb(240, 173, 0);padding:12px 16px;margin:16px 0px;font-style:italic;">“Still water is a locked door.”</div>' +
    '<img src="https://example.com/remote-figure.png" width="300" height="100" alt="A figure on the web">' +
    `<div style="display:flex;gap:12px;clear:both;"><div style="${card}">Related: wetlands</div><div style="${card}">Related: lodges</div></div>` +
    '</div></div>';
  addDemo({
    id: 'web-clip-demo',
    notebookId: 'notebook-reading',
    title: 'Clipped: Why beavers build',
    contentHtml: `<div>My own remark above the clipping.</div>${clipping}<p><img src="https://example.com/outside-the-clipping.png" alt="An image on the web"></p><div>And a line below it.</div>`,
    originalEnml: null,
    plainText: 'My own remark above the clipping. Why beavers build. A dam turns a stream into a pond.',
    createdAt: now - 350000,
    updatedAt: now - 350000,
    deletedAt: null,
    attributes: { 'source-url': 'https://example.com/beavers' },
    evernoteGuid: null,
    tags: [],
    resources: [
      {
        id: 'demo-clip-image-resource',
        noteId: 'web-clip-demo',
        sha256: 'demo-clip-image',
        md5: 'demo-clip-image',
        mime: 'image/svg+xml',
        fileName: 'pond.svg',
        size: 320,
        width: 220,
        height: 150,
        duration: null,
        recognitionXml: null,
        recognitionText: null,
        attributes: {},
        alternateSha256: null,
        position: 0,
      },
    ],
    revision: 1,
  });
}

// `?demoMany=1500` adds that many notes, for a list far longer than a window.
{
  const many = Number(new URLSearchParams(window.location.search).get('demoMany'));
  for (let index = 1; index <= many; index += 1) {
    addDemo({
      id: `many-${index}`,
      notebookId: inboxId,
      title: `Many ${String(index).padStart(4, '0')}`,
      contentHtml: `<p>Note ${index} of many.</p>`,
      originalEnml: null,
      plainText: `Note ${index} of many.`,
      createdAt: now - 1_000_000 - index * 1000,
      updatedAt: now - 1_000_000 - index * 1000,
      deletedAt: null,
      attributes: {},
      evernoteGuid: null,
      tags: [],
      resources: [],
      revision: 1,
    });
  }
}

// `?demoGroups` adds notebooks and tags named in families, a note whose
// title needs several lines, and a note with laid-out HTML pasted into it.
if (new URLSearchParams(window.location.search).has('demoGroups')) {
  const family = ['Feeds Astronomy', 'Feeds CS', 'Feeds CS - AI', 'Feeds CS - Go', 'Recipes'];
  for (const name of family) {
    const id = `notebook-${name.toLowerCase().replace(/[^a-z]+/g, '-')}`;
    snapshot.notebooks.push({ id, name, stackId: null, createdAt: now, updatedAt: now, revision: 1 });
    snapshot.tags.push({
      id: `tag-${id}`,
      name,
      parentId: null,
      color: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  const box = 'box-sizing: border-box;';
  const formula =
    `<span style="${box} font: 400 1.21em / 1.2 KaTeX_Main, &quot;Times New Roman&quot;, serif; color: rgb(22, 22, 22);">` +
    `<span style="${box} position: absolute; clip: rect(1px, 1px, 1px, 1px); padding: 0px; border: 0px; height: 1px; width: 1px; overflow: hidden;"><span>x to the power of one half</span></span>` +
    `<span style="${box} position: relative; white-space: nowrap; width: min-content; display: inline-block;">` +
    `<span style="${box} display: inline-block; height: 0.99em; vertical-align: -0.04em;"></span>` +
    `<span style="${box} font-family: KaTeX_Math; font-style: italic;">x</span>` +
    `<span style="${box} display: inline-table; table-layout: fixed;"><span style="${box} display: table-row;">` +
    `<span style="${box} display: table-cell; vertical-align: bottom; position: relative; top: -0.5em; font-size: 0.7em;">1/2</span>` +
    '</span></span></span></span>';
  addDemo({
    id: 'long-title-demo',
    notebookId: 'notebook-feeds-cs-ai',
    title:
      'Fractional exponents, tough: a title long enough that it has to continue on a second and even a third line of the page before it ends',
    contentHtml:
      '<div><b>Quiz</b></div>' +
      `<div><span style="color: rgb(22, 22, 22); font-family: Arial, sans-serif;">Simplify </span>${formula}</div>` +
      '<div>My answer goes here, with <a href="https://example.com/exponents">a web link</a> and a link to <a href="bever://note/welcome">the welcome note</a>.</div>' +
      Array.from({ length: 40 }, (_, line) => `<div>Working, line ${line + 1}.</div>`).join(''),
    originalEnml: null,
    plainText: 'Quiz. Simplify x. My answer goes here.',
    createdAt: now - 360000,
    updatedAt: now - 360000,
    deletedAt: null,
    attributes: {},
    evernoteGuid: null,
    tags: ['Feeds CS - AI'],
    resources: [],
    revision: 1,
  });
}

// `?demoAnnotated` adds a note with a picture that carries annotations the
// way Evernote stores them: the finished picture, and inside the same file
// the original and a document that lists every mark.
if (new URLSearchParams(window.location.search).has('demoAnnotated')) {
  const guid = '1a642354-b7d3-4082-b97b-1cf9fd6f33ee';
  const pen = { color: '#e8262d', width: 6 };
  const marks = [
    shapeMark('rectangle', { x: 100, y: 60 }, { x: 200, y: 140 }, pen, 'demo-rectangle'),
    shapeMark('arrow', { x: 330, y: 220 }, { x: 250, y: 150 }, pen, 'demo-arrow'),
    textMark('Out of domain', { x: 230, y: 30 }, 24, '#e8262d', 'demo-text'),
  ];
  const canvas = document.createElement('canvas');
  canvas.width = 420;
  canvas.height = 260;
  const context = canvas.getContext('2d');
  const bytesOf = () =>
    new Promise<Uint8Array>((done) =>
      canvas.toBlob(
        (blob) => void blob?.arrayBuffer().then((buffer) => done(new Uint8Array(buffer))),
        'image/png',
      ),
    );
  if (context) {
    context.fillStyle = '#dbe7f3';
    context.fillRect(0, 0, 420, 260);
    context.fillStyle = '#a3501e';
    context.fillRect(40, 190, 340, 6);
    void (async () => {
      const original = await bytesOf();
      drawMarks(context, marks);
      const file = writeAnnotations(await bytesOf(), {
        manifest: withMarks(newDocument(420, 260, guid), marks),
        originals: [{ guid, bytes: original }],
      });
      registerDemoResource(
        'demo-annotated',
        URL.createObjectURL(new Blob([file as BlobPart], { type: 'image/png' })),
      );
    })();
  }
  addDemo({
    id: 'annotated-picture-demo',
    notebookId: inboxId,
    title: 'A picture with annotations',
    contentHtml:
      '<div>Annotated in Evernote:</div>' +
      '<en-media style="--en-naturalWidth:420; --en-naturalHeight:260;" width="420px" hash="demo-annotated" type="image/png"></en-media>' +
      '<div>Text after it.</div>',
    originalEnml: null,
    plainText: 'Annotated in Evernote. Text after it.',
    createdAt: now - 380000,
    updatedAt: now - 380000,
    deletedAt: null,
    attributes: {},
    evernoteGuid: null,
    tags: [],
    resources: [
      {
        id: 'demo-annotated-resource',
        noteId: 'annotated-picture-demo',
        sha256: 'demo-annotated',
        md5: 'demo-annotated',
        mime: 'image/png',
        fileName: 'graph.png',
        size: 4000,
        width: 420,
        height: 260,
        duration: null,
        recognitionXml: null,
        recognitionText: null,
        attributes: {},
        alternateSha256: null,
        position: 0,
      },
    ],
    revision: 1,
  });
}

// `?demoSketch` adds a note with a sketch the way Evernote stores one: a
// picture of the strokes, and inside the same file the strokes themselves.
// As in Evernote, the strokes lie somewhere on a canvas without edges, and
// the picture shows only the part they cover.
if (new URLSearchParams(window.location.search).has('demoSketch')) {
  const red = colorNumber('#ea4643');
  const strokes = [
    freeStroke(
      Array.from({ length: 24 }, (_, index) => ({
        x: 300 + index * 8,
        y: 200 + Math.sin(index / 3) * 12,
        time: index * 16,
        pressure: null,
      })),
      { color: '#000000', size: 1.5 },
      false,
    ),
    rectangleStroke({ left: 300, top: 240, right: 420, bottom: 300 }, red, 4),
    lineStroke(300, 330, 480, 330, colorNumber('#5b1a7b'), 4),
    freeStroke(
      [
        { x: 300, y: 360, time: 0, pressure: null },
        { x: 480, y: 360, time: 200, pressure: null },
      ],
      { color: '#fae356', size: 24.4 },
      true,
    ),
  ];
  const frame = pictureFrame(strokes) ?? { left: 0, top: 0, right: 1, bottom: 1 };
  const width = frame.right - frame.left;
  const height = frame.bottom - frame.top;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.translate(-frame.left, -frame.top);
    for (const stroke of strokes) drawStroke(context, stroke);
    canvas.toBlob((blob) => {
      void blob
        ?.arrayBuffer()
        .then((buffer) =>
          writeInk(new Uint8Array(buffer), {
            name: 'demo-sketch',
            inkml: serializeInk({ ...newInk('demo-sketch', now), width, height, pattern: 3, strokes }),
            width,
            height,
          }),
        )
        .then((file) =>
          registerDemoResource(
            'demo-sketch',
            URL.createObjectURL(new Blob([file as BlobPart], { type: 'image/png' })),
          ),
        );
    }, 'image/png');
  }
  addDemo({
    id: 'sketch-demo',
    notebookId: inboxId,
    title: 'A sketch',
    contentHtml:
      '<div>Sketched in Evernote:</div>' +
      `<en-media style="--en-naturalWidth:${width}; --en-naturalHeight:${height};" width="${width}px" hash="demo-sketch" type="image/png"></en-media>` +
      '<div>Text after it.</div>',
    originalEnml: null,
    plainText: 'Sketched in Evernote. Text after it.',
    createdAt: now - 390000,
    updatedAt: now - 390000,
    deletedAt: null,
    attributes: {},
    evernoteGuid: null,
    tags: [],
    resources: [
      {
        id: 'demo-sketch-resource',
        noteId: 'sketch-demo',
        sha256: 'demo-sketch',
        md5: 'demo-sketch',
        mime: 'image/png',
        fileName: 'Sketch 3/22/2022 1:29 AM.png',
        size: 4000,
        width,
        height,
        duration: null,
        recognitionXml: null,
        recognitionText: null,
        attributes: {},
        alternateSha256: null,
        position: 0,
      },
    ],
    revision: 1,
  });
}

// `?demoImages` adds a note whose pictures have sizes and an alignment, the
// way Evernote writes them.
if (new URLSearchParams(window.location.search).has('demoImages')) {
  const pictures: [string, number, number, string][] = [
    ['demo-picture-a', 350, 266, '#bfe3d0'],
    ['demo-picture-b', 370, 388, '#f6d9a8'],
    ['demo-picture-c', 643, 150, '#c9d8f2'],
  ];
  // The words a picture shows, with the rectangle each one stands in.
  const words: Record<string, [string, number, number, number, number][]> = {
    'demo-picture-a': [
      ['Domain', 24, 22, 112, 34],
      ['Range', 238, 216, 90, 34],
    ],
    'demo-picture-c': [['Interval', 30, 56, 120, 36]],
  };
  for (const [reference, width, height, color] of pictures) {
    const text = (words[reference] ?? [])
      .map(
        ([word, x, y, , h]) =>
          `<text x="${x + 2}" y="${y + h - 8}" font-family="Arial, sans-serif" font-size="${h - 4}" fill="#12352a">${word}</text>`,
      )
      .join('');
    registerDemoResource(
      reference,
      `data:image/svg+xml;utf8,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${color}"/><circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 4}" fill="#a3501e"/>${text}</svg>`,
      )}`,
    );
  }
  const recognition = (reference: string, width: number, height: number) =>
    reference === 'demo-picture-a'
      ? `<recoIndex docType="printed" objType="image" objID="${reference}" recoType="service" lang="en" objWidth="${width}" objHeight="${height}">${(
          words[reference] ?? []
        )
          .map(
            ([word, x, y, w, h]) => `<item x="${x}" y="${y}" w="${w}" h="${h}"><t w="90">${word}</t></item>`,
          )
          .join('')}</recoIndex>`
      : null;
  addDemo({
    id: 'sized-pictures-demo',
    notebookId: inboxId,
    title: 'Domain and range, with pictures',
    contentHtml:
      '<div><b>Example</b></div>' +
      '<en-media style="--en-naturalWidth:350; --en-naturalHeight:266;" width="250px" hash="demo-picture-a" type="image/svg+xml"></en-media>' +
      '<en-media style="--en-naturalWidth:370; --en-naturalHeight:388;" width="163px" hash="demo-picture-b" type="image/svg+xml"></en-media>' +
      '<div>Text between the pictures.</div>' +
      '<en-media style="--en-naturalWidth:643; --en-naturalHeight:150; --en-imageAlignment:center;" width="400px" hash="demo-picture-c" type="image/svg+xml"></en-media>' +
      '<div>Text after them: the range is an interval.</div>',
    originalEnml: null,
    plainText: 'Example. Text between the pictures. Text after them: the range is an interval.',
    createdAt: now - 370000,
    updatedAt: now - 370000,
    deletedAt: null,
    attributes: {},
    evernoteGuid: null,
    tags: [],
    resources: pictures.map(([reference, width, height], position) => ({
      id: `${reference}-resource`,
      noteId: 'sized-pictures-demo',
      sha256: reference,
      md5: reference,
      mime: 'image/svg+xml',
      fileName: `${reference}.svg`,
      size: 300,
      width,
      height,
      duration: null,
      recognitionXml: recognition(reference, width, height),
      // The last picture's text is known without its places, as it is for a
      // picture whose words could not be placed.
      recognitionText: (words[reference] ?? []).map(([word]) => word).join(' ') || null,
      attributes: {},
      alternateSha256: null,
      position,
    })),
    revision: 1,
  });
}

function textOf(html: string) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  return document.body.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function overview(): Overview {
  const live = [...notes.values()].filter((note) => note.deletedAt === null);
  const notebooks: Record<string, number> = {};
  const tags: Record<string, number> = {};
  for (const note of live) {
    notebooks[note.notebookId] = (notebooks[note.notebookId] ?? 0) + 1;
    for (const name of note.tags) {
      const tag = snapshot.tags.find((item) => item.name.toLowerCase() === name.toLowerCase());
      if (tag) tags[tag.id] = (tags[tag.id] ?? 0) + 1;
    }
  }
  const named = <T extends { name: string }>(items: T[]) => [...items].sort((a, b) => byName(a.name, b.name));
  return structuredClone({
    stacks: named(snapshot.stacks),
    notebooks: named(snapshot.notebooks),
    tags: named(snapshot.tags),
    shortcuts: snapshot.shortcuts,
    counts: { all: live.length, trash: notes.size - live.length, notebooks, tags },
  });
}

function ensureTag(name: string, parentId: string | null = null) {
  if (!snapshot.tags.some((tag) => tag.name.toLowerCase() === name.toLowerCase())) {
    snapshot.tags.push({
      id: crypto.randomUUID(),
      name,
      parentId,
      color: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
}

function requireFreeName(items: { id: string; name: string }[], name: string, id: string, kind: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('name cannot be empty');
  if (items.some((item) => item.id !== id && item.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error(`a ${kind} named “${trimmed}” already exists`);
  }
  return trimmed;
}

function dropShortcut(targetType: ShortcutTarget, targetId: string) {
  snapshot.shortcuts = snapshot.shortcuts.filter(
    (item) => !(item.targetType === targetType && item.targetId === targetId),
  );
}

function relabelShortcut(targetType: ShortcutTarget, targetId: string, label: string) {
  for (const shortcut of snapshot.shortcuts) {
    if (shortcut.targetType === targetType && shortcut.targetId === targetId) shortcut.label = label;
  }
}

/** A small imitation of the native search: words must all match, as prefixes. */
function matcher(query: string) {
  const terms = (query.toLowerCase().match(/"[^"]*"?|\S+/g) ?? []).map((term) => term.replaceAll('"', ''));
  const words: string[] = [];
  const tests: ((note: Note) => boolean)[] = [];
  for (const term of terms) {
    const [label, value] = term.includes(':') ? term.split(/:(.*)/s) : [null, term];
    if (label === 'tag') tests.push((note) => note.tags.some((tag) => tag.toLowerCase() === value));
    else if (label === 'intitle') tests.push((note) => note.title.toLowerCase().includes(value ?? ''));
    else if (label === 'notebook')
      tests.push(
        (note) =>
          snapshot.notebooks.find((item) => item.id === note.notebookId)?.name.toLowerCase() === value,
      );
    else if (term) words.push(term);
  }
  const wordStart = (text: string, word: string) =>
    new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'iu').test(text);
  for (const word of words) {
    tests.push((note) =>
      wordStart(
        `${note.title} ${note.plainText} ${note.tags.join(' ')} ${note.resources
          .map((resource) => resource.recognitionText ?? '')
          .join(' ')}`,
        word,
      ),
    );
  }
  return { words, matches: (note: Note) => tests.every((test) => test(note)) };
}

function snippetFor(note: Note, words: string[]) {
  const text = note.plainText;
  if (!words.length) return text.slice(0, 320);
  const lower = text.toLowerCase();
  const first = Math.min(...words.map((word) => lower.indexOf(word)).filter((index) => index >= 0), Infinity);
  if (!Number.isFinite(first)) return text.slice(0, 320);
  const start = Math.max(0, first - 60);
  let excerpt = (start > 0 ? '…' : '') + text.slice(start, start + 260);
  for (const word of words) {
    excerpt = excerpt.replace(
      new RegExp(`(^|[^\\p{L}\\p{N}])(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\p{L}\\p{N}]*)`, 'giu'),
      `$1${SNIPPET_START}$2${SNIPPET_END}`,
    );
  }
  return excerpt;
}

/** The picture that stands for a note: the one chosen, or else the largest. */
function thumbnailOf(note: Note): string | null {
  const shown = note.resources.filter(
    (resource) => resource.mime.startsWith('image/') && note.contentHtml.includes(resource.md5),
  );
  const chosen = chosenThumbnail(note.attributes);
  const pictures = shown
    .filter((resource) => (resource.width ?? 48) >= 48 && (resource.height ?? 48) >= 48)
    .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
  return (shown.find((resource) => resource.md5 === chosen) ?? pictures[0])?.sha256 ?? null;
}

function listNotes(filter: NoteFilter): NotePage {
  const { words, matches } = matcher(filter.query);
  const stackNotebooks = filter.stackId
    ? new Set(snapshot.notebooks.filter((item) => item.stackId === filter.stackId).map((item) => item.id))
    : null;
  const order: Record<string, (a: Note, b: Note) => number> = {
    updatedAsc: (a, b) => a.updatedAt - b.updatedAt,
    createdDesc: (a, b) => b.createdAt - a.createdAt,
    createdAsc: (a, b) => a.createdAt - b.createdAt,
    titleAsc: (a, b) => byName(a.title, b.title),
    titleDesc: (a, b) => byName(b.title, a.title),
  };
  const all = [...notes.values()]
    .filter((note) =>
      filter.trashOnly ? note.deletedAt !== null : filter.includeTrash || note.deletedAt === null,
    )
    .filter((note) => !filter.notebookId || note.notebookId === filter.notebookId)
    .filter((note) => !stackNotebooks || stackNotebooks.has(note.notebookId))
    .filter((note) =>
      filter.tagIds.every((id) => note.tags.includes(snapshot.tags.find((tag) => tag.id === id)?.name ?? '')),
    )
    .filter((note) => !filter.contains || containsKind(note, filter.contains))
    .filter(matches)
    .sort(order[filter.sort] ?? ((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)));
  const page = all.slice(filter.offset, filter.offset + filter.limit).map((note): NoteSummary => ({
    id: note.id,
    notebookId: note.notebookId,
    notebookName: snapshot.notebooks.find((item) => item.id === note.notebookId)?.name ?? 'Inbox',
    title: note.title,
    snippet: snippetFor(note, words),
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    deletedAt: note.deletedAt,
    tags: note.tags,
    hasAttachments: note.resources.length > 0,
    isShortcut: snapshot.shortcuts.some((item) => item.targetType === 'note' && item.targetId === note.id),
    thumbnail: thumbnailOf(note),
  }));
  return { notes: page, total: all.length };
}

function containsKind(note: Note, kind: string) {
  const html = note.contentHtml;
  const mime = (prefix: string) => note.resources.some((resource) => resource.mime.startsWith(prefix));
  switch (kind) {
    case 'images':
      return mime('image/');
    case 'audio':
      return mime('audio/');
    case 'video':
      return mime('video/');
    case 'pdf':
      return mime('application/pdf');
    case 'files':
      return note.resources.length > 0;
    case 'checklist':
      return html.includes('taskItem') || html.includes('<en-todo');
    case 'table':
      return html.includes('<table');
    case 'code':
      return html.includes('<pre') || html.includes('--en-codeblock');
    case 'links':
      return html.includes('<a ');
    default:
      return true;
  }
}

/** The forms kept of each note, the oldest first, as the core keeps them. */
const versions = new Map<string, { id: number; keptAt: number; note: Note }[]>();
let versionCount = 0;

function keepVersion(note: Note): number | null {
  if (!note.title.trim() && !note.plainText.trim() && !note.resources.length) return null;
  const kept = versions.get(note.id) ?? [];
  const newest = kept.at(-1);
  if (
    newest &&
    newest.note.title === note.title &&
    newest.note.contentHtml === note.contentHtml &&
    JSON.stringify(newest.note.tags) === JSON.stringify(note.tags) &&
    JSON.stringify(newest.note.attributes) === JSON.stringify(note.attributes)
  )
    return newest.id;
  versionCount += 1;
  versions.set(
    note.id,
    [...kept, { id: versionCount, keptAt: Date.now(), note: structuredClone(note) }].slice(-5),
  );
  return versionCount;
}

function requireNote(id: string): Note {
  const note = notes.get(id);
  if (!note) throw new Error('Note not found');
  return note;
}

function demo<Args extends unknown[], Result>(operation: (...args: Args) => Result) {
  return (...args: Args): Promise<Result> => Promise.resolve().then(() => operation(...args));
}

const nativeOnly = (feature: string) => () => {
  throw new Error(`${feature} is available in the native Bever app.`);
};

// A synchronization that only pretends, with `?demoSync`: forty notes go
// "up", four a second, and nothing leaves the page. It is there so that
// starting, stopping and the record of runs can be looked at in a browser.
const demoSync = new URLSearchParams(window.location.search).has('demoSync');
const demoSyncTotal = 40;
const idleSync: SyncStatus = {
  revision: 0,
  runId: 0,
  running: false,
  stopping: false,
  progress: {
    phase: 'idle',
    message: 'Synchronize when you are ready',
    current: 0,
    total: 0,
    elapsedMs: 0,
    networkMs: 0,
    remoteRequests: 0,
    bytesUploaded: 0,
    bytesDownloaded: 0,
    retries: 0,
  },
  lastReport: null,
  error: null,
  stopped: false,
};
let syncState: SyncStatus = structuredClone(idleSync);
let syncTimer = 0;

function pastRun(startedAgo: number, lasted: number, rest: Partial<SyncRun>): SyncRun {
  const startedAt = Date.now() - startedAgo;
  return {
    startedAt,
    activeAt: startedAt + lasted,
    endedAt: startedAt + lasted,
    outcome: 'complete',
    message: null,
    pushed: 0,
    pulled: 0,
    blobsUploaded: 0,
    blobsDownloaded: 0,
    bytesUploaded: 0,
    bytesDownloaded: 0,
    heldBack: 0,
    retries: 0,
    throttled: 0,
    ...rest,
  };
}

const hour = 3_600_000;
const minute = 60_000;
// One of each way a run can end.
const syncRuns: SyncRun[] = demoSync
  ? [
      pastRun(3 * hour, 95 * minute, {
        pushed: 4831,
        blobsUploaded: 7785,
        bytesUploaded: 6_700_000_000,
        heldBack: 1,
        retries: 3,
        throttled: 1,
      }),
      pastRun(27 * hour, 17 * minute, {
        outcome: 'failed',
        message:
          'network error: no connection to the storage service; this device may be offline (No such host is known. (os error 11001))',
        pushed: 1216,
        blobsUploaded: 2389,
        bytesUploaded: 1_290_000_000,
        retries: 5,
      }),
      pastRun(29 * hour, 12 * minute, {
        outcome: 'running',
        endedAt: null,
        pushed: 310,
        blobsUploaded: 498,
        bytesUploaded: 436_000_000,
      }),
      pastRun(50 * hour, 42_000, { outcome: 'stopped', pushed: 12, bytesUploaded: 90_000 }),
    ]
  : [];

function publishSync() {
  syncState = { ...syncState, revision: syncState.revision + 1 };
  window.dispatchEvent(new CustomEvent('bever:sync-status', { detail: structuredClone(syncState) }));
}

function endDemoSync(outcome: 'complete' | 'stopped') {
  if (!syncState.running) return;
  window.clearInterval(syncTimer);
  const now = Date.now();
  const { progress } = syncState;
  const going = syncRuns[0];
  if (going) {
    syncRuns[0] = {
      ...going,
      activeAt: now,
      endedAt: now,
      outcome,
      pushed: progress.current,
      bytesUploaded: progress.bytesUploaded,
    };
  }
  const complete = outcome === 'complete';
  syncState = {
    ...syncState,
    running: false,
    stopping: false,
    stopped: !complete,
    progress: complete ? { ...progress, phase: 'complete', message: 'Synchronization complete' } : progress,
    lastReport: complete
      ? {
          pushed: progress.current,
          pulled: 0,
          conflicts: 0,
          blobsUploaded: 0,
          blobsDownloaded: 0,
          syncedAt: now,
          durationMs: progress.elapsedMs,
          networkMs: 0,
          remoteRequests: progress.remoteRequests,
          bytesUploaded: progress.bytesUploaded,
          bytesDownloaded: 0,
          warnings: [],
          retries: 0,
          throttled: 0,
        }
      : null,
  };
  publishSync();
}

function startDemoSync(): SyncStatus {
  if (!demoSync) return nativeOnly('pCloud synchronization')();
  if (syncState.running) return structuredClone(syncState);
  const started = Date.now();
  syncRuns.unshift(pastRun(0, 0, { outcome: 'running', endedAt: null }));
  syncState = {
    ...structuredClone(idleSync),
    revision: syncState.revision,
    runId: syncState.runId + 1,
    running: true,
    progress: { ...idleSync.progress, phase: 'preparing', message: 'Preparing synchronization…' },
  };
  publishSync();
  syncTimer = window.setInterval(() => {
    const current = syncState.progress.current + 1;
    syncState = {
      ...syncState,
      progress: {
        ...syncState.progress,
        phase: 'pushing',
        message: syncState.stopping
          ? syncState.progress.message
          : `Uploading notes (${current} of ${demoSyncTotal}): Demo note ${current}`,
        current,
        total: demoSyncTotal,
        elapsedMs: Date.now() - started,
        remoteRequests: current + 2,
        bytesUploaded: current * 250_000,
      },
    };
    if (current >= demoSyncTotal) endDemoSync('complete');
    else publishSync();
  }, 250);
  return structuredClone(syncState);
}

function stopDemoSync(): SyncStatus {
  if (syncState.running && !syncState.stopping) {
    syncState = {
      ...syncState,
      stopping: true,
      progress: { ...syncState.progress, message: 'Stopping synchronization…' },
    };
    publishSync();
    // A real run ends within moments of being stopped; so does this one.
    window.setTimeout(() => endDemoSync('stopped'), 400);
  }
  return structuredClone(syncState);
}

export const browserApi: BeverApi = {
  bootstrap: demo(overview),
  listNotes: demo(listNotes),
  getNote: demo((id: string) => structuredClone(requireNote(id))),
  createNote: demo((notebookId: string | null) => {
    const timestamp = Date.now();
    const note: Note = {
      id: crypto.randomUUID(),
      notebookId: notebookId ?? inboxId,
      title: '',
      contentHtml: '<p></p>',
      originalEnml: null,
      plainText: '',
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
      attributes: {},
      evernoteGuid: null,
      revision: 1,
      tags: [],
      resources: [],
    };
    notes.set(note.id, note);
    return structuredClone(note);
  }),
  saveNote: demo((input: SaveNote): SavedNote => {
    const previous = requireNote(input.id);
    let conflictCopy: string | null = null;
    if (
      input.baseRevision !== null &&
      previous.revision !== input.baseRevision &&
      previous.contentHtml !== input.contentHtml
    ) {
      conflictCopy = `${previous.title || 'Untitled'} (conflict copy)`;
      const copyId = crypto.randomUUID();
      notes.set(copyId, { ...structuredClone(previous), id: copyId, title: conflictCopy, revision: 1 });
    }
    input.tags.forEach((tag) => ensureTag(tag));
    const note: Note = {
      ...previous,
      notebookId: input.notebookId,
      title: input.title.trim(),
      contentHtml: input.contentHtml,
      attributes: input.attributes,
      tags: input.tags,
      plainText: textOf(input.contentHtml),
      updatedAt: Date.now(),
      revision: previous.revision + 1,
    };
    notes.set(note.id, note);
    relabelShortcut('note', note.id, note.title || 'Untitled');
    return { note: structuredClone(note), conflictCopy };
  }),
  setNotesTrashed: demo((noteIds: string[], trashed: boolean) => {
    let changed = 0;
    for (const id of noteIds) {
      const note = notes.get(id);
      if (!note) continue;
      notes.set(id, { ...note, deletedAt: trashed ? Date.now() : null, revision: note.revision + 1 });
      changed += 1;
    }
    return changed;
  }),
  deleteNotesPermanently: demo((noteIds: string[]) => {
    let deleted = 0;
    for (const id of noteIds) {
      if (notes.delete(id)) deleted += 1;
      dropShortcut('note', id);
    }
    return deleted;
  }),
  emptyTrash: demo(() => {
    let deleted = 0;
    for (const note of [...notes.values()]) {
      if (note.deletedAt !== null && notes.delete(note.id)) {
        dropShortcut('note', note.id);
        deleted += 1;
      }
    }
    return deleted;
  }),
  createNotebook: demo((name: string, stackId: string | null) => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('name cannot be empty');
    if (!snapshot.notebooks.some((item) => item.name.toLowerCase() === trimmed.toLowerCase())) {
      snapshot.notebooks.push({
        id: crypto.randomUUID(),
        name: trimmed,
        stackId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        revision: 1,
      });
    }
    return overview();
  }),
  renameNotebook: demo((id: string, name: string) => {
    const notebook = snapshot.notebooks.find((item) => item.id === id);
    if (!notebook) throw new Error('Notebook not found');
    notebook.name = requireFreeName(snapshot.notebooks, name, id, 'notebook');
    notebook.updatedAt = Date.now();
    relabelShortcut('notebook', id, notebook.name);
    return overview();
  }),
  deleteNotebook: demo((id: string) => {
    const fallback = snapshot.notebooks.find((item) => item.id !== id);
    if (!fallback) throw new Error('the last notebook cannot be deleted');
    for (const note of notes.values()) {
      if (note.notebookId === id) {
        notes.set(note.id, { ...note, notebookId: fallback.id, deletedAt: note.deletedAt ?? Date.now() });
      }
    }
    snapshot.notebooks = snapshot.notebooks.filter((item) => item.id !== id);
    dropShortcut('notebook', id);
    return overview();
  }),
  setNotebookStack: demo((notebookId: string, stackId: string | null) => {
    const notebook = snapshot.notebooks.find((item) => item.id === notebookId);
    if (!notebook) throw new Error('Notebook not found');
    notebook.stackId = stackId;
    notebook.updatedAt = Date.now();
    return overview();
  }),
  createStack: demo((name: string) => {
    snapshot.stacks.push({
      id: crypto.randomUUID(),
      name: requireFreeName(snapshot.stacks, name, '', 'stack'),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
    });
    return overview();
  }),
  renameStack: demo((id: string, name: string) => {
    const stack = snapshot.stacks.find((item) => item.id === id);
    if (!stack) throw new Error('Stack not found');
    stack.name = requireFreeName(snapshot.stacks, name, id, 'stack');
    relabelShortcut('stack', id, stack.name);
    return overview();
  }),
  deleteStack: demo((id: string) => {
    snapshot.stacks = snapshot.stacks.filter((item) => item.id !== id);
    for (const notebook of snapshot.notebooks) {
      if (notebook.stackId === id) notebook.stackId = null;
    }
    dropShortcut('stack', id);
    return overview();
  }),
  createTag: demo((name: string, parentId: string | null) => {
    if (!name.trim()) throw new Error('name cannot be empty');
    ensureTag(name.trim(), parentId);
    return overview();
  }),
  setTagParent: demo((id: string, parentId: string | null) => {
    const tag = snapshot.tags.find((item) => item.id === id);
    if (!tag) throw new Error('Tag not found');
    // Not under itself, nor under a tag that is inside it.
    for (let above = parentId; above;) {
      if (above === id) throw new Error('A tag cannot be placed inside itself');
      above = snapshot.tags.find((item) => item.id === above)?.parentId ?? null;
    }
    tag.parentId = parentId;
    return overview();
  }),
  renameTag: demo((id: string, name: string) => {
    const tag = snapshot.tags.find((item) => item.id === id);
    if (!tag) throw new Error('Tag not found');
    const renamed = requireFreeName(snapshot.tags, name, id, 'tag');
    for (const note of notes.values()) {
      if (note.tags.includes(tag.name)) {
        notes.set(note.id, { ...note, tags: note.tags.map((item) => (item === tag.name ? renamed : item)) });
      }
    }
    tag.name = renamed;
    relabelShortcut('tag', id, renamed);
    return overview();
  }),
  deleteTag: demo((id: string) => {
    const tag = snapshot.tags.find((item) => item.id === id);
    if (!tag) throw new Error('Tag not found');
    for (const note of notes.values()) {
      if (note.tags.includes(tag.name)) {
        notes.set(note.id, { ...note, tags: note.tags.filter((item) => item !== tag.name) });
      }
    }
    // What it held stays, and moves up to where it was.
    for (const item of snapshot.tags) if (item.parentId === id) item.parentId = tag.parentId;
    snapshot.tags = snapshot.tags.filter((item) => item.id !== id);
    dropShortcut('tag', id);
    return overview();
  }),
  toggleShortcut: demo((targetType: ShortcutTarget, targetId: string, label: string) => {
    const existing = snapshot.shortcuts.some(
      (item) => item.targetType === targetType && item.targetId === targetId,
    );
    if (existing) dropShortcut(targetType, targetId);
    else {
      snapshot.shortcuts.push({
        id: crypto.randomUUID(),
        targetType,
        targetId,
        label,
        sortOrder: 0,
        createdAt: Date.now(),
      });
    }
    return overview();
  }),
  organizeNotes: demo(
    (noteIds: string[], action: NoteOrganizationAction, notebookId: string | null, tags: string[]) => {
      const timestamp = Date.now();
      if (action === 'move' || action === 'copy') {
        if (!notebookId || !snapshot.notebooks.some((notebook) => notebook.id === notebookId))
          throw new Error('choose a destination notebook');
        for (const id of noteIds) {
          const original = requireNote(id);
          if (action === 'move') {
            notes.set(id, { ...original, notebookId, updatedAt: timestamp, revision: original.revision + 1 });
            continue;
          }
          const copyId = crypto.randomUUID();
          notes.set(copyId, {
            ...structuredClone(original),
            id: copyId,
            notebookId,
            title: `${original.title.trim() || 'Untitled'} (copy)`,
            createdAt: timestamp,
            updatedAt: timestamp,
            deletedAt: null,
            evernoteGuid: null,
            revision: 1,
            resources: original.resources.map((resource) => ({
              ...structuredClone(resource),
              id: crypto.randomUUID(),
              noteId: copyId,
            })),
          });
        }
        return noteIds.length;
      }
      const names = [...new Set(tags.map((tag) => tag.trim().replace(/^#/, '')).filter(Boolean))];
      const lower = names.map((name) => name.toLowerCase());
      let changed = 0;
      for (const id of noteIds) {
        const note = requireNote(id);
        let next: string[];
        if (action === 'addTags') {
          names.forEach((tag) => ensureTag(tag));
          next = [...note.tags];
          for (const name of names) {
            if (!next.some((tag) => tag.toLowerCase() === name.toLowerCase())) next.push(name);
          }
        } else {
          next = note.tags.filter((tag) => !lower.includes(tag.toLowerCase()));
        }
        if (next.length !== note.tags.length) {
          notes.set(id, { ...note, tags: next, updatedAt: timestamp, revision: note.revision + 1 });
          changed += 1;
        }
      }
      return changed;
    },
  ),
  updateNoteTimestamps: demo((id: string, createdAt: number, updatedAt: number) => {
    const note = requireNote(id);
    if (createdAt < 0 || updatedAt < createdAt)
      throw new Error('updated time must be at or after created time');
    const updated = { ...note, createdAt, updatedAt, revision: note.revision + 1 };
    notes.set(id, updated);
    return structuredClone(updated);
  }),
  keepNoteVersion: demo((id: string) => keepVersion(requireNote(id))),
  noteVersions: demo((id: string): NoteVersion[] =>
    (versions.get(id) ?? [])
      .map(({ id: version, keptAt, note }) => ({
        id: version,
        keptAt,
        updatedAt: note.updatedAt,
        title: note.title,
        preview: note.plainText.slice(0, 160),
      }))
      .reverse(),
  ),
  restoreNoteVersion: demo((id: string, version: number) => {
    const now = requireNote(id);
    const kept = (versions.get(id) ?? []).find((item) => item.id === version);
    if (!kept) throw new Error('that version of the note is not kept');
    keepVersion(now);
    kept.note.tags.forEach((tag) => ensureTag(tag));
    const restored: Note = {
      ...now,
      title: kept.note.title,
      contentHtml: kept.note.contentHtml,
      plainText: kept.note.plainText,
      attributes: kept.note.attributes,
      tags: kept.note.tags,
      updatedAt: kept.note.updatedAt,
      revision: now.revision + 1,
    };
    notes.set(id, restored);
    relabelShortcut('note', id, restored.title || 'Untitled');
    return structuredClone(restored);
  }),
  getSettings: demo(() => ({ ...settings })),
  setSetting: demo((key, enabled) => {
    if (key === 'load_remote_images') settings.loadRemoteImages = enabled;
    return { ...settings };
  }),
  appInfo: demo(() => ({ version: 'demo', platform: 'browser' })),
  pickEnexFiles: demo(nativeOnly('ENEX import')),
  importEnex: demo((): ImportOutcome[] => nativeOnly('ENEX import')()),
  cancelImport: demo(() => undefined),
  // `?demoEvernote` shows what an account on this computer looks like.
  evernoteAccounts: demo((): EvernoteAccount[] =>
    new URLSearchParams(window.location.search).has('demoEvernote')
      ? [
          {
            userId: '1',
            notebooks: [
              ['nb-1', 'Astronomy', 'Feeds', 42, 0],
              ['nb-2', 'Computer science', 'Feeds', 310, 2],
              ['nb-3', 'Recipes', null, 18, 0],
              [
                'nb-6',
                'A notebook whose name is so long that it would not fit beside its count of notes in any dialog of a sensible width',
                'Life',
                0,
                0,
              ],
              ['nb-4', 'Travel', 'Life', 7, 0],
              ['nb-5', 'Empty notebook', null, 0, 0],
            ].map(([id, name, stack, notes, missing]) => ({
              id: String(id),
              name: String(name),
              stack: stack === null ? null : String(stack),
              notes: Number(notes),
              attachments: Number(notes) * 2,
              bytes: Number(notes) * 180000,
              notesNotDownloaded: Number(missing),
              // One lacks pictures and can be imported without them; the
              // other lacks its text and cannot.
              incomplete: Number(missing)
                ? [
                    { title: 'Sorting networks', textMissing: false, attachments: 3, attachmentsMissing: 2 },
                    { title: '', textMissing: true, attachments: 0, attachmentsMissing: 0 },
                  ]
                : [],
            })),
          },
        ]
      : [],
  ),
  importEvernote: demo(
    (_importId: string, _userId: string, notebookIds: string[] | null, withoutMissing: boolean) => ({
      notebooks: notebookIds?.length ?? 5,
      notesImported: withoutMissing ? 376 : 375,
      notesUpdated: 3,
      notesKeptBoth: 1,
      notesSkipped: 0,
      notesFailed: withoutMissing ? 1 : 2,
      notesIncomplete: withoutMissing ? 1 : 0,
      resourcesImported: withoutMissing ? 751 : 750,
      bytesImported: 67500000,
      imagesQueued: 0,
      linksResolved: 12,
      tagsNested: 4,
      shortcutsAdded: 3,
      shortcutsNowhere: 1,
      tasksBrought: 9,
      notesWithTasks: 2,
      notesInTrash: 2,
      tagsAdded: 5,
      cancelled: false,
      warnings: withoutMissing
        ? [
            '1 note was not imported because Evernote does not have all of it on this computer: “Untitled” in “Computer science”. Open it in Evernote while online, so that Evernote fetches what is missing, then import again: notes already imported are not imported twice. Synchronizing Evernote again does not bring a file it has given up on.',
            '1 note was imported without attachments that Evernote does not have on this computer: “Sorting networks” in “Computer science” (2 of 3). To complete it, open it in Evernote while online, then import again; a note you have changed here by then is kept as it is, and the whole one is added beside it.',
          ]
        : [
            '2 notes were not imported because Evernote does not have all of them on this computer: “Sorting networks” in “Computer science”, “Untitled” in “Computer science”. Open each of them in Evernote while online, so that Evernote fetches what is missing, then import again: notes already imported are not imported twice. Synchronizing Evernote again does not bring a file it has given up on.',
          ],
    }),
  ),
  attachFiles: demo((): Resource[] => nativeOnly('Choosing files to attach')()),
  attachBlob: demo((noteId: string, file: Blob, fileName: string) => {
    const note = requireNote(noteId);
    // A stand-in for the content hash the native store computes.
    const reference = crypto.randomUUID().replaceAll('-', '');
    registerDemoResource(reference, URL.createObjectURL(file));
    const resource: Resource = {
      id: crypto.randomUUID(),
      noteId,
      sha256: reference,
      md5: reference,
      mime: file.type || 'application/octet-stream',
      fileName: fileName || 'attachment',
      size: file.size,
      width: null,
      height: null,
      duration: null,
      recognitionXml: null,
      recognitionText: null,
      attributes: { 'file-name': fileName },
      alternateSha256: null,
      position: note.resources.length,
    };
    notes.set(noteId, { ...note, resources: [...note.resources, resource], revision: note.revision + 1 });
    return structuredClone(resource);
  }),
  exportNotes: demo((): number | null => nativeOnly('ENEX export')()),
  saveAttachment: demo((): boolean => nativeOnly('Saving attachments')()),
  openAttachment: demo(nativeOnly('Opening attachments')),
  openExternalUrl: demo((url: string) => {
    if (!/^(https?|mailto|tel):/i.test(url)) throw new Error('This link is not opened from notes.');
    window.open(url, '_blank', 'noopener,noreferrer');
  }),
  ocrStatus: demo(() => ({ enabled: false, pending: 0, running: false })),
  finishClose: demo(() => undefined),
  syncNow: demo(startDemoSync),
  syncStatus: demo((): SyncStatus => structuredClone(syncState)),
  stopSync: demo(stopDemoSync),
  syncHistory: demo((): SyncRun[] => structuredClone(syncRuns)),
  pcloudStatus: demo((): PCloudStatus =>
    demoSync
      ? {
          ...disconnected,
          connected: true,
          email: 'someone@example.com',
          lastSyncAt: syncRuns[0]?.endedAt ?? null,
        }
      : { ...disconnected },
  ),
  connectPcloud: demo((): PCloudStatus => nativeOnly('pCloud connection')()),
  cancelPcloudConnect: demo(() => ({ ...disconnected })),
  connectPcloudToken: demo((): PCloudStatus => nativeOnly('pCloud connection')()),
  disconnectPcloud: demo(() => ({ ...disconnected })),
  // The demonstration keeps its notes in memory: starting again removes them.
  eraseLocalData: demo(() => {
    try {
      localStorage.clear();
    } catch {
      // Storage may be unavailable; there is then nothing to clear.
    }
    window.setTimeout(() => window.location.reload(), 50);
  }),
};
