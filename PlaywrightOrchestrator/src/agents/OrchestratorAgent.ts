import { Agent, AgentStatus } from './base/Agent';
import { AgentTask, AgentResult, TaskType, TaskStatus, createTask, Priority } from '../models/AgentTask';
import { agentRegistry } from './base/AgentRegistry';
import { eventBus } from '../core/EventBus';
import { TaskQueue } from '../core/TaskQueue';

const AGENT_ROUTE: Partial<Record<TaskType, string>> = {
  [TaskType.PLAN]:          'TestPlannerAgent',
  [TaskType.GENERATE]:      'TestGeneratorAgent',
  [TaskType.RECORD]:        'RecorderAgent',
  [TaskType.LOCATE]:        'LocatorAgent',
  [TaskType.INSPECT]:       'InspectorAgent',
  [TaskType.EXECUTE]:       'ExecutionAgent',
  [TaskType.HEAL]:          'TestHealerAgent',
  [TaskType.SCAFFOLD]:      'FrameworkAgent',
  [TaskType.REPORT]:        'ReportAgent',
  [TaskType.CHAT]:          'AIChatAgent',
  [TaskType.API_TEST]:      'APITestingAgent',
  [TaskType.PERFORMANCE]:   'PerformanceTestingAgent',
  [TaskType.ACCESSIBILITY]: 'AccessibilityAgent',
  [TaskType.SECURITY]:      'SecurityTestingAgent',
};

export class OrchestratorAgent extends Agent {
  private queue: TaskQueue = new TaskQueue();
  private processing = false;

  constructor() {
    super('OrchestratorAgent', '1.0.0', { supportedTaskTypes: [TaskType.ORCHESTRATE] });
  }

  async init(): Promise<void> {
    this.status = AgentStatus.READY;
    this.log.info('Master orchestrator ready');
    eventBus.subscribe<AgentTask>('orchestrator:task', (task) => this.enqueue(task));
  }

  enqueue(task: AgentTask): void {
    this.queue.enqueue(task);
    this.log.info(`Task queued: ${task.type} [${task.id.slice(0, 8)}] priority=${Priority[task.priority]}`);
    if (!this.processing) void this.drain();
  }

  private async drain(): Promise<void> {
    this.processing = true;
    while (!this.queue.isEmpty()) {
      const task = this.queue.dequeue();
      if (task) await this.dispatch(task);
    }
    this.processing = false;
  }

  private async dispatch(task: AgentTask): Promise<AgentResult> {
    const t0 = Date.now();
    const agentName = task.recipient ?? AGENT_ROUTE[task.type];

    if (!agentName) {
      const err = `No agent registered for task type: ${task.type}`;
      this.log.error(err);
      return this.createResult(task, TaskStatus.FAILURE, {}, t0, [err]);
    }

    const agent = agentRegistry.get(agentName);
    if (!agent) {
      const err = `Agent not found in registry: ${agentName}`;
      this.log.error(err);
      return this.createResult(task, TaskStatus.FAILURE, {}, t0, [err]);
    }

    if (!agent.isReady()) {
      this.log.warn(`Agent ${agentName} busy — requeueing`);
      this.queue.enqueue({ ...task, priority: Priority.HIGH });
      return this.createResult(task, TaskStatus.PARTIAL, { requeued: true }, t0);
    }

    this.log.info(`Dispatching ${task.type} → ${agentName}`);
    const result = await agent.execute(task);
    this.broadcastResult(result);
    eventBus.publish(`orchestrator:result:${task.id}`, result);
    return result;
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const t0 = Date.now();
    if (task.type === TaskType.ORCHESTRATE) {
      const workflow = task.payload.workflow as string;
      this.log.info(`Running workflow: ${workflow}`);
      const result = await this.runWorkflow(workflow, task);
      return this.createResult(task, result.status, result.data, t0);
    }
    return this.dispatch(task);
  }

  private async runWorkflow(workflow: string, parentTask: AgentTask): Promise<AgentResult> {
    const t0 = Date.now();
    const url = parentTask.payload.url as string;

    const workflows: Record<string, TaskType[]> = {
      'full-cycle': [TaskType.PLAN, TaskType.GENERATE, TaskType.EXECUTE, TaskType.REPORT],
      'quick-check': [TaskType.ACCESSIBILITY, TaskType.SECURITY, TaskType.PERFORMANCE],
      'generate-and-run': [TaskType.GENERATE, TaskType.EXECUTE],
      'audit': [TaskType.ACCESSIBILITY, TaskType.SECURITY],
    };

    const steps = workflows[workflow];
    if (!steps) return this.createResult(parentTask, TaskStatus.FAILURE, {}, t0, [`Unknown workflow: ${workflow}`]);

    const results: AgentResult[] = [];
    let planData: Record<string, unknown> = { url };

    for (const type of steps) {
      const task = createTask(type, planData, this.name, Priority.HIGH);
      const result = await this.dispatch(task);
      results.push(result);
      planData = { ...planData, ...result.data, url };
      if (result.status === TaskStatus.FAILURE) break;
    }

    const allPassed = results.every(r => r.status === TaskStatus.SUCCESS);
    return this.createResult(parentTask, allPassed ? TaskStatus.SUCCESS : TaskStatus.PARTIAL,
      { workflow, steps: results.length, results }, t0);
  }

  queueSize(): number { return this.queue.size(); }
}
