import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Agent, AgentStatus } from './base/Agent';
import { AgentTask, AgentResult, TaskType, TaskStatus } from '../models/AgentTask';

export class ExecutionAgent extends Agent {
  constructor() {
    super('ExecutionAgent', '1.0.0', { supportedTaskTypes: [TaskType.EXECUTE] });
  }

  async init(): Promise<void> {
    this.status = AgentStatus.READY;
    this.log.info('Execution Agent ready');
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const t0 = Date.now();
    this.status = AgentStatus.BUSY;

    try {
      const testPath = task.payload.testPath as string ?? '';
      const project   = task.payload.project as string ?? '';
      const workers   = task.payload.workers as number ?? 4;
      const headed    = task.payload.headed as boolean ?? false;
      const grep      = task.payload.grep as string ?? '';
      const reporter  = task.payload.reporter as string ?? 'html';

      const args: string[] = ['playwright', 'test'];
      if (testPath) args.push(testPath);
      if (project) args.push(`--project=${project}`);
      if (headed) args.push('--headed');
      if (grep) args.push(`--grep=${grep}`);
      args.push(`--workers=${workers}`);
      args.push(`--reporter=${reporter}`);

      this.log.info(`Running: npx ${args.join(' ')}`);

      const result = spawnSync('npx', args, {
        cwd: process.cwd(),
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 300_000,
      });

      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      const exitCode = result.status ?? 1;

      const stats = this.parseResults(stdout);
      this.log.info(`Execution complete — exit:${exitCode} passed:${stats.passed} failed:${stats.failed}`);

      this.status = AgentStatus.READY;
      return this.createResult(task, exitCode === 0 ? TaskStatus.SUCCESS : TaskStatus.FAILURE, {
        exitCode, stats, stdout: stdout.slice(-3000), stderr: stderr.slice(-1000),
        reportPath: path.join(process.cwd(), 'reports', 'html'),
      }, t0);
    } catch (err) {
      this.status = AgentStatus.ERROR;
      return this.createResult(task, TaskStatus.FAILURE, {}, t0, [(err as Error).message]);
    }
  }

  private parseResults(output: string): Record<string, number> {
    const passed  = (output.match(/(\d+) passed/)?.[1] ?? '0');
    const failed  = (output.match(/(\d+) failed/)?.[1] ?? '0');
    const skipped = (output.match(/(\d+) skipped/)?.[1] ?? '0');
    const flaky   = (output.match(/(\d+) flaky/)?.[1] ?? '0');
    return {
      passed: parseInt(passed), failed: parseInt(failed),
      skipped: parseInt(skipped), flaky: parseInt(flaky),
    };
  }
}
