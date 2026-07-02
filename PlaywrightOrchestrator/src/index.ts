#!/usr/bin/env node
import { Command } from 'commander';
import * as dotenv from 'dotenv';
import chalk from 'chalk';
import * as path from 'path';

dotenv.config();

import { agentRegistry } from './agents/base/AgentRegistry';
import { OrchestratorAgent }       from './agents/OrchestratorAgent';
import { TestPlannerAgent }        from './agents/TestPlannerAgent';
import { TestGeneratorAgent }      from './agents/TestGeneratorAgent';
import { RecorderAgent }           from './agents/RecorderAgent';
import { LocatorAgent }            from './agents/LocatorAgent';
import { InspectorAgent }          from './agents/InspectorAgent';
import { ExecutionAgent }          from './agents/ExecutionAgent';
import { TestHealerAgent }         from './agents/TestHealerAgent';
import { FrameworkAgent }          from './agents/FrameworkAgent';
import { ReportAgent }             from './agents/ReportAgent';
import { AIChatAgent }             from './agents/AIChatAgent';
import { APITestingAgent }         from './agents/APITestingAgent';
import { PerformanceTestingAgent } from './agents/PerformanceTestingAgent';
import { AccessibilityAgent }      from './agents/AccessibilityAgent';
import { SecurityTestingAgent }    from './agents/SecurityTestingAgent';
import { createTask, TaskType, Priority } from './models/AgentTask';
import { logger } from './core/Logger';

async function bootstrap(): Promise<OrchestratorAgent> {
  console.log(chalk.cyan.bold('\n  Playwright Orchestrator'));
  console.log(chalk.dim('  Multi-Agent QA Automation Framework\n'));

  const agents = [
    new OrchestratorAgent(),
    new TestPlannerAgent(),
    new TestGeneratorAgent(),
    new RecorderAgent(),
    new LocatorAgent(),
    new InspectorAgent(),
    new ExecutionAgent(),
    new TestHealerAgent(),
    new FrameworkAgent(),
    new ReportAgent(),
    new AIChatAgent(),
    new APITestingAgent(),
    new PerformanceTestingAgent(),
    new AccessibilityAgent(),
    new SecurityTestingAgent(),
  ];

  for (const agent of agents) agentRegistry.register(agent);
  await agentRegistry.initAll();
  console.log(chalk.green(`  ${agents.length} agents initialized\n`));
  return agentRegistry.get('OrchestratorAgent') as OrchestratorAgent;
}

async function teardown(): Promise<void> {
  await agentRegistry.destroyAll();
}

const program = new Command();
program.name('pworch').description('Playwright Orchestrator -- Multi-Agent QA Framework').version('1.0.0');

program.command('status').description('Show all agent statuses').action(async () => {
  await bootstrap();
  console.log(chalk.bold('\nAgent Status:'));
  for (const [name, status] of Object.entries(agentRegistry.status())) {
    const color = status === 'READY' ? chalk.green : status === 'ERROR' ? chalk.red : chalk.yellow;
    console.log(`  ${color(status.padEnd(12))} ${name}`);
  }
  console.log();
  await teardown();
});

program.command('plan').description('Create a test plan').argument('<url>').option('-n, --name <n>', 'App name', 'Application')
  .action(async (url: string, opts: { name: string }) => {
    const orch = await bootstrap();
    const result = await orch.execute(createTask(TaskType.PLAN, { url, appName: opts.name }, 'CLI', Priority.HIGH));
    const plan = result.data.plan as Record<string, unknown>;
    if (plan) {
      console.log(chalk.green(`\nPlan: ${plan.name as string} | Scenarios: ${(plan.scenarios as unknown[]).length} | ~${plan.estimatedDuration as number} min`));
    }
    await teardown();
  });

program.command('generate').description('Generate tests from a URL').argument('<url>')
  .action(async (url: string) => {
    const orch = await bootstrap();
    const planResult = await orch.execute(createTask(TaskType.PLAN, { url }, 'CLI', Priority.HIGH));
    const result = await orch.execute(createTask(TaskType.GENERATE, { url, plan: planResult.data.plan }, 'CLI', Priority.HIGH));
    console.log(chalk.green(`\nGenerated: ${result.data.testCases as number} test files`));
    (result.data.files as string[])?.forEach((f: string) => console.log(chalk.dim(`  ${f}`)));
    await teardown();
  });

program.command('execute').description('Run Playwright tests')
  .option('-p, --path <p>', 'Test path').option('--project <p>', 'Browser project')
  .option('--headed', 'Run headed', false).option('-w, --workers <n>', 'Workers', '4')
  .action(async (opts: { path?: string; project?: string; headed: boolean; workers: string }) => {
    const orch = await bootstrap();
    const result = await orch.execute(createTask(TaskType.EXECUTE, {
      testPath: opts.path, project: opts.project, headed: opts.headed, workers: parseInt(opts.workers),
    }, 'CLI', Priority.HIGH));
    const s = result.data.stats as Record<string, number>;
    if (s) console.log(chalk.bold('\nResults:'), chalk.green(`${s.passed} passed`), chalk.red(`${s.failed} failed`), chalk.yellow(`${s.skipped} skipped`));
    await teardown();
    process.exit((result.data.exitCode as number) ?? 0);
  });

program.command('heal').description('Auto-fix broken selectors')
  .option('--url <url>', 'URL for healing').option('--apply', 'Apply fixes', false)
  .action(async (opts: { url?: string; apply: boolean }) => {
    const orch = await bootstrap();
    const result = await orch.execute(createTask(TaskType.HEAL, { url: opts.url, dryRun: !opts.apply }, 'CLI', Priority.HIGH));
    console.log(chalk.green(`\nHealed: ${result.data.count as number} selectors (dry-run: ${!opts.apply})`));
    await teardown();
  });

program.command('scaffold').description('Scaffold POM framework')
  .option('-d, --dir <d>', 'Target dir', './framework').option('-n, --name <n>', 'App name', 'MyApp')
  .option('-p, --pages <p>', 'Page names (comma-separated)', 'Home,Login')
  .action(async (opts: { dir: string; name: string; pages: string }) => {
    const orch = await bootstrap();
    const result = await orch.execute(createTask(TaskType.SCAFFOLD, {
      targetDir: path.resolve(opts.dir), appName: opts.name,
      pages: opts.pages.split(',').map((p: string) => p.trim()),
    }, 'CLI', Priority.HIGH));
    console.log(chalk.green(`\nScaffolded: ${result.data.count as number} files at ${result.data.targetDir as string}`));
    await teardown();
  });

program.command('report').description('Generate test report')
  .option('-f, --format <f>', 'html | json', 'html').option('-t, --title <t>', 'Title', 'Playwright Orchestrator Report')
  .action(async (opts: { format: string; title: string }) => {
    const orch = await bootstrap();
    const result = await orch.execute(createTask(TaskType.REPORT, { format: opts.format, title: opts.title }, 'CLI', Priority.NORMAL));
    console.log(chalk.green(`\nReport: ${result.data.reportPath as string}`));
    await teardown();
  });

program.command('accessibility').alias('a11y').description('WCAG 2.1 AA accessibility audit').argument('<url>')
  .option('--level <l>', 'WCAG level', 'wcag21aa')
  .action(async (url: string, opts: { level: string }) => {
    const orch = await bootstrap();
    const result = await orch.execute(createTask(TaskType.ACCESSIBILITY, { url, wcagLevel: opts.level }, 'CLI', Priority.HIGH));
    const count = result.data.violationCount as number;
    console.log(count === 0 ? chalk.green('\nNo violations!') : chalk.red(`\n${count} violations (${result.data.criticalCount as number} critical/serious)`));
    console.log(result.data.summary as string);
    await teardown();
    process.exit(result.data.passed ? 0 : 1);
  });

program.command('security').description('Security scan').argument('<url>')
  .option('--depth <d>', 'basic | deep', 'basic')
  .action(async (url: string, opts: { depth: string }) => {
    const orch = await bootstrap();
    const result = await orch.execute(createTask(TaskType.SECURITY, { url, depth: opts.depth }, 'CLI', Priority.HIGH));
    const total = result.data.total as number;
    console.log(total === 0 ? chalk.green('\nNo security issues!') : chalk.red(`\n${total} findings`));
    const by = result.data.bySeverity as Record<string, number>;
    if (by) Object.entries(by).forEach(([sev, cnt]) => console.log(`  ${sev}: ${cnt}`));
    await teardown();
    process.exit(result.data.passed ? 0 : 1);
  });

program.command('performance').alias('perf').description('Performance test').argument('<url>')
  .option('-r, --runs <n>', 'Number of runs', '3')
  .action(async (url: string, opts: { runs: string }) => {
    const orch = await bootstrap();
    const result = await orch.execute(createTask(TaskType.PERFORMANCE, { url, runs: parseInt(opts.runs) }, 'CLI', Priority.HIGH));
    const avg = result.data.avg as Record<string, unknown>;
    if (avg) {
      console.log(chalk.bold('\nAvg Metrics:'));
      console.log(`  FCP:       ${(avg.fcp as number)?.toFixed(0) ?? 'N/A'}ms`);
      console.log(`  Load:      ${(avg.loadComplete as number)?.toFixed(0)}ms`);
      console.log(`  Resources: ${avg.resourceCount} (${avg.transferSizeKb}kb)`);
    }
    const violations = result.data.violations as string[];
    violations?.forEach(v => console.log(chalk.yellow(`  WARN: ${v}`)));
    await teardown();
    process.exit(result.data.passed ? 0 : 1);
  });

program.command('api').description('API testing').argument('<url>')
  .option('--token <t>', 'Bearer token')
  .action(async (url: string, opts: { token?: string }) => {
    const orch = await bootstrap();
    const result = await orch.execute(createTask(TaskType.API_TEST, { url, token: opts.token }, 'CLI', Priority.HIGH));
    console.log(chalk.bold(`\nAPI: ${result.data.passed as number}/${result.data.total as number} passed`));
    await teardown();
    process.exit(result.data.failed ? 1 : 0);
  });

program.command('chat').description('Natural language interface').argument('<message>')
  .option('--url <url>', 'Target URL')
  .action(async (message: string, opts: { url?: string }) => {
    const orch = await bootstrap();
    const result = await orch.execute(createTask(TaskType.CHAT, { message, url: opts.url ?? '' }, 'CLI', Priority.NORMAL));
    console.log(chalk.cyan(`\n${result.data.response as string}`));
    await teardown();
  });

program.command('orchestrate').description('Run a named workflow')
  .argument('<workflow>', 'full-cycle | quick-check | generate-and-run | audit')
  .argument('<url>', 'Target URL')
  .action(async (workflow: string, url: string) => {
    const orch = await bootstrap();
    console.log(chalk.magenta.bold(`\nWorkflow: ${workflow} => ${url}\n`));
    const result = await orch.execute(createTask(TaskType.ORCHESTRATE, { workflow, url }, 'CLI', Priority.HIGH));
    console.log(result.data.passed ? chalk.green('\nWorkflow PASSED') : chalk.red('\nWorkflow FAILED'));
    await teardown();
    process.exit(result.data.passed ? 0 : 1);
  });

program.parseAsync(process.argv).catch((err: Error) => {
  logger.error(`CLI error: ${err.message}`);
  process.exit(1);
});
