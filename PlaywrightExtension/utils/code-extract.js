// Turns the text shown in a side-panel output into plain code for "Save to Project".
// Pure functions: no DOM and no chrome.* APIs, so they run under `node --test`.

const FENCE = '`'.repeat(3);
const CODE_LANGUAGES = new Set(['', 'ts', 'typescript', 'js', 'javascript', 'tsx', 'jsx', 'mjs', 'cjs']);

/**
 * Model output often wraps code in fenced blocks with prose around them. If `text`
 * has fenced blocks, their contents are joined: the TypeScript, JavaScript, and
 * untagged ones when there are any, otherwise all of them. Text without fenced
 * blocks is returned unchanged.
 */
export function extractCode(text) {
  const source = String(text ?? '');
  const blocks = [];
  let open = null;

  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (open === null) {
      if (trimmed.startsWith(FENCE)) {
        // The first word after the fence is the language; anything after it is ignored.
        const language = trimmed.slice(FENCE.length).trim().split(/\s+/)[0].toLowerCase();
        open = { language, lines: [] };
      }
    } else if (trimmed === FENCE) {
      blocks.push(open);
      open = null;
    } else {
      open.lines.push(line);
    }
  }
  // A fence that never closes (truncated output) still counts as a block.
  if (open !== null && open.lines.length > 0) blocks.push(open);

  if (blocks.length === 0) return source;
  const code = blocks.filter((block) => CODE_LANGUAGES.has(block.language));
  return (code.length > 0 ? code : blocks).map((block) => block.lines.join('\n')).join('\n\n');
}

/**
 * The complete test file inside a Healer answer, or '' when it holds none. An answer is a
 * report with several fenced snippets; only a block that contains a test is a candidate,
 * and the longest one is taken as the whole fixed file.
 */
export function pickFixedCode(answer) {
  const blocks = [];
  let open = null;
  for (const line of String(answer ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (open === null) {
      if (trimmed.startsWith(FENCE)) open = [];
    } else if (trimmed === FENCE) {
      blocks.push(open.join('\n'));
      open = null;
    } else {
      open.push(line);
    }
  }
  if (open !== null && open.length > 0) blocks.push(open.join('\n'));
  const tests = blocks.filter((block) => /\btest(\.describe)?\s*\(/.test(block));
  return tests.reduce((longest, block) => (block.length > longest.length ? block : longest), '');
}

const IMPORT = /^import\s[^;'"]*?from\s*['"]([^'"]+)['"];?[ \t]*\r?\n?/gm;
const NAMED_ONLY = /^import\s*\{([^}]*)\}\s*from\b/;

/**
 * Generated code is several files in one text: page classes, then the tests that import
 * them. A stored script is one file, so this makes the text a valid one: the notice lines
 * above the code are dropped, imports of files that are part of the same text are removed,
 * and imports of the same package are merged into one at the top. Text that is already a
 * single file is returned unchanged.
 */
export function toSingleFile(text) {
  const source = String(text ?? '');
  // Markdown quote lines above the code, such as the mock provider's notice.
  const lines = source.split('\n');
  let start = 0;
  let notice = false;
  while (start < lines.length && (lines[start].trim() === '' || lines[start].startsWith('>'))) {
    if (lines[start].startsWith('>')) notice = true;
    start += 1;
  }
  const code = notice ? lines.slice(start).join('\n') : source;

  const imports = [...code.matchAll(IMPORT)].map((match) => ({ text: match[0].trim(), module: match[1] }));
  const relative = imports.some((entry) => entry.module.startsWith('.'));
  const repeated = new Set(imports.map((entry) => entry.module)).size < imports.length;
  if (!notice && !relative && !repeated) return source;
  if (imports.length === 0) return code;

  // In order of first appearance: one merged line per package, other forms once each.
  const header = [];
  const named = new Map();
  for (const entry of imports) {
    if (entry.module.startsWith('.')) continue;
    const names = NAMED_ONLY.exec(entry.text);
    if (!names) {
      const line = entry.text.replace(/\s+/g, ' ');
      if (!header.includes(line)) header.push(line);
      continue;
    }
    if (!named.has(entry.module)) {
      named.set(entry.module, new Set());
      header.push(named.get(entry.module));
    }
    for (const name of names[1].split(',').map((part) => part.trim()).filter(Boolean)) named.get(entry.module).add(name);
  }
  const moduleOf = new Map([...named].map(([module, names]) => [names, module]));
  const top = header.map((line) =>
    typeof line === 'string' ? line : `import { ${[...line].join(', ')} } from '${moduleOf.get(line)}';`,
  );

  const body = code.replace(IMPORT, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  return top.length > 0 ? `${top.join('\n')}\n\n${body}` : body;
}

/** The text after the last occurrence of `heading`; all of `text` when the heading is absent. */
export function sectionAfter(text, heading) {
  const source = String(text ?? '');
  const at = source.lastIndexOf(heading);
  return at === -1 ? source : source.slice(at + heading.length).replace(/^\s+/, '');
}

/** False for what a panel shows instead of code: nothing at all, or an "Error: …" line. */
export function looksLikeCode(text) {
  const value = String(text ?? '').trim();
  return value !== '' && !value.startsWith('Error:');
}
