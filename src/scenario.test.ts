import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseScenario } from './scenario.ts';

const trigger = { webhook: { path: 'items' } };

describe('parseScenario', () => {
  it('turns the single-step form into one step named after the scenario', () => {
    const scenario = parseScenario(
      {
        name: 'Single',
        workflow: 'Items',
        trigger,
        expect: { response: { status: 200 } },
      },
      'single.yaml',
    );

    assert.equal(scenario.steps.length, 1);
    assert.equal(scenario.steps[0].name, 'Single');
    assert.equal(scenario.steps[0].workflow, 'Items');
    assert.deepEqual(scenario.steps[0].capture, {});
  });

  it('accepts steps without top-level expect or capture', () => {
    const scenario = parseScenario(
      {
        name: 'Multi',
        workflow: 'Items',
        steps: [
          { trigger, capture: { id: 'response.body.id' } },
          { name: 'Fetch', workflow: 'Other', trigger },
        ],
      },
      'multi.yaml',
    );

    assert.deepEqual(
      scenario.steps.map((step) => [step.name, step.workflow]),
      [
        ['Step 1', 'Items'],
        ['Fetch', 'Other'],
      ],
    );
    assert.deepEqual(scenario.steps[1].expect, {});
  });

  it('rejects mixing steps with a top-level trigger', () => {
    assert.throws(
      () =>
        parseScenario(
          { name: 'Mixed', workflow: 'Items', trigger, steps: [{ trigger }] },
          'mixed.yaml',
        ),
      /either "steps" or a top-level "trigger"/,
    );
  });

  it('requires a workflow for every step', () => {
    assert.throws(
      () =>
        parseScenario(
          { name: 'No workflow', steps: [{ workflow: 'Items', trigger }, { trigger }] },
          'missing.yaml',
        ),
      /Set "workflow"/,
    );
  });

  it('rejects capture paths outside the response', () => {
    assert.throws(
      () =>
        parseScenario(
          { name: 'Bad capture', workflow: 'Items', trigger, capture: { id: 'body.id' } },
          'capture.yaml',
        ),
      /start with "response\."/,
    );
  });
});
