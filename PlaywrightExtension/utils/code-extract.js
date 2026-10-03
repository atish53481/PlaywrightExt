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
