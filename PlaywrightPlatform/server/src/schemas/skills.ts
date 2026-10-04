import { z } from 'zod';
import type { ProjectSkill, Skill, SkillSummary, SkillVersion, SkillVersionSummary } from '../repositories/skill-repository';
import { cleanText, pathId as id } from './common';

export const projectSkillsParams = z.object({ projectId: id });
export const projectSkillParams = z.object({ projectId: id, skillId: id });
export const skillVersionParams = z.object({ id, version: z.coerce.number().int().min(1).max(2_147_483_647) });

const name = cleanText(z.string().trim().min(1, 'Enter a skill name.').max(200, 'The name is too long (200 max).'));
const description = cleanText(z.string().trim().max(2000, 'The description is too long (2,000 max).'));
// A skill is text for a model to read, not a document store: the limit keeps it usable as context.
const content = cleanText(
  z.string().min(1, 'A skill cannot be empty.').max(200_000, 'Skill content is too long (200,000 characters max).'),
).transform((text) => text.replace(/\r\n?/g, '\n'));
// A name only, never a path: no slash, backslash, colon, or leading dot.
const fileName = z
  .string()
  .trim()
  .max(120, 'The file name is too long (120 max).')
  .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*\.md$/, 'The file name must end in .md and must not contain a path.');
const changeSummary = cleanText(z.string().trim().max(500, 'The change summary is too long (500 max).'));
// The same rule as a script's tags.
const tag = z
  .string()
  .trim()
  .min(1, 'A tag cannot be empty.')
  .max(40, 'A tag is too long (40 max).')
  .regex(/^[\p{L}\p{M}\p{N} _.@-]+$/u, 'A tag may contain letters, digits, spaces, and - _ . @ only.');
// Repeats that differ only by case collapse to the first spelling.
const tags = z
  .array(tag)
  .transform((names) => {
    const seen = new Set<string>();
    return names.filter((value) => !seen.has(value.toLowerCase()) && seen.add(value.toLowerCase()));
  })
  .pipe(z.array(z.string()).max(20, 'Too many tags (20 at most).'));

export const listSkillsQuery = z.object({
  search: cleanText(z.string().trim().max(200)).optional(),
});

export const createSkillBody = z.object({
  name,
  description: description.default(''),
  content,
  fileName: fileName.optional(),
  tags: tags.default([]),
});

export const updateSkillBody = z
  .object({
    name: name.optional(),
    description: description.optional(),
    content: content.optional(),
    changeSummary: changeSummary.optional(),
    tags: tags.optional(),
  })
  .refine(
    (body) => body.name !== undefined || body.description !== undefined || body.content !== undefined || body.tags !== undefined,
    { message: 'Provide at least one field to change.' },
  );

export const projectSkillBody = z
  .object({
    attached: z.boolean().optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(1).max(1000).optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one field to change.',
  });

const summary = {
  id: z.number(),
  name: z.string(),
  description: z.string(),
  scope: z.enum(['GLOBAL', 'PROJECT']),
  projectId: z.number().nullable(),
  fileName: z.string().nullable(),
  version: z.number(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
};

const skillDto = z.object({ ...summary, content: z.string() });
const projectSkillDto = z.object({ ...summary, attached: z.boolean(), enabled: z.boolean(), priority: z.number() });
const versionItemDto = z.object({
  version: z.number(),
  changeSummary: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
});

export const skillResponse = z.object({ skill: skillDto });
export const projectSkillResponse = z.object({ skill: projectSkillDto });
export const projectSkillListResponse = z.object({ items: z.array(projectSkillDto) });
export const skillVersionListResponse = z.object({ items: z.array(versionItemDto) });
export const skillVersionResponse = z.object({ version: versionItemDto.extend({ content: z.string() }) });
export const skillContextResponse = z.object({
  project: z.string(),
  skills: z.array(z.object({ id: z.number(), name: z.string(), version: z.number(), content: z.string() })),
});
export const scriptSkillListResponse = z.object({
  items: z.array(z.object({ id: z.number(), name: z.string(), version: z.number() })),
});

function toSummaryDto(skill: SkillSummary) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    projectId: skill.projectId,
    fileName: skill.fileName,
    version: skill.version,
    status: skill.status,
    tags: skill.tags,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString(),
  };
}

export function toSkillDto(skill: Skill): z.infer<typeof skillDto> {
  return { ...toSummaryDto(skill), content: skill.content };
}

export function toProjectSkillDto(skill: ProjectSkill): z.infer<typeof projectSkillDto> {
  return { ...toSummaryDto(skill), attached: skill.attached, enabled: skill.enabled, priority: skill.priority };
}

export function toSkillVersionItemDto(version: SkillVersionSummary): z.infer<typeof versionItemDto> {
  return {
    version: version.version,
    changeSummary: version.changeSummary,
    createdBy: version.createdBy,
    createdAt: version.createdAt.toISOString(),
  };
}

export function toSkillVersionDto(version: SkillVersion) {
  return { ...toSkillVersionItemDto(version), content: version.content };
}
