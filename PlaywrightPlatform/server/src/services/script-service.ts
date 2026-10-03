import type { FastifyBaseLogger } from 'fastify';
import { AppError, notFound } from '../errors';
import type { Transact } from '../repositories';
import type { AuditRepository } from '../repositories/audit-repository';
import type { ProjectRepository } from '../repositories/project-repository';
import { isScriptNameClash, type ScriptRepository } from '../repositories/script-repository';
import type { TagRepository } from '../repositories/tag-repository';
import type { Actor, Script, ScriptLanguage, ScriptType } from '../types';
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
