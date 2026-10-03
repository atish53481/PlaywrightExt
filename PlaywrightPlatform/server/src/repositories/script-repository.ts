import type { Knex } from 'knex';
import { isUniqueViolation, type Db } from '../db';
import type {
  ProjectStatus,
  Script,
  ScriptLanguage,
  ScriptLifecycleState,
  ScriptStatus,
  ScriptSummary,
  ScriptType,
  ScriptVersionSource,
} from '../types';
import { escapeLike } from './sql';

interface SummaryRow {
  id: number;
  project_id: number;
  project_status: ProjectStatus;
  name: string;
  description: string;
  language: ScriptLanguage;
  framework: string;
  script_type: ScriptType;
  version: number;
  status: ScriptStatus;
  lifecycle_state: ScriptLifecycleState;
  tags: string[];
  created_at: Date;
  updated_at: Date;
  updated_by_name: string | null;
}

interface ScriptRow extends SummaryRow {
  test_scenario: string;
  script_content: string;
}

const SUMMARY_COLUMNS = [
  's.id',
  's.project_id',
  's.name',
  's.description',
  's.language',
  's.framework',
  's.script_type',
  's.version',
  's.status',
  's.lifecycle_state',
  's.created_at',
  's.updated_at',
  'p.status as project_status',
  'u.display_name as updated_by_name',
];

// Tag names in a fixed order. A subquery, not a join, keeps one row per script so paging stays correct.
const TAGS_COLUMN = `(select coalesce(array_agg(t.name order by lower(t.name) collate "C"), '{}')
  from script_tags st join tags t on t.id = st.tag_id where st.script_id = s.id) as tags`;

function toSummary(row: SummaryRow): ScriptSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    projectStatus: row.project_status,
    name: row.name,
    description: row.description,
    language: row.language,
    framework: row.framework,
    scriptType: row.script_type,
    version: row.version,
    status: row.status,
    lifecycleState: row.lifecycle_state,
    tags: row.tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by_name,
  };
}

function toScript(row: ScriptRow): Script {
  return { ...toSummary(row), testScenario: row.test_scenario, content: row.script_content };
}

/** True when a write failed because another live script in the project already has that name. */
export function isScriptNameClash(err: unknown): boolean {
  return isUniqueViolation(err) && (err as { constraint?: string }).constraint === 'test_scripts_live_name_uq';
}

export interface NewScript {
  projectId: number;
  name: string;
  description: string;
  testScenario: string;
  content: string;
  language: ScriptLanguage;
  scriptType: ScriptType;
  createdBy: number;
}

export interface NewScriptVersion {
  scriptId: number;
  version: number;
  content: string;
  changeSummary: string;
  source: ScriptVersionSource;
  createdBy: number;
}

export interface ScriptListQuery {
  search?: string;
  tag?: string;
  status: 'ACTIVE' | 'DELETED';
  page: number;
  pageSize: number;
}

export interface ScriptChanges {
  name?: string;
  description?: string;
  testScenario?: string;
  /** New content together with its version number. */
  newVersion?: { content: string; version: number };
}

export class ScriptRepository {
  constructor(private readonly db: Db) {}

  /** Scripts joined to their project (never a deleted one) and to their last editor. */
  private scripts(): Knex.QueryBuilder {
    return this.db('test_scripts as s')
      .join('projects as p', 'p.id', 's.project_id')
      .leftJoin('users as u', 'u.id', 's.updated_by')
      .whereNot('p.status', 'DELETED');
  }

  /** One page of a project's scripts, most recently updated first. Never selects script content. */
  async list(projectId: number, query: ScriptListQuery): Promise<{ items: ScriptSummary[]; total: number }> {
    const filtered = this.scripts().where('s.project_id', projectId).where('s.status', query.status);
    if (query.search) {
      const pattern = `%${escapeLike(query.search)}%`;
      filtered.whereRaw(
        `(s.name ilike ? escape '\\' or s.description ilike ? escape '\\' or s.test_scenario ilike ? escape '\\'
          or exists (select 1 from script_tags st join tags t on t.id = st.tag_id
                     where st.script_id = s.id and t.name ilike ? escape '\\'))`,
        [pattern, pattern, pattern, pattern],
      );
    }
    if (query.tag) {
      filtered.whereRaw(
        `exists (select 1 from script_tags st join tags t on t.id = st.tag_id
                 where st.script_id = s.id and lower(t.name) = lower(?))`,
        [query.tag],
      );
    }

    const totalRow = await filtered.clone().count('* as n').first();
    const rows: SummaryRow[] = await filtered
      .clone()
      .select(...SUMMARY_COLUMNS, this.db.raw(TAGS_COLUMN))
      .orderBy('s.updated_at', 'desc')
      .orderBy('s.id', 'desc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return { total: Number(totalRow?.n ?? 0), items: rows.map(toSummary) };
  }

  /** One script with its content. "Live" means neither it nor its project is deleted. */
  async findLive(id: number): Promise<Script | null> {
    const row: ScriptRow | undefined = await this.scripts()
      .where('s.id', id)
      .whereNot('s.status', 'DELETED')
      .select(...SUMMARY_COLUMNS, 's.test_scenario', 's.script_content', this.db.raw(TAGS_COLUMN))
      .first();
    return row ? toScript(row) : null;
  }

  /** Inserts the script at version 1 and returns its id. The caller inserts the version row. */
  async create(input: NewScript): Promise<number> {
    const [row] = await this.db('test_scripts')
      .insert({
        project_id: input.projectId,
        name: input.name,
        description: input.description,
        test_scenario: input.testScenario,
        script_content: input.content,
        language: input.language,
        script_type: input.scriptType,
        version: 1,
        lifecycle_state: 'SAVED',
        created_by: input.createdBy,
        updated_by: input.createdBy,
      })
      .returning('id');
    return row.id;
  }

  async insertVersion(input: NewScriptVersion): Promise<void> {
    await this.db('test_script_versions').insert({
      script_id: input.scriptId,
      version: input.version,
      script_content: input.content,
      change_summary: input.changeSummary,
      source: input.source,
      created_by: input.createdBy,
    });
  }

  /**
   * Locks the script row until the transaction ends and reports whether it exists.
   * Call it first in any transaction that reads the version and then writes: a
   * concurrent writer waits here and then sees the first one's result.
   */
  async lock(id: number): Promise<boolean> {
    const row = await this.db('test_scripts').where({ id }).whereNot('status', 'DELETED').forUpdate().first('id');
    return Boolean(row);
  }

  async update(id: number, changes: ScriptChanges, updatedBy: number): Promise<void> {
    const columns: Record<string, unknown> = { updated_at: this.db.fn.now(), updated_by: updatedBy };
    if (changes.name !== undefined) columns.name = changes.name;
    if (changes.description !== undefined) columns.description = changes.description;
    if (changes.testScenario !== undefined) columns.test_scenario = changes.testScenario;
    if (changes.newVersion) {
      columns.script_content = changes.newVersion.content;
      columns.version = changes.newVersion.version;
      columns.lifecycle_state = 'SAVED';
    }
    await this.db('test_scripts').where({ id }).update(columns);
  }

  async softDelete(id: number, deletedBy: number): Promise<boolean> {
    const count = await this.db('test_scripts')
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
