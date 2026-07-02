import { v4 as uuidv4 } from 'uuid';

export enum MessageType {
  REQUEST   = 'REQUEST',
  RESPONSE  = 'RESPONSE',
  BROADCAST = 'BROADCAST',
  HEARTBEAT = 'HEARTBEAT',
  ERROR     = 'ERROR',
}

export interface AgentMessage {
  id: string;
  type: MessageType;
  from: string;
  to?: string;
  subject: string;
  body: Record<string, unknown>;
  timestamp: Date;
  correlationId?: string;
}

export function createMessage(
  type: MessageType,
  from: string,
  subject: string,
  body: Record<string, unknown>,
  to?: string,
  correlationId?: string,
): AgentMessage {
  return { id: uuidv4(), type, from, to, subject, body, timestamp: new Date(), correlationId };
}
