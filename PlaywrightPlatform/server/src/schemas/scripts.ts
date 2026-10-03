import { z } from 'zod';
import type { Script, ScriptSummary } from '../types';
import { cleanText } from './common';

const MAX_TAGS = 20;

const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// The column is a 32-bit integer; anything larger would be a database error instead of "not found".
const versionNumber = z.coerce.number().int().min(1).max(2_147_483_647);

const name = cleanText(
  z.string().trim().min(1, 'Script name is required.').max(200, 'Script name is too long (200 max).'),
);
const description = cleanText(z.string().trim().max(2000, 'Description is too long (2000 max).'));
const testScenario = cleanText(z.string().trim().max(5000, 'Test scenario is too long (5000 max).'));
const changeSummary = cleanText(z.string().trim().max(500, 'Change summary is too long (500 max).'));

// Stored with \n line endings, so the same text always compares equal whatever produced it.
const content = cleanText(
  z
    .string()
    .min(1, 'Script content is required.')
    .max(1_000_000, 'Script content is too long (1,000,000 characters max).'),
).transform((text) => text.replace(/\r\n?/g, '\n'));

const tag = z
  .string()
  .trim()
  .min(1, 'A tag cannot be empty.')
  .max(40, 'A tag is too long (40 max).')
  .regex(/^[\p{L}\p{N} _.@-]+$/u, 'A tag may contain letters, digits, spaces, and - _ . @ only.');

// Repeats that differ only by case collapse to the first spelling, and only then is the count checked.
const tags = z
  .array(tag)
  .max(100, 'Too many tags.')
  .transform((list) => {
    const seen = new Set<string>();
    return list.filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  })
  .refine((list) => list.length <= MAX_TAGS, { message: 'A script can have at most 20 tags.' });

const language = z.enum(['TypeScript', 'JavaScript']);
const scriptType = z.enum(['E2E', 'API', 'COMPONENT']);
const scriptStatus = z.enum(['ACTIVE', 'ARCHIVED', 'DELETED']);
const lifecycleState = z.enum([
  'DRAFT',
  'GENERATED',
  'SAVED',
  'VALIDATED',
  'READY',
  'RUNNING',
  'PASSED',
  'FAILED',
  'HEALING',
]);

export const projectScriptsParams = z.object({ projectId: id });

export const createScriptBody = z.object({
  name,
  description: description.default(''),
  testScenario: testScenario.default(''),
  content,
  language: language.default('TypeScript'),
  scriptType: scriptType.default('E2E'),
  tags: tags.default([]),
  // RESTORED and HEALED are written only by the server.
  source: z.enum(['MANUAL', 'GENERATED', 'RECORDED', 'IMPORTED']).default('MANUAL'),
  changeSummary: changeSummary.default(''),
});

const scriptListItemDto = z.object({
  id: z.number(),
  projectId: z.number(),
  name: z.string(),
  description: z.string(),
  language,
  framework: z.string(),
  scriptType,
  version: z.number(),
  status: scriptStatus,
  lifecycleState,
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});

const scriptDto = scriptListItemDto.extend({ testScenario: z.string(), content: z.string() });

export const scriptResponse = z.object({ script: scriptDto });

export function toScriptListItemDto(s: ScriptSummary): z.infer<typeof scriptListItemDto> {
  return {
    id: s.id,
    projectId: s.projectId,
    name: s.name,
    description: s.description,
    language: s.language,
    framework: s.framework,
    scriptType: s.scriptType,
    version: s.version,
    status: s.status,
    lifecycleState: s.lifecycleState,
    tags: s.tags,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    updatedBy: s.updatedBy,
  };
}

export function toScriptDto(s: Script): z.infer<typeof scriptDto> {
  return { ...toScriptListItemDto(s), testScenario: s.testScenario, content: s.content };
}

export const listScriptsQuery = z.object({
  search: cleanText(z.string().trim().max(200)).optional(),
  tag: cleanText(z.string().trim().max(40)).optional(),
  // ARCHIVED is not a state scripts can reach in this release.
  status: z.enum(['ACTIVE', 'DELETED']).default('ACTIVE'),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const listTagsQuery = z.object({ search: cleanText(z.string().trim().max(40)).optional() });

export const scriptListResponse = z.object({
  items: z.array(scriptListItemDto),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

export const tagListResponse = z.object({ items: z.array(z.string()) });

const CHANGEABLE = ['name', 'description', 'testScenario', 'tags', 'content'] as const;

export const updateScriptBody = z
  .object({
    name: name.optional(),
    description: description.optional(),
    testScenario: testScenario.optional(),
    tags: tags.optional(),
    content: content.optional(),
    changeSummary: changeSummary.optional(),
    baseVersion: z.number().int().min(1).max(2_147_483_647).optional(),
  })
  .refine((body) => CHANGEABLE.some((key) => body[key] !== undefined), {
    message: 'Provide at least one field to change.',
  })
  .refine((body) => body.content === undefined || body.baseVersion !== undefined, {
    message: 'baseVersion is required when content is sent.',
    path: ['baseVersion'],
  });
