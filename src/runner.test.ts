import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Execution, N8nClient, WebhookResponse } from './n8n-client.ts';
import { runScenario } from './runner.ts';
import type { Scenario, Step, WebhookTrigger } from './scenario.ts';

function step(overrides: Partial<Step> = {}): Step {
  return {
    name: 'Step',
    workflow: 'Test Workflow',
    trigger: {
      webhook: { method: 'POST', path: 'items', headers: {}, query: {} },
    },
    expect: { response: { status: 200 } },
    capture: {},
    ...overrides,
  };
}

function scenario(steps: Step[], variables = {}): Scenario {
  return { file: 'test.yaml', name: 'Test', variables, steps };
}

function webhook(path: string, body?: unknown) {
  return { trigger: { webhook: { method: 'POST' as const, path, headers: {}, query: {}, body } } };
}

const execution: Execution = {
  id: '100',
  status: 'success',
  mode: 'webhook',
  startedAt: '2026-10-29T00:00:00.000Z',
  stoppedAt: '2026-10-29T00:00:01.000Z',
  data: {
    resultData: {
      runData: {
        'Append Row': [{ data: { main: [[{ json: { row_number: 5 } }]] } }],
      },
    },
  },
};

// Answers webhook calls in order and records what was sent.
function fakeClient(responses: Array<Partial<WebhookResponse>>) {
  const calls: WebhookTrigger[] = [];
  let executionLookups = 0;

  const client: N8nClient = {
    isHealthy: async () => true,
    checkApiKey: async () => {},
    resolveWorkflow: async (name) => ({ id: 'wf-1', name, active: true }),
    triggerWebhook: async (trigger) => {
      calls.push(trigger);
      const response = responses[calls.length - 1] ?? {};
      return { status: 200, body: null, durationMs: 1, ...response };
    },
    findExecution: async () => {
      executionLookups++;
      return execution;
    },
  };

  return { client, calls, executionLookups: () => executionLookups };
}

describe('runScenario', () => {
  it('passes captured values to later steps, keeping their type', async () => {
    const { client, calls } = fakeClient([{ body: { id: 42 } }]);

    const result = await runScenario(
      scenario([
        step({ capture: { itemId: 'response.body.id' } }),
        step(webhook('items/{{ itemId }}', { id: '{{ itemId }}' })),
      ]),
      client,
    );

    assert.equal(result.passed, true);
    assert.deepEqual(result.steps[0].captured, { itemId: 42 });
    assert.equal(calls[1].path, 'items/42');
    assert.deepEqual(calls[1].body, { id: 42 });
  });

  it('looks up the execution only when a step needs node data', async () => {
    const { client, executionLookups } = fakeClient([]);

    const result = await runScenario(
      scenario([
        step(),
        step({ capture: { row: { node: 'Append Row', path: '[0].row_number' } } }),
      ]),
      client,
    );

    assert.equal(executionLookups(), 1);
    assert.deepEqual(result.steps[1].captured, { row: 5 });
  });

  it('skips the remaining steps after a failure', async () => {
    const { client, calls } = fakeClient([{ status: 500 }]);

    const result = await runScenario(scenario([step(), step(), step()]), client);

    assert.equal(result.passed, false);
    assert.deepEqual(
      result.steps.map((done) => done.status),
      ['failed', 'skipped', 'skipped'],
    );
    assert.equal(calls.length, 1);
  });

  it('fails the step when a capture finds nothing', async () => {
    const { client } = fakeClient([{ body: {} }]);

    const result = await runScenario(
      scenario([step({ capture: { itemId: 'response.body.id' } })]),
      client,
    );

    assert.equal(result.steps[0].status, 'failed');
    assert.match(result.steps[0].error ?? '', /Capture "itemId" found nothing/);
  });

  it('fails the step on an unknown variable without calling n8n', async () => {
    const { client, calls } = fakeClient([]);

    const result = await runScenario(scenario([step(webhook('{{ nope }}'))]), client);

    assert.match(result.steps[0].error ?? '', /Unknown variable/);
    assert.equal(calls.length, 0);
  });

  it('fails a step that has nothing to check', async () => {
    const { client } = fakeClient([]);

    const result = await runScenario(scenario([step({ expect: {} })]), client);

    assert.match(result.steps[0].error ?? '', /nothing to check/);
  });

  it('resolves environment variables before scenario variables', async () => {
    const { client, calls } = fakeClient([]);

    await runScenario(
      scenario([step(webhook('{{ prefix }}/{{ path }}'))], { path: 'v1-{{ prefix }}' }),
      client,
      { prefix: 'api' },
    );

    assert.equal(calls[0].path, 'api/v1-api');
  });
});
