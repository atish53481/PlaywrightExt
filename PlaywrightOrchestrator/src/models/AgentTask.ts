import { v4 as uuidv4 } from 'uuid';

export enum TaskType {
  PLAN         = 'PLAN',
  GENERATE     = 'GENERATE',
  RECORD       = 'RECORD',
  LOCATE       = 'LOCATE',
  INSPECT      = 'INSPECT',
  EXECUTE      = 'EXECUTE',
  HEAL         = 'HEAL',
  SCAFFOLD     = 'SCAFFOLD',
  REPORT       = 'REPORT',
  CHAT         = 'CHAT',
  API_TEST     = 'API_TEST',
  PERFORMANCE  = 'PERFORMANCE',
  ACCESSIBILITY= 'ACCESSIBILITY',
  SECURITY     = 'SECURITY',
  ORCHESTRATE  = 'ORCHESTRATE',
}

export enum Priority {
  LOW      = 1,
  NORMAL   = 2,
  HIGH     = 3,
  CRITICAL = 4,
}

export enum TaskStatus {
  PENDING   = 'PENDING',
  RUNNING   = 'RUNNING',
  SUCCESS   = 'SUCCESS',
  FAILURE   = 'FAILURE',
  CANCELLED = 'CANCELLED',
  PARTIAL   = 'PARTIAL',
}

export interface AgentTask {
  id: string;
  type: TaskType;
  payload: Record<string, unknown>;
  priority: Priority;
  sender: string;
  recipient?: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface AgentResult {
  taskId: string;
  agentName: string;
  status: TaskStatus;
  data: Record<string, unknown>;
  errors?: string[];
  duration: number;
  timestamp: Date;
}

export function createTask(
  type: TaskType,
  payload: Record<string, unknown>,
  sender: string,
  priority: Priority = Priority.NORMAL,
  recipient?: string,
): AgentTask {
  return {
    id: uuidv4(),
    type,
    payload,
    priority,
    sender,
    recipient,
    timestamp: new Date(),
  };
}
