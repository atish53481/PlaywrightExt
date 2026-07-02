import { AgentTask, AgentResult, TaskStatus } from '../models/AgentTask';
import { logger } from './Logger';

export type PipelineStep = (task: AgentTask, ctx: PipelineContext) => Promise<AgentResult>;

export interface PipelineContext {
  results: AgentResult[];
  metadata: Record<string, unknown>;
}

export class Pipeline {
  private steps: PipelineStep[] = [];

  constructor(private readonly name: string) {}

  pipe(step: PipelineStep): this {
    this.steps.push(step);
    return this;
  }

  async execute(task: AgentTask): Promise<PipelineContext> {
    const ctx: PipelineContext = { results: [], metadata: {} };
    logger.info(`Pipeline [${this.name}] start — ${this.steps.length} steps`);

    for (const step of this.steps) {
      const t0 = Date.now();
      try {
        const result = await step(task, ctx);
        ctx.results.push(result);
        if (result.status === TaskStatus.FAILURE) {
          logger.warn(`Pipeline [${this.name}] step failed: ${result.errors?.join(', ')}`);
          break;
        }
      } catch (err) {
        const e = err as Error;
        logger.error(`Pipeline [${this.name}] step threw: ${e.message}`);
        ctx.results.push({
          taskId: task.id, agentName: 'pipeline', status: TaskStatus.FAILURE,
          data: {}, errors: [e.message], duration: Date.now() - t0, timestamp: new Date(),
        });
        break;
      }
    }

    return ctx;
  }

  static async parallel(tasks: AgentTask[], step: PipelineStep): Promise<AgentResult[]> {
    const ctx: PipelineContext = { results: [], metadata: {} };
    return Promise.all(tasks.map(t => step(t, ctx)));
  }
}
