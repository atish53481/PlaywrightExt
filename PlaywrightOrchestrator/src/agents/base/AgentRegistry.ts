import { Agent } from './Agent';
import { logger } from '../../core/Logger';

export class AgentRegistry {
  private static instance: AgentRegistry;
  private agents: Map<string, Agent> = new Map();

  private constructor() {}

  static getInstance(): AgentRegistry {
    if (!AgentRegistry.instance) AgentRegistry.instance = new AgentRegistry();
    return AgentRegistry.instance;
  }

  register(agent: Agent): void {
    if (this.agents.has(agent.name)) logger.warn(`Agent [${agent.name}] overwritten`);
    this.agents.set(agent.name, agent);
    logger.info(`Agent registered: ${agent.name} v${agent.version}`);
  }

  unregister(name: string): void {
    this.agents.delete(name);
    logger.info(`Agent unregistered: ${name}`);
  }

  get(name: string): Agent | undefined { return this.agents.get(name); }
  getAll(): Agent[] { return Array.from(this.agents.values()); }
  has(name: string): boolean { return this.agents.has(name); }
  list(): string[] { return Array.from(this.agents.keys()); }

  async initAll(): Promise<void> {
    logger.info(`Initializing ${this.agents.size} agents...`);
    await Promise.all(this.getAll().map(a => a.init()));
    logger.info('All agents initialized');
  }

  async destroyAll(): Promise<void> {
    logger.info('Shutting down all agents...');
    await Promise.all(this.getAll().map(a => a.destroy()));
    logger.info('All agents stopped');
  }

  status(): Record<string, string> {
    const out: Record<string, string> = {};
    this.agents.forEach((a, name) => { out[name] = a.getStatus(); });
    return out;
  }
}

export const agentRegistry = AgentRegistry.getInstance();
