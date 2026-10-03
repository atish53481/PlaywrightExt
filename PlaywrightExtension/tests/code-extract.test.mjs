import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractCode, looksLikeCode, sectionAfter } from '../utils/code-extract.js';

const FENCE = '`'.repeat(3);
const block = (language, body) => `${FENCE}${language}\n${body}\n${FENCE}`;

describe('extractCode', () => {
  it('returns text without fenced blocks unchanged', () => {
    const code = "import { test } from '@playwright/test';\n\ntest('a', async () => {});\n";
    assert.equal(extractCode(code), code);
  });

  it('returns the content of a single fenced block and drops the prose around it', () => {
    const text = `Here is your test:\n\n${block('typescript', "test('a', async () => {});")}\n\nRun it with npx playwright test.`;
    assert.equal(extractCode(text), "test('a', async () => {});");
  });

  it('joins several code blocks with a blank line between them', () => {
    const text = `${block('ts', 'const a = 1;')}\nand then\n${block('', 'const b = 2;')}`;
    assert.equal(extractCode(text), 'const a = 1;\n\nconst b = 2;');
  });

  it('skips blocks in other languages when a code block exists', () => {
    const text = [block('bash', 'npm install'), block('JavaScript', 'const a = 1;'), block('json', '{"a":1}')].join('\n');
    assert.equal(extractCode(text), 'const a = 1;');
  });

  it('falls back to every block when none is tagged as code', () => {
    const text = `${block('text', 'first')}\n${block('python', 'second')}`;
    assert.equal(extractCode(text), 'first\n\nsecond');
  });

  it('keeps blank lines and indentation inside a block', () => {
    const body = "test('a', async () => {\n\n  await page.goto('/');\n});";
    assert.equal(extractCode(block('ts', body)), body);
  });

  it('accepts extra words after the language and Windows line endings', () => {
    const text = `${FENCE}ts title="login.spec.ts"\r\nconst a = 1;\r\nconst b = 2;\r\n${FENCE}\r\n`;
    assert.equal(extractCode(text), 'const a = 1;\nconst b = 2;');
  });

  it('treats a fence that never closes as a block, as truncated model output has', () => {
    assert.equal(extractCode(`${FENCE}ts\nconst a = 1;\nconst b = 2;`), 'const a = 1;\nconst b = 2;');
  });

  it('handles empty and missing input', () => {
    assert.equal(extractCode(''), '');
    assert.equal(extractCode(null), '');
    assert.equal(extractCode(undefined), '');
  });
});

describe('sectionAfter', () => {
  it('returns the text after the heading, without leading blank lines', () => {
    const output = `## TEST PLAN\n\n1. Open login\n\n---\n\n## GENERATED CODE\n\n${block('ts', 'const a = 1;')}`;
    assert.equal(sectionAfter(output, '## GENERATED CODE'), block('ts', 'const a = 1;'));
  });

  it('returns the whole text when the heading is absent', () => {
    assert.equal(sectionAfter('Error: provider failed', '## GENERATED CODE'), 'Error: provider failed');
  });

  it('gives only the code when combined with extractCode, even if the plan has its own fenced block', () => {
    const output = `## TEST PLAN\n\n${block('text', 'plan notes')}\n\n---\n\n## GENERATED CODE\n\n${block('ts', 'const a = 1;')}`;
    assert.equal(extractCode(sectionAfter(output, '## GENERATED CODE')), 'const a = 1;');
  });

  it('handles missing input', () => {
    assert.equal(sectionAfter(null, '## GENERATED CODE'), '');
  });
});

describe('looksLikeCode', () => {
  it('refuses nothing, whitespace, and an error line', () => {
    for (const text of ['', '   \n ', null, undefined, 'Error: Failed to fetch', '  Error: provider said no']) {
      assert.equal(looksLikeCode(text), false);
    }
  });

  it('accepts code, including code that merely mentions an error', () => {
    assert.equal(looksLikeCode("test('a', async () => {});"), true);
    assert.equal(looksLikeCode("// shows Error: when the form is empty\ntest('a', async () => {});"), true);
  });
});
