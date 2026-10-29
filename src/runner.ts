import { randomUUID } from 'node:crypto';
import { checkPaths, type Check } from './assertions.ts';
import { nodeItems, type Execution, type N8nClient } from './n8n-client.ts';
import type { Scenario } from './scenario.ts';

export type ScenarioResult = {
  file: string;
  name: string;
  passed: boolean;
  durationMs: number;
  executionId?: string;
  executionError?: string;
  checks: Check[];
  error?: string;
};

function executionChecks(
  execution: Execution,
  expectations: NonNullable<Scenario['expect']['execution']>,
): Check[] {
  const checks: Check[] = [];

  if (expectations.status) {
    checks.push({
      label: 'execution status',
      passed: execution.status === expectations.status,
      expected: expectations.status,
      actual: execution.status,
    });
  }

  for (const [nodeName, node] of Object.entries(expectations.nodes ?? {})) {
    const items = nodeItems(execution, nodeName);
    const ran = items !== undefined;

    checks.push({
      label: `node "${nodeName}" ${node.ran ? 'ran' : 'did not run'}`,
      passed: ran === node.ran,
    });

    if (ran && node.output) {
      checks.push(...checkPaths(`node "${nodeName}" output`, items, node.output));
    }
  }

  return checks;
}

export async function runScenario(
  scenario: Scenario,
  client: N8nClient,
): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const result: ScenarioResult = {
    file: scenario.file,
    name: scenario.name,
    passed: false,
    durationMs: 0,
    checks: [],
  };

  try {
    const { expect } = scenario;
    const workflow = await client.resolveWorkflow(scenario.workflow);
    const testRunId = randomUUID();
    const response = await client.triggerWebhook(
      scenario.trigger.webhook,
      testRunId,
    );

    if (expect.response?.status !== undefined) {
      result.checks.push({
        label: 'response status',
        passed: response.status === expect.response.status,
        expected: expect.response.status,
        actual: response.status,
      });
    }

    if (expect.response?.maxDurationMs !== undefined) {
      result.checks.push({
        label: `response time <= ${expect.response.maxDurationMs}ms`,
        passed: response.durationMs <= expect.response.maxDurationMs,
        actual: `${response.durationMs}ms`,
      });
    }

    if (expect.response?.body) {
      result.checks.push(
        ...checkPaths('response body', response.body, expect.response.body),
      );
    }

    // Looking up the execution means polling, so only do it when asked to.
    if (expect.execution) {
      const execution = await client.findExecution(workflow.id, testRunId);
      result.executionId = execution.id;
      result.executionError = execution.data?.resultData?.error?.message;
      result.checks.push(...executionChecks(execution, expect.execution));
    }

    // A scenario without checks would always pass, which hides mistakes.
    if (result.checks.length === 0) {
      throw new Error('Scenario has no expectations under "expect".');
    }

    result.passed = result.checks.every((check) => check.passed);
  } catch (error) {
    result.error = (error as Error).message;
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}
