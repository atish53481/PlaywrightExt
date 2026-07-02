export enum TestType {
  FUNCTIONAL    = 'FUNCTIONAL',
  API           = 'API',
  PERFORMANCE   = 'PERFORMANCE',
  ACCESSIBILITY = 'ACCESSIBILITY',
  SECURITY      = 'SECURITY',
  VISUAL        = 'VISUAL',
}

export interface TestScenario {
  id: string;
  title: string;
  description: string;
  type: TestType;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  tags: string[];
  steps: string[];
  expectedOutcome: string;
  prerequisites?: string[];
}

export interface TestPlan {
  id: string;
  name: string;
  description: string;
  targetUrl: string;
  createdAt: Date;
  scenarios: TestScenario[];
  estimatedDuration: number;
  coverage: {
    functional: boolean;
    api: boolean;
    performance: boolean;
    accessibility: boolean;
    security: boolean;
  };
}
