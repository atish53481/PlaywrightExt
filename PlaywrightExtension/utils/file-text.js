// Reads a file a person uploads as the input of an agent. Pure: no DOM and no chrome.* APIs.
//
// A file whose text can be read here (plain text of any kind, a web page, Word, Excel,
// PowerPoint, OpenDocument, rich text) becomes text. A PDF or an image is handed to the model
// as it is: { name, mediaType, base64 }. Anything else is refused, with the reason.
// The kind of file is read from its first bytes, never from its name.

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;
// What one part of an Office file may unpack to, so a small file cannot fill the memory.
const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;

const startsWith = (bytes, ...codes) => codes.every((code, i) => bytes[i] === code);
const ascii = (bytes, from, to) => String.fromCharCode(...bytes.subarray(from, to));

/** The media type of a file the model reads itself, or null. */
function attachmentType(bytes) {
  if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf';
  if (startsWith(bytes, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (startsWith(bytes, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(bytes, 0, 4) === 'GIF8') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function unescapeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] !== '#') return NAMED[code.toLowerCase()] ?? whole;
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
  });
}

/** The text between the tags of a piece of XML or HTML. */
const plain = (markup) => unescapeXml(markup.replace(/<[^>]+>/g, ''));

const normalize = (text) => text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** Plain text in UTF-8 or UTF-16, or null when the bytes are not text. */
function decodeText(bytes) {
  if (startsWith(bytes, 0xff, 0xfe)) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (startsWith(bytes, 0xfe, 0xff)) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const text = new TextDecoder('utf-8').decode(bytes);
  const sample = text.slice(0, 4000);
  const odd = (sample.match(/[\u0000-\u0008\u000e-\u001f�]/g) || []).length;
  return odd > sample.length * 0.02 ? null : text;
}

function webPageText(html) {
  return plain(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\b[^>]*>|<\/(p|div|li|tr|h[1-6]|title)\s*>/gi, '\n'),
  );
}

function richText(rtf) {
  return rtf
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\{\\(fonttbl|colortbl|stylesheet|info|pict)\b(?:[^{}]|\{[^{}]*\})*\}/g, '')
    .replace(/\\(par|line)\b ?/g, '\n')
    .replace(/\\tab\b ?/g, '\t')
    .replace(/\\'([0-9a-f]{2})/gi, (whole, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u(-?\d+)\??/g, (whole, code) => String.fromCharCode((Number(code) + 65536) % 65536))
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '');
}

/** The parts of a zip file by name: { method, size, offset }. Throws when it is not a zip file. */
function zipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('not a zip file');
  const count = view.getUint16(end + 10, true);
  const entries = new Map();
  let at = view.getUint32(end + 16, true);
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('damaged zip file');
    const nameLength = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.set(name, { method: view.getUint16(at + 10, true), size: view.getUint32(at + 20, true), offset: view.getUint32(at + 42, true) });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return entries;
}

/** One part of a zip file as text. */
async function unzip(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const data = bytes.subarray(start, start + entry.size);
  if (entry.method === 0) return new TextDecoder().decode(data);
  if (entry.method !== 8) throw new Error('unknown compression');
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_UNPACKED_BYTES) {
      await reader.cancel();
      throw new Error('too large');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function wordText(xml) {
  return plain(xml.replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<w:br\b[^>]*\/>|<\/w:p>/g, '\n'));
}

function slideText(xml) {
  return plain(xml.replace(/<a:tab\b[^>]*\/>/g, '\t').replace(/<a:br\b[^>]*\/>|<\/a:p>/g, '\n'));
}

function openDocumentText(xml) {
  return plain(
    xml
      .replace(/<text:tab\b[^>]*\/>|<\/table:table-cell>/g, '\t')
      .replace(/<text:line-break\b[^>]*\/>|<\/text:(p|h)>|<\/table:table-row>/g, '\n'),
  );
}

/** The rows of one sheet, cells divided by tabs. `shared` is the workbook's list of strings. */
function sheetRows(xml, shared) {
  return [...xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)]
    .map(([, row = '']) =>
      [...row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
        .map(([, attributes, body = '']) => {
          const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
          if (/\bt="s"/.test(attributes)) return shared[Number(value)] ?? '';
          return value !== undefined ? unescapeXml(value) : plain(body);
        })
        .join('\t')
        .replace(/\t+$/, ''),
    )
    .filter(Boolean);
}

/** The text of a Word, Excel, PowerPoint, or OpenDocument file, or null for any other zip file. */
async function officeText(bytes) {
  const entries = zipEntries(bytes);
  const part = (name) => unzip(bytes, entries.get(name));
  // The numbered parts of one kind, in order: sheet1, sheet2, sheet10.
  const numbered = (pattern) =>
    [...entries.keys()]
      .map((name) => ({ name, n: Number(pattern.exec(name)?.[1]) }))
      .filter((entry) => !Number.isNaN(entry.n))
      .sort((a, b) => a.n - b.n);

  if (entries.has('word/document.xml')) return wordText(await part('word/document.xml'));

  if (entries.has('xl/workbook.xml')) {
    const names = [...(await part('xl/workbook.xml')).matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((match) => unescapeXml(match[1]));
    const shared = entries.has('xl/sharedStrings.xml')
      ? [...(await part('xl/sharedStrings.xml')).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => plain(match[1]))
      : [];
    const sheets = [];
    for (const [index, sheet] of numbered(/^xl\/worksheets\/sheet(\d+)\.xml$/).entries()) {
      const rows = sheetRows(await part(sheet.name), shared);
      if (rows.length > 0) sheets.push(`# ${names[index] || `Sheet ${sheet.n}`}\n${rows.join('\n')}`);
    }
    return sheets.join('\n\n');
  }

  if (entries.has('ppt/presentation.xml')) {
    const slides = [];
    for (const slide of numbered(/^ppt\/slides\/slide(\d+)\.xml$/)) {
      const text = normalize(slideText(await part(slide.name)));
      if (text) slides.push(`# Slide ${slide.n}\n${text}`);
    }
    return slides.join('\n\n');
  }

  if (entries.has('content.xml')) return openDocumentText(await part('content.xml'));
  return null;
}

/**
 * What an uploaded file gives an agent: { kind: 'text', text, truncated } or
 * { kind: 'attachment', attachment: { name, mediaType, base64 } }. `bytes` is a Uint8Array.
 * Throws an Error whose message can be shown to the person when the file cannot be used.
 */
export async function readUploadedFile({ name, type = '', bytes }) {
  const label = `"${name}"`;
  if (!bytes || bytes.length === 0) throw new Error(`${label} is empty.`);
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`${label} is larger than 10 MB.`);

  const mediaType = attachmentType(bytes);
  if (mediaType) return { kind: 'attachment', attachment: { name, mediaType, base64: toBase64(bytes) } };

  if (startsWith(bytes, 0xd0, 0xcf, 0x11, 0xe0)) {
    throw new Error(`${label} is in an older Office format. Save it as .docx, .xlsx, .pptx, or PDF and upload it again.`);
  }

  let text;
  if (startsWith(bytes, 0x50, 0x4b, 0x03, 0x04)) {
    try {
      text = await officeText(bytes);
    } catch {
      throw new Error(`${label} could not be read. The file may be damaged.`);
    }
  } else if (ascii(bytes, 0, 5) === '{\\rtf') {
    text = richText(new TextDecoder('latin1').decode(bytes));
  } else {
    text = decodeText(bytes);
    if (text !== null && (/html/i.test(type) || /^\s*<(!doctype html|html)\b/i.test(text))) text = webPageText(text);
  }

  text = normalize(text ?? '');
  if (!text) {
    throw new Error(`${label} has no text that can be read. Upload a text, Word, Excel, PowerPoint, PDF, or image file, or paste the text.`);
  }
  return { kind: 'text', text: text.slice(0, MAX_TEXT_CHARS), truncated: text.length > MAX_TEXT_CHARS };
}

/** The line of a prompt that tells the model which files came with it, or '' when none did. */
export function attachmentsNote(attachments) {
  const names = (Array.isArray(attachments) ? attachments : []).map((file) => String(file?.name ?? 'file').replace(/\s+/g, ' ').trim());
  return names.length === 0 ? '' : `**Attached files:** ${names.join(', ')} — read each one in full; they are part of the input.`;
}
