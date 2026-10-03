import type { Db } from '../db';
import type { Project, ProjectListItem, ProjectOverview, ProjectStatus } from '../types';

interface ProjectRow {
  id: number;
  name: string;
  description: string;
  status: ProjectStatus;
  auto_use_skills: boolean;
  created_at: Date;
  updated_at: Date;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    autoUseSkills: row.auto_use_skills,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Escapes LIKE wildcards so user text matches literally. Pairs with `escape '\'` in the query. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}

export interface ProjectListQuery {
  search?: string;
  status: ProjectStatus;
  page: number;
  pageSize: number;
}

export interface ProjectPatch {
  name?: string;
  description?: string;
  status?: 'ACTIVE' | 'ARCHIVED';
}

export class ProjectRepository {
  constructor(private readonly db: Db) {}

  async list(query: ProjectListQuery): Promise<{ items: ProjectListItem[]; total: number }> {
    const filtered = this.db('projects as p').where('p.status', query.status);
    if (query.search) {
      const pattern = `%${escapeLike(query.search)}%`;
      filtered.whereRaw("(p.name ilike ? escape '\\' or p.description ilike ? escape '\\')", [pattern, pattern]);
    }

    const totalRow = await filtered.clone().count('* as n').first();
    const rows = await filtered
      .clone()
      .select(
        'p.*',
        this.db.raw(
          "(select count(*) from test_scripts s where s.project_id = p.id and s.status <> 'DELETED') as script_count",
        ),
        this.db.raw(
          '(select e.status from test_executions e where e.project_id = p.id order by e.created_at desc, e.id desc limit 1) as last_run_status',
        ),
        this.db.raw('(select max(e.created_at) from test_executions e where e.project_id = p.id) as last_run_at'),
      )
      .orderBy('p.created_at', 'desc')
      .orderBy('p.id', 'desc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      total: Number(totalRow?.n ?? 0),
      items: rows.map((row: ProjectRow & { script_count: number; last_run_status: string | null; last_run_at: Date | null }) => ({
        ...toProject(row),
        scriptCount: Number(row.script_count),
        lastRunStatus: row.last_run_status,
        lastRunAt: row.last_run_at,
      })),
    };
  }

  /** "Live" means not soft-deleted. */
  async findLiveById(id: number): Promise<Project | null> {
    const row = await this.db('projects').where({ id }).whereNot('status', 'DELETED').first();
    return row ? toProject(row) : null;
  }

  async overview(id: number): Promise<ProjectOverview> {
    const counts = await this.db('test_scripts')
      .where({ project_id: id })
      .whereNot('status', 'DELETED')
      .select(
        this.db.raw('count(*) as total'),
        this.db.raw("count(*) filter (where lifecycle_state = 'PASSED') as passed"),
        this.db.raw("count(*) filter (where lifecycle_state = 'FAILED') as failed"),
      )
      .first();
    const last = await this.db('test_executions').where({ project_id: id }).max('created_at as at').first();

    const total = Number(counts?.total ?? 0);
    const passed = Number(counts?.passed ?? 0);
    const failed = Number(counts?.failed ?? 0);
    return {
      totalScripts: total,
      passedScripts: passed,
      failedScripts: failed,
      notExecuted: total - passed - failed,
      lastExecutionAt: last?.at ?? null,
    };
  }

  async create(input: { name: string; description: string; createdBy: number }): Promise<Project> {
    const [row] = await this.db('projects')
      .insert({ name: input.name, description: input.description, created_by: input.createdBy })
      .returning('*');
    return toProject(row);
  }

  async update(id: number, patch: ProjectPatch): Promise<Project | null> {
    const changes: Record<string, unknown> = { updated_at: this.db.fn.now() };
    if (patch.name !== undefined) changes.name = patch.name;
    if (patch.description !== undefined) changes.description = patch.description;
    if (patch.status !== undefined) changes.status = patch.status;
    const [row] = await this.db('projects')
      .where({ id })
      .whereNot('status', 'DELETED')
      .update(changes)
      .returning('*');
    return row ? toProject(row) : null;
  }

  async softDelete(id: number, deletedBy: number): Promise<boolean> {
    const count = await this.db('projects')
      .where({ id })
      .whereNot('status', 'DELETED')
      .update({
        status: 'DELETED',
        deleted_at: this.db.fn.now(),
        deleted_by: deletedBy,
        updated_at: this.db.fn.now(),
      });
    return count > 0;
  }
}
