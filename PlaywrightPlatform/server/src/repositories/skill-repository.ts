import type { Knex } from 'knex';
import type { Db } from '../db';
import { escapeLike } from './sql';

export type SkillScope = 'GLOBAL' | 'PROJECT';
export type SkillStatus = 'ACTIVE' | 'ARCHIVED';

/** A skill without its text. */
export interface SkillSummary {
  id: number;
  name: string;
  description: string;
  scope: SkillScope;
  projectId: number | null;
  fileName: string | null;
  version: number;
  status: SkillStatus;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Skill extends SkillSummary {
  content: string;
}

/** A skill as one project sees it. A global skill is used by a project only once attached. */
export interface ProjectSkill extends SkillSummary {
  attached: boolean;
  enabled: boolean;
  priority: number;
}

export interface SkillVersionSummary {
  version: number;
  changeSummary: string;
  createdBy: string | null;
  createdAt: Date;
}

export interface SkillVersion extends SkillVersionSummary {
  content: string;
}

/** What an agent is given: the text of one skill version. */
export interface SkillContextItem {
  id: number;
  name: string;
  version: number;
  content: string;
}

export interface SkillRef {
  id: number;
  version: number;
}

export interface NewSkill {
  name: string;
  description: string;
  scope: SkillScope;
  projectId: number | null;
  fileName: string | null;
  content: string;
  createdBy: number;
}

export interface SkillPatch {
  name?: string;
  description?: string;
  /** New text: stored as the next version. */
  content?: string;
  changeSummary?: string;
  updatedBy: number;
}

export const DEFAULT_PRIORITY = 100;

// A skill's tag names, in alphabetical order.
const TAGS = `(select coalesce(array_agg(t.name order by lower(t.name)), '{}')
  from skill_tags st join tags t on t.id = st.tag_id where st.skill_id = s.id) as tags`;

const SUMMARY_COLUMNS = [
  's.id',
  's.name',
  's.description',
  's.scope',
  's.project_id',
  's.file_name',
  's.version',
  's.status',
  's.created_at',
  's.updated_at',
];

// Lower priority numbers come first; a project's own skill before a global one; then by name.
const CONTEXT_ORDER = "coalesce(ps.priority, 100), case s.scope when 'PROJECT' then 0 else 1 end, lower(s.name), s.id";

function toSummary(row: Record<string, any>): SkillSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.scope,
    projectId: row.project_id,
    fileName: row.file_name,
    version: row.version,
    status: row.status,
    tags: row.tags ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SkillRepository {
  constructor(private readonly db: Db) {}

  /** Active skills a project can use: its own, and every global one, attached or not. */
  private forProject(projectId: number): Knex.QueryBuilder {
    return this.db('skills as s')
      .leftJoin('project_skills as ps', function () {
        this.on('ps.skill_id', 's.id').andOnVal('ps.project_id', projectId);
      })
      .where('s.status', 'ACTIVE')
      .where((q) => q.where('s.scope', 'GLOBAL').orWhere('s.project_id', projectId));
  }

  private toProjectSkill(row: Record<string, any>): ProjectSkill {
    const attached = row.linked !== null && row.linked !== undefined;
    return {
      ...toSummary(row),
      attached,
      enabled: attached && Boolean(row.enabled),
      priority: attached ? row.priority : DEFAULT_PRIORITY,
    };
  }

  /** Inserts the skill with its first version. A project's own skill is attached to it at once. */
  async create(input: NewSkill): Promise<number> {
    const [row] = await this.db('skills')
      .insert({
        name: input.name,
        description: input.description,
        scope: input.scope,
        project_id: input.projectId,
        file_name: input.fileName,
        content: input.content,
        created_by: input.createdBy,
        updated_by: input.createdBy,
      })
      .returning('id');
    await this.db('skill_versions').insert({
      skill_id: row.id,
      version: 1,
      content: input.content,
      created_by: input.createdBy,
    });
    if (input.projectId !== null) {
      await this.db('project_skills').insert({ project_id: input.projectId, skill_id: row.id });
    }
    return row.id;
  }

  /** Whatever its status. */
  async find(id: number): Promise<Skill | null> {
    const row = await this.db('skills as s').where('s.id', id).first(...SUMMARY_COLUMNS, 's.content', this.db.raw(TAGS));
    return row ? { ...toSummary(row), content: row.content } : null;
  }

  /** True when an active skill in the same place already has this name, whatever the letter case. */
  async nameTaken(scope: SkillScope, projectId: number | null, name: string, exceptId?: number): Promise<boolean> {
    const query = this.db('skills')
      .where({ scope, status: 'ACTIVE' })
      .whereRaw('lower(name) = lower(?)', [name]);
    if (projectId === null) query.whereNull('project_id');
    else query.where({ project_id: projectId });
    if (exceptId !== undefined) query.whereNot({ id: exceptId });
    return Boolean(await query.first('id'));
  }

  /** `search` matches the name, the description, and the tags. */
  async listForProject(projectId: number, search?: string): Promise<ProjectSkill[]> {
    const query = this.forProject(projectId)
      .select(...SUMMARY_COLUMNS, this.db.raw(TAGS), 'ps.skill_id as linked', 'ps.enabled', 'ps.priority')
      .orderByRaw(CONTEXT_ORDER);
    if (search) {
      const pattern = `%${escapeLike(search)}%`;
      query.where((q) =>
        q
          .whereRaw("s.name ilike ? escape '\\'", [pattern])
          .orWhereRaw("s.description ilike ? escape '\\'", [pattern])
          .orWhereRaw(
            "exists (select 1 from skill_tags st join tags t on t.id = st.tag_id where st.skill_id = s.id and t.name ilike ? escape '\\')",
            [pattern],
          ),
      );
    }
    const rows = await query;
    return rows.map((row: Record<string, any>) => this.toProjectSkill(row));
  }

  /** One skill as the project sees it; null when the project cannot use it. */
  async findForProject(projectId: number, skillId: number): Promise<ProjectSkill | null> {
    const row = await this.forProject(projectId)
      .where('s.id', skillId)
      .first(...SUMMARY_COLUMNS, this.db.raw(TAGS), 'ps.skill_id as linked', 'ps.enabled', 'ps.priority');
    return row ? this.toProjectSkill(row) : null;
  }

  /** The text of every enabled skill of a project, in the order agents must read them. */
  async context(projectId: number): Promise<SkillContextItem[]> {
    const rows = await this.forProject(projectId)
      .whereNotNull('ps.skill_id')
      .where('ps.enabled', true)
      .select('s.id', 's.name', 's.version', 's.content')
      .orderByRaw(CONTEXT_ORDER);
    return rows.map((row: Record<string, any>) => ({ id: row.id, name: row.name, version: row.version, content: row.content }));
  }

  /** Changes a skill. New content becomes the next version; returns the version now current. */
  async update(id: number, patch: SkillPatch): Promise<number> {
    const columns: Record<string, unknown> = { updated_by: patch.updatedBy, updated_at: this.db.fn.now() };
    if (patch.name !== undefined) columns.name = patch.name;
    if (patch.description !== undefined) columns.description = patch.description;
    if (patch.content !== undefined) {
      columns.content = patch.content;
      columns.version = this.db.raw('version + 1');
    }
    const [row] = await this.db('skills').where({ id }).update(columns).returning('version');
    if (patch.content !== undefined) {
      await this.db('skill_versions').insert({
        skill_id: id,
        version: row.version,
        content: patch.content,
        change_summary: patch.changeSummary ?? '',
        created_by: patch.updatedBy,
      });
    }
    return row.version;
  }

  async setStatus(id: number, status: SkillStatus, updatedBy: number): Promise<void> {
    await this.db('skills').where({ id }).update({ status, updated_by: updatedBy, updated_at: this.db.fn.now() });
  }

  /** Newest first. */
  async listVersions(id: number): Promise<SkillVersionSummary[]> {
    const rows = await this.db('skill_versions as v')
      .leftJoin('users as u', 'u.id', 'v.created_by')
      .where('v.skill_id', id)
      .orderBy('v.version', 'desc')
      .select('v.version', 'v.change_summary', 'v.created_at', 'u.display_name as created_by_name');
    return rows.map((row) => ({
      version: row.version,
      changeSummary: row.change_summary,
      createdBy: row.created_by_name ?? null,
      createdAt: row.created_at,
    }));
  }

  async findVersion(id: number, version: number): Promise<SkillVersion | null> {
    const row = await this.db('skill_versions as v')
      .leftJoin('users as u', 'u.id', 'v.created_by')
      .where({ 'v.skill_id': id, 'v.version': version })
      .first('v.version', 'v.content', 'v.change_summary', 'v.created_at', 'u.display_name as created_by_name');
    if (!row) return null;
    return {
      version: row.version,
      content: row.content,
      changeSummary: row.change_summary,
      createdBy: row.created_by_name ?? null,
      createdAt: row.created_at,
    };
  }

  /** Attaches a skill to a project, or changes how the project uses one it has. */
  async link(projectId: number, skillId: number, patch: { enabled?: boolean; priority?: number }): Promise<void> {
    const changed: string[] = [];
    if (patch.enabled !== undefined) changed.push('enabled');
    if (patch.priority !== undefined) changed.push('priority');
    const insert = this.db('project_skills')
      .insert({
        project_id: projectId,
        skill_id: skillId,
        enabled: patch.enabled ?? true,
        priority: patch.priority ?? DEFAULT_PRIORITY,
      })
      .onConflict(['project_id', 'skill_id']);
    await (changed.length > 0 ? insert.merge(changed) : insert.ignore());
  }

  async unlink(projectId: number, skillId: number): Promise<void> {
    await this.db('project_skills').where({ project_id: projectId, skill_id: skillId }).delete();
  }

  /** Stores which skill versions a script version was made with. Versions that do not exist are left out. */
  async recordForScript(scriptId: number, scriptVersion: number, refs: SkillRef[]): Promise<void> {
    if (refs.length === 0) return;
    const known = await this.db('skill_versions')
      .whereIn(['skill_id', 'version'], refs.map((ref) => [ref.id, ref.version]))
      .distinct('skill_id', 'version');
    if (known.length === 0) return;
    await this.db('script_skills').insert(
      known.map((row) => ({
        script_id: scriptId,
        script_version: scriptVersion,
        skill_id: row.skill_id,
        skill_version: row.version,
      })),
    );
  }

  /** The skills the script's current version was made with. */
  async listForScript(scriptId: number): Promise<Array<{ id: number; name: string; version: number }>> {
    const rows = await this.db('script_skills as ss')
      .join('test_scripts as t', function () {
        this.on('t.id', 'ss.script_id').andOn('t.version', 'ss.script_version');
      })
      .join('skills as s', 's.id', 'ss.skill_id')
      .where('ss.script_id', scriptId)
      .orderByRaw('lower(s.name), s.id')
      .select('s.id', 's.name', 'ss.skill_version');
    return rows.map((row) => ({ id: row.id, name: row.name, version: row.skill_version }));
  }

  /** Keeps, with a run, the skills its script version was made with, by name as they were then. */
  async snapshotForExecution(executionId: number, scriptId: number, scriptVersion: number): Promise<void> {
    await this.db.raw(
      `insert into execution_skill_snapshots (execution_id, skill_id, skill_version, skill_name)
       select ?, ss.skill_id, ss.skill_version, s.name
       from script_skills ss join skills s on s.id = ss.skill_id
       where ss.script_id = ? and ss.script_version = ?
       on conflict do nothing`,
      [executionId, scriptId, scriptVersion],
    );
  }
}
