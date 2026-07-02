import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { Agent, AgentStatus } from './base/Agent';
import { AgentTask, AgentResult, TaskType, TaskStatus } from '../models/AgentTask';

export class RecorderAgent extends Agent {
  constructor() {
    super('RecorderAgent', '1.0.0', { canRecord: true, supportedTaskTypes: [TaskType.RECORD] });
  }

  async init(): Promise<void> {
    this.status = AgentStatus.READY;
    this.log.info('Recorder ready — wraps Playwright codegen');
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const t0 = Date.now();
    this.status = AgentStatus.BUSY;

    try {
      const url = task.payload.url as string ?? 'http://localhost:3000';
      const outputFile = task.payload.outputFile as string
        ?? path.join(process.cwd(), 'tests', 'recorded', `recorded-${Date.now()}.spec.ts`);
      const browser = task.payload.browser as string ?? 'chromium';
      const lang = task.payload.lang as string ?? 'playwright-test';

      fs.mkdirSync(path.dirname(outputFile), { recursive: true });

      this.log.info(`Starting recorder for: ${url}`);
      this.log.info(`Output file: ${outputFile}`);
      this.log.info('Browser will open — record your interactions, then close it');

      const cmd = `npx playwright codegen --browser=${browser} --target=${lang} --output="${outputFile}" "${url}"`;
      this.log.debug(`Running: ${cmd}`);

      execSync(cmd, { stdio: 'inherit' });

      const exists = fs.existsSync(outputFile);
      this.status = AgentStatus.READY;

      if (exists) {
        const code = fs.readFileSync(outputFile, 'utf8');
        this.log.info(`Recording saved: ${outputFile} (${code.split('\n').length} lines)`);
        return this.createResult(task, TaskStatus.SUCCESS, { outputFile, lineCount: code.split('\n').length }, t0);
      }

      return this.createResult(task, TaskStatus.PARTIAL,
        { message: 'Recording cancelled — no file saved' }, t0);
    } catch (err) {
      this.status = AgentStatus.ERROR;
      return this.createResult(task, TaskStatus.FAILURE, {}, t0, [(err as Error).message]);
    }
  }
}
