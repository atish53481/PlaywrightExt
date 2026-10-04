// Runs a test with the real Playwright runner and, when it fails, has the healer fix it and
// runs the fix, until the test passes or the tries are used up. Pure: no DOM and no chrome.*
// APIs; what runs a test and what heals one are passed in.

import { extractCode, pickFixedCode, toSingleFile } from './code-extract.js';

/** How many times a failed test is given to the healer before the run is left as failed. */
export const MAX_HEALS = 2;

// What the healer is told besides the error. A fix is run as one file, like the test was.
export const HEAL_CONTEXT =
  'The error is the output of a real `npx playwright test` run of this file. ' +
  'Return the complete fixed test as ONE self-contained spec file in a single code block: ' +
  'it may import only from \'@playwright/test\', never from a local file. Keep page classes, if any, in that same file.';

const plain = (text) => String(text ?? '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

/**
 * How a run ended: 'passed', 'failed', or 'skipped'. The runner exits with 0 when every test
 * was skipped, which is not a pass: nothing ran.
 */
export function playwrightOutcome(output, exitCode) {
  if (exitCode !== 0) return 'failed';
  const text = plain(output);
  const count = (word) => Number([...text.matchAll(new RegExp(`(\\d+) ${word}\\b`, 'g'))].pop()?.[1] ?? 0);
  return count('passed') === 0 && count('skipped') > 0 ? 'skipped' : 'passed';
}

/**
 * The context the healer is given: the rule about one file, and what Playwright saw on the
 * page when the test failed. The snapshot lists the elements that are really there, so a
 * locator is taken from it and not guessed.
 */
export function healContext(pageContext) {
  const seen = String(pageContext ?? '').trim().slice(0, 14_000);
  if (!seen) return HEAL_CONTEXT;
  return `${HEAL_CONTEXT}\n\nBelow is what Playwright recorded when the test failed, with a snapshot of the page at that moment. ` +
    `The snapshot lists the elements that were really on the page: take the role, name, and text of a locator from it, and do not invent one.\n\n${seen}`;
}

/** What the healer is given of a failed run: the end of the runner's output, where the error is. */
export function failureText(output) {
  return plain(output).trim().slice(-6000);
}

/**
 * Runs `code`, and while it fails has it healed and runs the result, `maxHeals` times at most.
 * `run(code)` resolves to { output, exitCode, pageContext }: `pageContext` is what Playwright
 * wrote about the failure, with a snapshot of the page ('' when it wrote nothing).
 * `heal(code, error, context, attempt)` resolves to the healer's answer, and may be left out;
 * `attempt` counts from 1, so a caller can use a stronger healer for a later fix.
 * `onEvent` is told { type: 'run' | 'heal', attempt }.
 * Resolves to { outcome, code, heals, reason }: `code` is the last code that was run, `heals`
 * how many fixes were run, `reason` why healing stopped early ('' otherwise).
 */
export async function runUntilPassing({ code, run, heal, maxHeals = MAX_HEALS, onEvent = () => {} }) {
  // Page classes and the tests that import them arrive as several files in one text.
  let current = toSingleFile(extractCode(code));
  for (let heals = 0; ; heals += 1) {
    onEvent({ type: 'run', attempt: heals + 1 });
    const { output, exitCode, pageContext = '' } = await run(current);
    const outcome = playwrightOutcome(output, exitCode);
    if (outcome !== 'failed' || !heal || heals >= maxHeals) return { outcome, code: current, heals, reason: '' };

    onEvent({ type: 'heal', attempt: heals + 1 });
    let fixed;
    try {
      fixed = toSingleFile(pickFixedCode(await heal(current, failureText(output), healContext(pageContext), heals + 1))).trim();
    } catch (err) {
      return { outcome, code: current, heals, reason: `The healer could not be asked: ${err.message}` };
    }
    if (!fixed || fixed === current.trim()) return { outcome, code: current, heals, reason: 'The healer returned no changed test.' };
    current = fixed;
  }
}
