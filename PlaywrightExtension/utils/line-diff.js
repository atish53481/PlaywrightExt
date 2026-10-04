// A line-by-line comparison of two texts, for reviewing a Healer fix before it is saved.
// Pure functions: no DOM and no chrome.* APIs.

const lines = (text) => {
  const source = String(text ?? '').replace(/\r\n?/g, '\n');
  if (source === '') return [];
  // A final line break does not make an extra, empty line.
  return (source.endsWith('\n') ? source.slice(0, -1) : source).split('\n');
};

// Above this many cells the table for the comparison is not built; the shared start and end
// are still matched, and what lies between is shown as removed, then added.
const MAX_CELLS = 4_000_000;

/** [{ type: 'same' | 'del' | 'add', text }] turning `before` into `after`. */
export function lineDiff(before, after) {
  const a = lines(before);
  const b = lines(after);

  // Lines the two share at the start and the end need no comparing, which keeps the table small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }

  const out = a.slice(0, start).map((text) => ({ type: 'same', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  if (midA.length * midB.length > MAX_CELLS) {
    out.push(...midA.map((text) => ({ type: 'del', text })), ...midB.map((text) => ({ type: 'add', text })));
  } else {
    // Longest common subsequence, filled from the end so the walk below runs forwards.
    const width = midB.length + 1;
    const table = new Uint32Array((midA.length + 1) * width);
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        table[i * width + j] = midA[i] === midB[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) { out.push({ type: 'same', text: midA[i] }); i += 1; j += 1; }
      else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { out.push({ type: 'del', text: midA[i] }); i += 1; }
      else { out.push({ type: 'add', text: midB[j] }); j += 1; }
    }
    while (i < midA.length) { out.push({ type: 'del', text: midA[i] }); i += 1; }
    while (j < midB.length) { out.push({ type: 'add', text: midB[j] }); j += 1; }
  }

  out.push(...a.slice(endA).map((text) => ({ type: 'same', text })));
  return out;
}

/** { added, removed }: how many lines a diff adds and removes. */
export function diffStats(diff) {
  let added = 0;
  let removed = 0;
  for (const line of diff) {
    if (line.type === 'add') added += 1;
    else if (line.type === 'del') removed += 1;
  }
  return { added, removed };
}
