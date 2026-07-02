import { AgentTask, Priority } from '../models/AgentTask';

export class TaskQueue {
  private queues: Map<Priority, AgentTask[]> = new Map([
    [Priority.CRITICAL, []],
    [Priority.HIGH,     []],
    [Priority.NORMAL,   []],
    [Priority.LOW,      []],
  ]);

  enqueue(task: AgentTask): void {
    const queue = this.queues.get(task.priority) ?? this.queues.get(Priority.NORMAL)!;
    queue.push(task);
  }

  dequeue(): AgentTask | undefined {
    for (const p of [Priority.CRITICAL, Priority.HIGH, Priority.NORMAL, Priority.LOW]) {
      const q = this.queues.get(p)!;
      if (q.length > 0) return q.shift();
    }
    return undefined;
  }

  peek(): AgentTask | undefined {
    for (const p of [Priority.CRITICAL, Priority.HIGH, Priority.NORMAL, Priority.LOW]) {
      const q = this.queues.get(p)!;
      if (q.length > 0) return q[0];
    }
    return undefined;
  }

  size(): number {
    return Array.from(this.queues.values()).reduce((s, q) => s + q.length, 0);
  }

  isEmpty(): boolean {
    return this.size() === 0;
  }

  clear(): void {
    this.queues.forEach(q => q.splice(0));
  }

  byPriority(): Record<string, number> {
    const out: Record<string, number> = {};
    this.queues.forEach((q, p) => { out[Priority[p]] = q.length; });
    return out;
  }
}
