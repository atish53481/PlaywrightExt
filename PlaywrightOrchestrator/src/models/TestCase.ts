export interface TestStep {
  order: number;
  action: string;
  target?: string;
  value?: string;
  assertion?: string;
  screenshot?: boolean;
}

export interface TestCase {
  id: string;
  name: string;
  filePath: string;
  describe: string;
  steps: TestStep[];
  tags: string[];
  timeout?: number;
  retries?: number;
  browserProjects?: string[];
  code?: string;
}
