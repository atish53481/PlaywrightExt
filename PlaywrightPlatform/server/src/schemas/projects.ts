import { z } from 'zod';
import type { Project, ProjectListItem, ProjectOverview } from '../types';

const name = z.string().trim().min(1, 'Project name is required.').max(120, 'Project name is too long (120 max).');
const description = z.string().trim().max(2000, 'Description is too long (2000 max).');
const status = z.enum(['ACTIVE', 'ARCHIVED', 'DELETED']);

export const createProjectBody = z.object({ name, description: description.default('') });

export const updateProjectBody = z
  .object({
    name: name.optional(),
    description: description.optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Provide at least one field to change.',
  });

export const listProjectsQuery = z.object({
  search: z.string().trim().max(200).optional(),
  status: status.default('ACTIVE'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const projectDto = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string(),
  status,
  autoUseSkills: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const projectListItemDto = projectDto.extend({
  scriptCount: z.number(),
  lastRunStatus: z.string().nullable(),
  lastRunAt: z.string().nullable(),
});

const overviewDto = z.object({
  totalScripts: z.number(),
  passedScripts: z.number(),
  failedScripts: z.number(),
  notExecuted: z.number(),
  lastExecutionAt: z.string().nullable(),
});

export const projectResponse = z.object({ project: projectDto });
export const projectDetailResponse = z.object({ project: projectDto, overview: overviewDto });
export const projectListResponse = z.object({
  items: z.array(projectListItemDto),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

export function toProjectDto(p: Project): z.infer<typeof projectDto> {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status,
    autoUseSkills: p.autoUseSkills,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function toProjectListItemDto(p: ProjectListItem): z.infer<typeof projectListItemDto> {
  return {
    ...toProjectDto(p),
    scriptCount: p.scriptCount,
    lastRunStatus: p.lastRunStatus,
    lastRunAt: p.lastRunAt ? p.lastRunAt.toISOString() : null,
  };
}

export function toOverviewDto(o: ProjectOverview): z.infer<typeof overviewDto> {
  return { ...o, lastExecutionAt: o.lastExecutionAt ? o.lastExecutionAt.toISOString() : null };
}
