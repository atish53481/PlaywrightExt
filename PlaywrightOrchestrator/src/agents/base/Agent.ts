import { EventEmitter } from 'events';
import { AgentTask, AgentResult, TaskStatus } from '../../models/AgentTask';
import { agentLogger } from '../../core/Logger';
import { eventBus } from '../../core/EventBus';
import { AgentMessage } from './AgentMessage';

export enum AgentStatus {
  IDLE         = 'IDLE',
  INITIALIZING = 'INITIALIZING',
  READY        = 'READY',
  BUSY         = 'BUSY',
  ERROR        = 'ERROR',
  STOPPED      = 'STOPPED',
}

export interface AgentCapabilities {
  canRecord: boolean;
  canGenerate: boolean;
  canHeal: boolean;
  canReport: boolean;
  supportedTaskTypes: string[];
}

export abstract class Agent extends EventEmitter {
  readonly name: string;
  readonly version: string;
  protected status: AgentStatus = AgentStatus.IDLE;
  protected log: ReturnType<typeof agentLogger>;
  protected capabilities: AgentCapabilities;

  constructor(name: string, version = '1.0.0', capabilities?: Partial<AgentCapabilities>) {
    super();
    this.name = name;
    this.version = version;
    this.log = agentLogger(name);
    this.capabilities = {
      canRecord: false, canGenerate: false, canHeal: false, canReport: false,
      supportedTaskTypes: [], ...capabilities,
    };
    eventBus.subscribe<AgentMessage>(`agent:${name}:message`, (msg) => this.onMessage(msg));
  }

  abstract init(): Promise<void>;
  abstract execute(task: AgentTask): Promise<AgentResult>;

  async destroy(): Promise<void> {
    this.status = AgentStatus.STOPPED;
    this.log.info('Agent stopped');
  }

  getStatus(): AgentStatus { return this.status; }
  getCapabilities(): AgentCapabilities { return this.capabilities; }
  isReady(): boolean {
    return this.status === AgentStatus.READY || this.status === AgentStatus.IDLE;
  }

  protected async onMessage(message: AgentMessage): Promise<void> {
    this.log.debug(`Message: ${message.subject}`, { from: message.from });
  }

  protected createResult(
    task: AgentTask,
    status: TaskStatus,
    data: Record<string, unknown>,
    t0: number,
    errors?: string[],
  ): AgentResult {
    return {
      taskId: task.id, agentName: this.name, status, data, errors,
      duration: Date.now() - t0, timestamp: new Date(),
    };
  }

  protected broadcastResult(result: AgentResult): void {
    eventBus.publish(`agent:result:${result.taskId}`, result);
  }
}
