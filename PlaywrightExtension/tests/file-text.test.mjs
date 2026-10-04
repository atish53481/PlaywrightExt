import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { attachmentsNote, MAX_FILE_BYTES, readUploadedFile } from '../utils/file-text.js';

const utf8 = (text) => new TextEncoder().encode(text);

// A zip file of { name: text }, each entry deflated, as Word, Excel, and PowerPoint write them.
function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(8, 8);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    local.push(head, nameBytes, data);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, directory, end]));
}

const read = (name, bytes, type = '') => readUploadedFile({ name, type, bytes });

describe('reading an uploaded requirement file', () => {
  it('reads plain text of any extension, with or without a byte order mark', async () => {
    assert.deepEqual(await read('story.txt', utf8('As a user\r\nI sign in\n')), { kind: 'text', text: 'As a user\nI sign in', truncated: false });
    assert.equal((await read('cases.feature', utf8('﻿Feature: Login'))).text, 'Feature: Login');
    assert.equal((await read('data.json', utf8('{"a":1}'))).text, '{"a":1}');
    const utf16 = new Uint8Array([0xff, 0xfe, ...Buffer.from('Héllo', 'utf16le')]);
    assert.equal((await read('notes.txt', utf16)).text, 'Héllo');
  });

  it('keeps the text of a web page and drops its markup and scripts', async () => {
    const html = '<html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Login</h1><p>User &amp; password<br>are required</p></body></html>';
    assert.equal((await read('page.html', utf8(html))).text, 'Login\nUser & password\nare required');
  });

  it('reads the text of a Word document', async () => {
    const xml = '<w:document><w:body><w:p><w:r><w:t>Login page</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">User &lt;name&gt;</w:t><w:tab/><w:t>required</w:t></w:r></w:p></w:body></w:document>';
    const result = await read('brd.docx', zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': xml }));
    assert.deepEqual(result, { kind: 'text', text: 'Login page\nUser <name>\trequired', truncated: false });
  });

  it('reads the cells of an Excel workbook, sheet by sheet', async () => {
    const result = await read('cases.xlsx', zip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Cases" sheetId="1"/><sheet name="Data" sheetId="2"/></sheets></workbook>',
      'xl/sharedStrings.xml': '<sst><si><t>Title</t></si><si><r><t>Sign </t></r><r><t>in</t></r></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><cols><col min="1"/></cols><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" s="1"/><c r="C2" t="inlineStr"><is><t>ok</t></is></c></row></sheetData></worksheet>',
      'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>',
    }));
    assert.equal(result.text, '# Cases\nTitle\t42\nSign in\t\tok\n\n# Data\n7');
  });

  it('reads the slides of a PowerPoint file in order', async () => {
    const slide = (text) => `<p:sld><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`;
    const result = await read('deck.pptx', zip({
      'ppt/presentation.xml': '<p:presentation/>',
      'ppt/slides/slide10.xml': slide('Last'),
      'ppt/slides/slide2.xml': slide('Second'),
      'ppt/slides/slide1.xml': slide('First'),
    }));
    assert.equal(result.text, '# Slide 1\nFirst\n\n# Slide 2\nSecond\n\n# Slide 10\nLast');
  });

  it('reads an OpenDocument text file and a rich text file', async () => {
    const odt = zip({ mimetype: 'application/vnd.oasis.opendocument.text', 'content.xml': '<office:body><text:h>Scope</text:h><text:p>Sign in<text:line-break/>Sign out</text:p></office:body>' });
    assert.equal((await read('spec.odt', odt)).text, 'Scope\nSign in\nSign out');
    const rtf = '{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0\\fs24 Login \\b page\\b0\\par Caf\\\'e9\\par}';
    assert.equal((await read('spec.rtf', utf8(rtf))).text, 'Login page\nCafé');
  });

  it('hands a PDF or an image to the model as it is', async () => {
    const pdf = utf8('%PDF-1.4\n%âã\n1 0 obj');
    assert.deepEqual(await read('spec.pdf', pdf), {
      kind: 'attachment',
      attachment: { name: 'spec.pdf', mediaType: 'application/pdf', base64: Buffer.from(pdf).toString('base64') },
    });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]);
    // The kind of file is read from its first bytes, not from its name.
    assert.equal((await read('mockup.bin', png)).attachment.mediaType, 'image/png');
    assert.equal((await read('a.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).attachment.mediaType, 'image/jpeg');
    assert.equal((await read('a.gif', utf8('GIF89a....'))).attachment.mediaType, 'image/gif');
    assert.equal((await read('a.webp', utf8('RIFF\u0001\u0001\u0001\u0001WEBPVP8 '))).attachment.mediaType, 'image/webp');
  });

  it('cuts very long text and says so', async () => {
    const result = await read('big.txt', utf8('a'.repeat(200_500)));
    assert.equal(result.text.length, 200_000);
    assert.equal(result.truncated, true);
  });

  it('refuses a file it cannot read, and says why', async () => {
    await assert.rejects(read('empty.txt', new Uint8Array(0)), /"empty\.txt" is empty/);
    await assert.rejects(read('big.pdf', new Uint8Array(MAX_FILE_BYTES + 1)), /larger than 10 MB/);
    await assert.rejects(read('old.doc', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])), /older Office format.*\.docx/);
    await assert.rejects(read('app.exe', new Uint8Array(400).fill(0)), /no text that can be read/);
    await assert.rejects(read('files.zip', zip({ 'a.bin': 'x' })), /no text that can be read/);
    await assert.rejects(read('bad.docx', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])), /could not be read/);
    await assert.rejects(read('blank.docx', zip({ 'word/document.xml': '<w:document><w:body><w:p/></w:body></w:document>' })), /no text that can be read/);
  });
});

describe('telling the model about attached files', () => {
  it('names each attached file, and says nothing when there is none', () => {
    assert.equal(attachmentsNote([]), '');
    assert.equal(attachmentsNote(undefined), '');
    assert.equal(
      attachmentsNote([{ name: 'spec.pdf' }, { name: 'mockup.png' }]),
      '**Attached files:** spec.pdf, mockup.png — read each one in full; they are part of the input.',
    );
  });
});
