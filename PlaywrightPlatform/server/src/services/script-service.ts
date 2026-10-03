import type { FastifyBaseLogger } from 'fastify';
import { AppError, notFound } from '../errors';
import type { Transact } from '../repositories';
import type { AuditRepository } from '../repositories/audit-repository';
import type { ProjectRepository } from '../repositories/project-repository';
import { isScriptNameClash, type ScriptListQuery, type ScriptRepository } from '../repositories/script-repository';
import type { TagRepository } from '../repositories/tag-repository';
import type {
  Actor,
  Script,
  ScriptLanguage,
  ScriptSummary,
  ScriptType,
  ScriptVersion,
  ScriptVersionSummary,
} from '../types';
import type { AuditService } from './audit-service';

export interface CreateScriptInput {
  name: string;
  description: string;
  testScenario: string;
  content: string;
  language: ScriptLanguage;
  scriptType: ScriptType;
  tags: string[];
  source: 'MANUAL' | 'GENERATED' | 'RECORDED' | 'IMPORTED';
  changeSummary: string;
}

export interface UpdateScriptInput {
  name?: string;
  description?: string;
  testScenario?: string;
  tags?: string[];
  content?: string;
  changeSummary?: string;
  /** The version the caller's content was based on. Required with `content`. */
  baseVersion?: number;
}

const METADATA_FIELDS = ['name', 'description', 'testScenario', 'tags'] as const;

const COPY_SUFFIX = ' (copy)';
const MAX_NAME_LENGTH = 200;

/**
 * "Login Test" in TypeScript becomes "login-test.spec.ts". Only a-z, 0-9, and hyphens
 * survive, so the result is always safe inside a Content-Disposition header.
 */
function downloadFileName(name: string, language: ScriptLanguage): string {
  const base = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '') // the accents NFKD split off their letters
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80)
    .replace(/-+$/, '');
  return `${base || 'script'}.spec.${language === 'JavaScript' ? 'js' : 'ts'}`;
}

function projectNotActive(): AppError {
  return new AppError(409, 'PROJECT_NOT_ACTIVE', 'This project is archived. Restore it to change its scripts.');
}

function nameTaken(name: string): AppError {
  return new AppError(409, 'SCRIPT_NAME_TAKEN', `A script named "${name}" already exists in this project.`);
}

/** For a row this transaction has just written or locked: it must still be there. */
function found(script: Script | null): Script {
  if (!script) throw new Error('Script disappeared inside its own transaction.');
  return script;
}

export class ScriptService {
  constructor(
    private readonly scripts: ScriptRepository,
    private readonly projects: ProjectRepository,
    private readonly tagRepo: TagRepository,
    private readonly audit: AuditService,
    private readonly transact: Transact,
    private readonly log: FastifyBaseLogger,
  ) {}

  async list(projectId: number, query: ScriptListQuery): Promise<{ items: ScriptSummary[]; total: number }> {
    if (!(await this.projects.findLiveById(projectId))) throw notFound('Project');
    return this.scripts.list(projectId, query);
  }

  /** Existing tag names for autocomplete. */
  tags(search?: string): Promise<string[]> {
    return this.tagRepo.list(search, 50);
  }

  async get(id: number): Promise<Script> {
    const script = await this.scripts.findLive(id);
    if (!script) throw notFound('Script');
    return script;
  }

  async create(actor: Actor, projectId: number, input: CreateScriptInput): Promise<Script> {
    let script: Script;
    try {
      script = await this.transact(async (r) => {
        const project = await r.projects.findLiveById(projectId);
        if (!project) throw notFound('Project');
        if (project.status !== 'ACTIVE') throw projectNotActive();

        const id = await r.scripts.create({
          projectId,
          name: input.name,
          description: input.description,
          testScenario: input.testScenario,
          content: input.content,
          language: input.language,
          scriptType: input.scriptType,
          createdBy: actor.userId,
        });
        await r.scripts.insertVersion({
          scriptId: id,
          version: 1,
          content: input.content,
          changeSummary: input.changeSummary,
          source: input.source,
          createdBy: actor.userId,
        });
        await r.tags.setForScript(id, input.tags);
        await this.record(
          actor,
          'script.create',
          id,
          { projectId, name: input.name, source: input.source, version: 1 },
          r.audit,
        );
        return found(await r.scripts.findLive(id));
      });
    } catch (err) {
      if (isScriptNameClash(err)) throw nameTaken(input.name);
      throw err;
    }
    this.log.info(`[SCRIPT] Created script ${script.id} in project ${projectId}`);
    return script;
  }

  async update(actor: Actor, id: number, input: UpdateScriptInput): Promise<Script> {
    let saved: { script: Script; note: string | null };
    try {
      saved = await this.transact(async (r) => {
        if (!(await r.scripts.lock(id))) throw notFound('Script');
        const current = await r.scripts.findLive(id);
        if (!current) throw notFound('Script'); // its project is deleted
        if (current.projectStatus !== 'ACTIVE') throw projectNotActive();

        if (input.content !== undefined && input.baseVersion !== current.version) {
          throw new AppError(
            409,
            'VERSION_CONFLICT',
            `This script is now at v${current.version}. Your changes were based on v${input.baseVersion}.`,
            { currentVersion: current.version, updatedBy: current.updatedBy },
          );
        }

        const next =
          input.content !== undefined && input.content !== current.content
            ? { content: input.content, version: current.version + 1 }
            : null;
        const changed: string[] = METADATA_FIELDS.filter((field) => input[field] !== undefined);
        if (!next && changed.length === 0) return { script: current, note: null };

        await r.scripts.update(
          id,
          {
            name: input.name,
            description: input.description,
            testScenario: input.testScenario,
            newVersion: next ?? undefined,
          },
          actor.userId,
        );
        if (next) {
          await r.scripts.insertVersion({
            scriptId: id,
            version: next.version,
            content: next.content,
            changeSummary: input.changeSummary ?? '',
            source: 'MANUAL',
            createdBy: actor.userId,
          });
        }
        if (input.tags !== undefined) await r.tags.setForScript(id, input.tags);
        await this.record(
          actor,
          next ? 'script.version' : 'script.update',
          id,
          next ? { version: next.version, changed: [...changed, 'content'] } : { changed },
          r.audit,
        );
        return {
          script: found(await r.scripts.findLive(id)),
          note: next ? `Saved script ${id} as v${next.version}` : `Updated script ${id}`,
        };
      });
    } catch (err) {
      if (isScriptNameClash(err)) throw nameTaken(input.name ?? '');
      throw err;
    }
    if (saved.note) this.log.info(`[SCRIPT] ${saved.note}`);
    return saved.script;
  }

  async remove(actor: Actor, id: number): Promise<void> {
    await this.transact(async (r) => {
      const script = await r.scripts.findLive(id);
      if (!script) throw notFound('Script');
      if (script.projectStatus !== 'ACTIVE') throw projectNotActive();
      if (!(await r.scripts.softDelete(id, actor.userId))) throw notFound('Script');
      await this.record(actor, 'script.delete', id, { name: script.name, version: script.version }, r.audit);
    });
    this.log.info(`[SCRIPT] Deleted script ${id}`);
  }

  async versions(id: number): Promise<ScriptVersionSummary[]> {
    await this.get(id);
    return this.scripts.listVersions(id);
  }

  async version(id: number, version: number): Promise<ScriptVersion> {
    await this.get(id);
    const row = await this.scripts.findVersion(id, version);
    if (!row) throw notFound('Version');
    return row;
  }

  /** History is never rewritten: restoring writes the old content as a new version. */
  async restore(actor: Actor, id: number, version: number): Promise<Script> {
    const script = await this.transact(async (r) => {
      if (!(await r.scripts.lock(id))) throw notFound('Script');
      const current = await r.scripts.findLive(id);
      if (!current) throw notFound('Script'); // its project is deleted
      if (current.projectStatus !== 'ACTIVE') throw projectNotActive();
      if (version === current.version) {
        throw new AppError(409, 'ALREADY_CURRENT', `v${version} is already the latest version.`);
      }
      const old = await r.scripts.findVersion(id, version);
      if (!old) throw notFound('Version');

      const next = current.version + 1;
      await r.scripts.update(id, { newVersion: { content: old.content, version: next } }, actor.userId);
      await r.scripts.insertVersion({
        scriptId: id,
        version: next,
        content: old.content,
        changeSummary: `Restored from v${version}`,
        source: 'RESTORED',
        createdBy: actor.userId,
      });
      await this.record(actor, 'script.restore', id, { fromVersion: version, version: next }, r.audit);
      return found(await r.scripts.findLive(id));
    });
    this.log.info(`[SCRIPT] Restored script ${id} from v${version} as v${script.version}`);
    return script;
  }

  /** A new script in the same project with the latest content and its own history. */
  async duplicate(actor: Actor, id: number, name?: string): Promise<Script> {
    let copyName = name ?? '';
    let copy: Script;
    try {
      copy = await this.transact(async (r) => {
        const source = await r.scripts.findLive(id);
        if (!source) throw notFound('Script');
        if (source.projectStatus !== 'ACTIVE') throw projectNotActive();
        copyName = name ?? `${source.name.slice(0, MAX_NAME_LENGTH - COPY_SUFFIX.length)}${COPY_SUFFIX}`;

        const copyId = await r.scripts.create({
          projectId: source.projectId,
          name: copyName,
          description: source.description,
          testScenario: source.testScenario,
          content: source.content,
          language: source.language,
          scriptType: source.scriptType,
          createdBy: actor.userId,
        });
        await r.scripts.insertVersion({
          scriptId: copyId,
          version: 1,
          content: source.content,
          changeSummary: `Duplicated from ${source.name} v${source.version}`,
          source: 'MANUAL',
          createdBy: actor.userId,
        });
        await r.tags.setForScript(copyId, source.tags);
        await this.record(
          actor,
          'script.duplicate',
          copyId,
          { fromScriptId: id, fromVersion: source.version, name: copyName },
          r.audit,
        );
        return found(await r.scripts.findLive(copyId));
      });
    } catch (err) {
      if (isScriptNameClash(err)) throw nameTaken(copyName);
      throw err;
    }
    this.log.info(`[SCRIPT] Duplicated script ${id} as script ${copy.id}`);
    return copy;
  }

  /** The file to hand to the browser: the latest content, or one version's. */
  async download(id: number, version?: number): Promise<{ fileName: string; content: string }> {
    const script = await this.get(id);
    const fileName = downloadFileName(script.name, script.language);
    if (version === undefined || version === script.version) return { fileName, content: script.content };
    const old = await this.scripts.findVersion(id, version);
    if (!old) throw notFound('Version');
    return { fileName, content: old.content };
  }

  /** Writes the audit row inside the caller's transaction. Never pass script content in `details`. */
  private record(
    actor: Actor,
    action: string,
    id: number,
    details: Record<string, unknown>,
    repo: AuditRepository,
  ): Promise<void> {
    return this.audit.record(
      {
        userId: actor.userId,
        userEmail: actor.email,
        action,
        resource: 'script',
        resourceId: String(id),
        result: 'SUCCESS',
        ip: actor.ip,
        details,
      },
      repo,
    );
  }
}
