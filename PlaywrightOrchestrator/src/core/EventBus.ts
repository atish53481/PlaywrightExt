import { EventEmitter } from 'events';

export type EventHandler<T = unknown> = (data: T) => void | Promise<void>;

export class EventBus extends EventEmitter {
  private static instance: EventBus;

  private constructor() {
    super();
    this.setMaxListeners(200);
  }

  static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  subscribe<T>(event: string, handler: EventHandler<T>): void {
    this.on(event, handler as (...args: unknown[]) => void);
  }

  unsubscribe<T>(event: string, handler: EventHandler<T>): void {
    this.off(event, handler as (...args: unknown[]) => void);
  }

  publish<T>(event: string, data: T): void {
    this.emit(event, data);
  }

  async publishAsync<T>(event: string, data: T): Promise<void> {
    const handlers = this.listeners(event) as EventHandler<T>[];
    await Promise.all(handlers.map(h => Promise.resolve(h(data))));
  }

  once<T>(event: string, handler: EventHandler<T>): this {
    return super.once(event, handler as (...args: unknown[]) => void);
  }
}

export const eventBus = EventBus.getInstance();
