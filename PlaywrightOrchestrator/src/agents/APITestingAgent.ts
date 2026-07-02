import { chromium, Browser, APIRequestContext } from '@playwright/test';
import { Agent, AgentStatus } from './base/Agent';
import { AgentTask, AgentResult, TaskType, TaskStatus } from '../models/AgentTask';

export interface ApiTestSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  endpoint: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  expectedStatus: number;
  expectedFields?: string[];
}

export interface ApiTestResult {
  spec: ApiTestSpec;
  status: number;
  passed: boolean;
  responseBody?: unknown;
  durationMs: number;
  error?: string;
}

export class APITestingAgent extends Agent {
  private browser?: Browser;

  constructor() {
    super('APITestingAgent', '1.0.0', { supportedTaskTypes: [TaskType.API_TEST] });
  }

  async init(): Promise<void> {
    this.status = AgentStatus.READY;
    this.log.info('API Testing Agent ready');
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const t0 = Date.now();
    this.status = AgentStatus.BUSY;
    try {
      const baseUrl = task.payload.url as string ?? task.payload.baseUrl as string;
      const specs = task.payload.specs as ApiTestSpec[] ?? this.defaultSpecs();
      const token = task.payload.token as string;
      this.browser = await chromium.launch({ headless: true });
      const ctx = await this.browser.newContext({
        baseURL: baseUrl,
        extraHTTPHeaders: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
      });
      const results: ApiTestResult[] = [];
      for (const spec of specs) {
        const r = await this.runSpec(ctx.request, spec);
        results.push(r);
        this.log.info(`${spec.method} ${spec.endpoint} => ${r.status} [${r.passed ? 'PASS' : 'FAIL'}]`);
      }
      await ctx.close();
      const failed = results.filter(r => !r.passed).length;
      this.status = AgentStatus.READY;
      return this.createResult(task, failed === 0 ? TaskStatus.SUCCESS : TaskStatus.FAILURE, {
        total: results.length, passed: results.length - failed, failed, results,
      }, t0);
    } catch (err) {
      this.status = AgentStatus.ERROR;
      return this.createResult(task, TaskStatus.FAILURE, {}, t0, [(err as Error).message]);
    } finally {
      if (this.browser) { await this.browser.close(); this.browser = undefined; }
    }
  }

  private async runSpec(request: APIRequestContext, spec: ApiTestSpec): Promise<ApiTestResult> {
    const start = Date.now();
    try {
      const opts = { data: spec.body, headers: spec.headers };
      const map: Record<string, () => Promise<unknown>> = {
        GET:    () => request.get(spec.endpoint, { headers: spec.headers }),
        POST:   () => request.post(spec.endpoint, opts),
        PUT:    () => request.put(spec.endpoint, opts),
        PATCH:  () => request.patch(spec.endpoint, opts),
        DELETE: () => request.delete(spec.endpoint, { headers: spec.headers }),
      };
      const resp = await map[spec.method]() as Awaited<ReturnType<typeof request.get>>;
      const body = await resp.json().catch(() => null);
      const statusOk = resp.status() === spec.expectedStatus;
      const fieldsOk = !spec.expectedFields || (body && spec.expectedFields.every((f: string) => f in (body as object)));
      return { spec, status: resp.status(), passed: statusOk && !!fieldsOk, responseBody: body, durationMs: Date.now() - start };
    } catch (err) {
      return { spec, status: 0, passed: false, durationMs: Date.now() - start, error: (err as Error).message };
    }
  }

  private defaultSpecs(): ApiTestSpec[] {
    return [
      { method: 'GET', endpoint: '/health', expectedStatus: 200 },
      { method: 'GET', endpoint: '/status', expectedStatus: 200 },
    ];
  }
}
