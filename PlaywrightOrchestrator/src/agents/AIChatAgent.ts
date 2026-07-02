import { Agent, AgentStatus } from './base/Agent';
import { AgentTask, AgentResult, TaskType, TaskStatus, createTask, Priority } from '../models/AgentTask';
import { eventBus } from '../core/EventBus';

interface Intent {
  type: TaskType;
  confidence: number;
  params: Record<string, unknown>;
}

export class AIChatAgent extends Agent {
  constructor() {
    super('AIChatAgent', '1.0.0', { supportedTaskTypes: [TaskType.CHAT] });
  }

  async init(): Promise<void> {
    this.status = AgentStatus.READY;
    this.log.info('AI Chat Agent ready');
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const t0 = Date.now();
    this.status = AgentStatus.BUSY;
    try {
      const message = task.payload.message as string ?? '';
      const url = task.payload.url as string ?? '';
      this.log.info(`Chat: "${message.slice(0, 80)}"`);
      const intent = this.recognizeIntent(message, url);
      const response = await this.handleIntent(intent, message, url);
      this.status = AgentStatus.READY;
      return this.createResult(task, TaskStatus.SUCCESS, {
        intent: intent.type, confidence: intent.confidence,
        response: response.text, agentResult: response.result,
      }, t0);
    } catch (err) {
      this.status = AgentStatus.ERROR;
      return this.createResult(task, TaskStatus.FAILURE, {}, t0, [(err as Error).message]);
    }
  }

  private recognizeIntent(message: string, url: string): Intent {
    const lower = message.toLowerCase();
    const patterns: Array<{ pattern: RegExp; type: TaskType }> = [
      { pattern: /plan|create.*test.*plan|what.*test|design.*test/i,      type: TaskType.PLAN },
      { pattern: /generat|write.*test|creat.*test|build.*test/i,          type: TaskType.GENERATE },
      { pattern: /record|capture|codegen/i,                               type: TaskType.RECORD },
      { pattern: /run|execut|start.*test|launch/i,                        type: TaskType.EXECUTE },
      { pattern: /heal|fix.*broken|repair|selector.*fail/i,               type: TaskType.HEAL },
      { pattern: /scaffold|setup.*framework|create.*structure/i,          type: TaskType.SCAFFOLD },
      { pattern: /report|summary|result|show.*result/i,                   type: TaskType.REPORT },
      { pattern: /api.*test|test.*api|endpoint/i,                         type: TaskType.API_TEST },
      { pattern: /performance|speed|load.*time|lcp|cls/i,                 type: TaskType.PERFORMANCE },
      { pattern: /access|wcag|aria|a11y/i,                                type: TaskType.ACCESSIBILITY },
      { pattern: /secur|xss|csrf|header|vulnerab/i,                       type: TaskType.SECURITY },
      { pattern: /locat|selector|find.*element|inspect/i,                 type: TaskType.LOCATE },
    ];
    for (const p of patterns) {
      if (p.pattern.test(lower)) return { type: p.type, confidence: 0.85, params: { url } };
    }
    return { type: TaskType.PLAN, confidence: 0.4, params: { url } };
  }

  private async handleIntent(intent: Intent, message: string, url: string): Promise<{ text: string; result?: Record<string, unknown> }> {
    const responses: Partial<Record<TaskType, string>> = {
      [TaskType.PLAN]:          `Planning tests for ${url || 'your application'}...`,
      [TaskType.GENERATE]:      'Generating Playwright test code...',
      [TaskType.RECORD]:        `Opening browser recorder for ${url}...`,
      [TaskType.EXECUTE]:       'Running test suite...',
      [TaskType.HEAL]:          'Scanning and healing broken selectors...',
      [TaskType.SCAFFOLD]:      'Scaffolding POM framework structure...',
      [TaskType.REPORT]:        'Generating test report...',
      [TaskType.API_TEST]:      `Running API tests against ${url}...`,
      [TaskType.PERFORMANCE]:   `Measuring performance metrics for ${url}...`,
      [TaskType.ACCESSIBILITY]: 'Running accessibility audit (WCAG 2.1 AA)...',
      [TaskType.SECURITY]:      `Running security checks for ${url}...`,
      [TaskType.LOCATE]:        'Finding best locators for your element...',
    };
    const text = responses[intent.type] ?? `Processing: "${message}"`;
    if (intent.confidence < 0.5) {
      return { text: 'Try: "plan tests for https://example.com", "run tests", "heal broken tests", "check accessibility".' };
    }
    const agentTask = createTask(intent.type, { ...intent.params, url }, this.name, Priority.NORMAL);
    eventBus.publish('orchestrator:task', agentTask);
    return { text, result: { taskId: agentTask.id, dispatched: intent.type } };
  }
}
