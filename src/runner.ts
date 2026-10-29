import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { checkPaths, getPath, type Check } from './assertions.ts';
import {
  nodeItems,
  type Execution,
  type N8nClient,
  type WebhookResponse,
} from './n8n-client.ts';
import { findTargetExecution, triggerThroughHarness } from './harness.ts';
import {
  loadScenario,
  type Capture,
  type Expectations,
  type Scenario,
  type Step,
  type Trigger,
} from './scenario.ts';
import {
  interpolate,
  interpolateText,
  resolveVariables,
  type Variables,
} from './variables.ts';

// Keeps run history files and UI payloads small for workflows that produce
// many items.
const MAX_ITEMS_PER_NODE = 20;

export type NodeSummary = {
  name: string;
  status: 'success' | 'error';
  itemCount: number;
  items: unknown[];
  error?: string;
};

export type ExecutionSummary = {
  id: string;
  status: string;
  nodes: NodeSummary[];
};

export type StepResult = {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  executionId?: string;
  executionError?: string;
  // Per-node output, only when the run asked for it (the UI does).
  execution?: ExecutionSummary;
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

export type RunOptions = {
  // Look up the execution for every step, so its node output can be shown,
  // even when the step has no execution checks.
  includeExecution?: boolean;
  onStepStart?: (event: { index: number; name: string }) => void;
  onStepEnd?: (event: { index: number; result: StepResult }) => void;
};

// Nodes in the order n8n ran them, with each node's first run and first output.
export function summarizeExecution(execution: Execution): ExecutionSummary {
  const runData = execution.data?.resultData?.runData ?? {};

  const nodes = Object.entries(runData).map(([name, runs]): NodeSummary => {
    const run = runs[0];
    const items = (run?.data?.main?.[0] ?? []).map((item) => item.json);
    const summary: NodeSummary = {
      name,
      status: run?.error ? 'error' : 'success',
      itemCount: items.length,
      items: items.slice(0, MAX_ITEMS_PER_NODE),
    };

    if (run?.error?.message) {
      summary.error = run.error.message;
    }

    return summary;
  });

  return { id: execution.id, status: execution.status, nodes };
}

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

function interpolateTrigger(trigger: Trigger, variables: Variables): Trigger {
  if ('harness' in trigger) {
    const input = interpolate(trigger.harness.input, variables);
    return { harness: { input: input as Record<string, unknown> } };
  }

  const webhook = trigger.webhook;
  const textValues = (values: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        interpolateText(value, variables),
      ]),
    );

  return {
    webhook: {
      ...webhook,
      path: interpolateText(webhook.path, variables),
      query: textValues(webhook.query),
      headers: textValues(webhook.headers),
      body: interpolate(webhook.body, variables),
    },
  };
}

function fireTrigger(
  trigger: Trigger,
  client: N8nClient,
  workflowId: string,
  testRunId: string,
) {
  return 'webhook' in trigger
    ? client.triggerWebhook(trigger.webhook, testRunId)
    : triggerThroughHarness(client, workflowId, trigger.harness.input, testRunId);
}

// Through the harness, the run we check is the target's own execution, not
// the harness execution that started it.
function findStepExecution(
  trigger: Trigger,
  client: N8nClient,
  workflowId: string,
  testRunId: string,
) {
  return 'webhook' in trigger
    ? client.findExecution(workflowId, testRunId)
    : findTargetExecution(client, testRunId);
}

async function runStep(
  step: Step,
  client: N8nClient,
  variables: Variables,
  includeExecution: boolean,
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
    const trigger = interpolateTrigger(step.trigger, variables);
    // Only values change here, so the structure still matches the schema.
    const expect = interpolate(step.expect, variables) as Expectations;

    const workflow = await client.resolveWorkflow(step.workflow);
    const testRunId = randomUUID();
    const response = await fireTrigger(trigger, client, workflow.id, testRunId);
    result.checks.push(...responseChecks(response, expect.response));

    // Looking up the execution means polling, so only do it when needed.
    const capturesNodes = Object.values(step.capture).some(
      (capture) => typeof capture !== 'string',
    );
    let execution: Execution | undefined;

    if (expect.execution || capturesNodes || includeExecution) {
      execution = await findStepExecution(trigger, client, workflow.id, testRunId);
      result.executionId = execution.id;
      result.executionError = execution.data?.resultData?.error?.message;

      if (includeExecution) {
        result.execution = summarizeExecution(execution);
      }
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
  options: RunOptions = {},
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

  for (const [index, step] of scenario.steps.entries()) {
    // Later steps usually depend on earlier ones, so stop at the first failure.
    const previousFailed = result.steps.some((done) => done.status !== 'passed');
    let stepResult: StepResult;

    if (previousFailed) {
      stepResult = {
        name: step.name,
        status: 'skipped',
        durationMs: 0,
        checks: [],
        captured: {},
      };
    } else {
      options.onStepStart?.({ index, name: step.name });
      stepResult = await runStep(
        step,
        client,
        variables,
        options.includeExecution ?? false,
      );
      Object.assign(variables, stepResult.captured);
    }

    result.steps.push(stepResult);
    options.onStepEnd?.({ index, result: stepResult });
  }

  result.passed = result.steps.every((step) => step.status === 'passed');
  result.durationMs = Date.now() - startedAt;
  return result;
}

// Loads and runs one file. A file that cannot be loaded becomes a failed
// result instead of an exception, so one bad file never stops a whole run.
export async function runScenarioFile(
  file: string,
  client: N8nClient,
  environmentVariables: Variables = {},
  options: RunOptions = {},
): Promise<ScenarioResult> {
  try {
    const scenario = await loadScenario(file);
    return await runScenario(scenario, client, environmentVariables, options);
  } catch (error) {
    return {
      file,
      name: basename(file),
      passed: false,
      durationMs: 0,
      steps: [],
      error: (error as Error).message,
    };
  }
}
