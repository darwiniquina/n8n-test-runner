import { randomUUID } from 'node:crypto';
import { checkPaths, getPath, type Check } from './assertions.ts';
import {
  nodeItems,
  type Execution,
  type N8nClient,
  type WebhookResponse,
} from './n8n-client.ts';
import type { Capture, Expectations, Scenario, Step } from './scenario.ts';
import {
  interpolate,
  interpolateText,
  resolveVariables,
  type Variables,
} from './variables.ts';

export type StepResult = {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  executionId?: string;
  executionError?: string;
  checks: Check[];
  captured: Variables;
  error?: string;
};

export type ScenarioResult = {
  file: string;
  name: string;
  passed: boolean;
  durationMs: number;
  steps: StepResult[];
  // Set when the scenario could not start at all (bad file, bad variables).
  error?: string;
};

function responseChecks(
  response: WebhookResponse,
  expectations: Expectations['response'],
): Check[] {
  const checks: Check[] = [];

  if (expectations?.status !== undefined) {
    checks.push({
      label: 'response status',
      passed: response.status === expectations.status,
      expected: expectations.status,
      actual: response.status,
    });
  }

  if (expectations?.maxDurationMs !== undefined) {
    checks.push({
      label: `response time <= ${expectations.maxDurationMs}ms`,
      passed: response.durationMs <= expectations.maxDurationMs,
      actual: `${response.durationMs}ms`,
    });
  }

  if (expectations?.body) {
    checks.push(...checkPaths('response body', response.body, expectations.body));
  }

  return checks;
}

function executionChecks(
  execution: Execution,
  expectations: NonNullable<Expectations['execution']>,
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

function captureValues(
  captures: Record<string, Capture>,
  response: WebhookResponse,
  execution: Execution | undefined,
): Variables {
  const captured: Variables = {};

  for (const [name, capture] of Object.entries(captures)) {
    let value: unknown;
    let source: string;

    if (typeof capture === 'string') {
      value = getPath({ response }, capture);
      source = capture;
    } else {
      const items = execution ? nodeItems(execution, capture.node) : undefined;
      value = getPath(items, capture.path);
      source = `node "${capture.node}" ${capture.path}`.trim();
    }

    // Later steps would otherwise fail with a confusing "unknown variable".
    if (value === undefined) {
      throw new Error(`Capture "${name}" found nothing at ${source}.`);
    }

    captured[name] = value;
  }

  return captured;
}

function interpolateTrigger(step: Step, variables: Variables) {
  const webhook = step.trigger.webhook;
  const textValues = (values: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        interpolateText(value, variables),
      ]),
    );

  return {
    ...webhook,
    path: interpolateText(webhook.path, variables),
    query: textValues(webhook.query),
    headers: textValues(webhook.headers),
    body: interpolate(webhook.body, variables),
  };
}

async function runStep(
  step: Step,
  client: N8nClient,
  variables: Variables,
): Promise<StepResult> {
  const startedAt = Date.now();
  const result: StepResult = {
    name: step.name,
    status: 'failed',
    durationMs: 0,
    checks: [],
    captured: {},
  };

  try {
    const trigger = interpolateTrigger(step, variables);
    // Only values change here, so the structure still matches the schema.
    const expect = interpolate(step.expect, variables) as Expectations;

    const workflow = await client.resolveWorkflow(step.workflow);
    const testRunId = randomUUID();
    const response = await client.triggerWebhook(trigger, testRunId);
    result.checks.push(...responseChecks(response, expect.response));

    // Looking up the execution means polling, so only do it when needed.
    const capturesNodes = Object.values(step.capture).some(
      (capture) => typeof capture !== 'string',
    );
    let execution: Execution | undefined;

    if (expect.execution || capturesNodes) {
      execution = await client.findExecution(workflow.id, testRunId);
      result.executionId = execution.id;
      result.executionError = execution.data?.resultData?.error?.message;
    }

    if (execution && expect.execution) {
      result.checks.push(...executionChecks(execution, expect.execution));
    }

    // A step without checks or captures would always pass, which hides mistakes.
    const hasCaptures = Object.keys(step.capture).length > 0;
    if (result.checks.length === 0 && !hasCaptures) {
      throw new Error('Step has nothing to check. Add "expect" or "capture".');
    }

    result.captured = captureValues(step.capture, response, execution);
    result.status = result.checks.every((check) => check.passed)
      ? 'passed'
      : 'failed';
  } catch (error) {
    result.error = (error as Error).message;
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}

export async function runScenario(
  scenario: Scenario,
  client: N8nClient,
  environmentVariables: Variables = {},
): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const result: ScenarioResult = {
    file: scenario.file,
    name: scenario.name,
    passed: false,
    durationMs: 0,
    steps: [],
  };

  let variables: Variables;
  try {
    variables = resolveVariables(
      scenario.variables,
      resolveVariables(environmentVariables),
    );
  } catch (error) {
    result.error = (error as Error).message;
    return result;
  }

  for (const step of scenario.steps) {
    // Later steps usually depend on earlier ones, so stop at the first failure.
    const previousFailed = result.steps.some((done) => done.status !== 'passed');
    if (previousFailed) {
      result.steps.push({
        name: step.name,
        status: 'skipped',
        durationMs: 0,
        checks: [],
        captured: {},
      });
      continue;
    }

    const stepResult = await runStep(step, client, variables);
    Object.assign(variables, stepResult.captured);
    result.steps.push(stepResult);
  }

  result.passed = result.steps.every((step) => step.status === 'passed');
  result.durationMs = Date.now() - startedAt;
  return result;
}
