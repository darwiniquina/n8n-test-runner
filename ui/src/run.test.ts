import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StepResult } from '../../src/runner.ts';
import { applyRunEvent, type RunEvent, type RunView } from './run.ts';
import { createEventParser } from './sse.ts';

describe('createEventParser', () => {
  it('parses events split across chunks at any point', () => {
    const events: Array<[string, unknown]> = [];
    const stream =
      'event: run-start\ndata: {"id":"a"}\n\nevent: run-end\ndata: {"passed":1}\n\n';

    // Every split point, including inside "\n\n".
    for (let cut = 0; cut <= stream.length; cut++) {
      events.length = 0;
      const parse = createEventParser((event, data) => events.push([event, data]));
      parse(stream.slice(0, cut));
      parse(stream.slice(cut));

      assert.deepEqual(events, [
        ['run-start', { id: 'a' }],
        ['run-end', { passed: 1 }],
      ]);
    }
  });

  it('holds back an event until its blank line arrives', () => {
    const events: string[] = [];
    const parse = createEventParser((event) => events.push(event));

    parse('event: run-end\ndata: {}\n');
    assert.deepEqual(events, []);
    parse('\n');
    assert.deepEqual(events, ['run-end']);
  });
});

describe('applyRunEvent', () => {
  it('builds a run from its events, step by step', () => {
    const step: StepResult = { name: 'Call', status: 'passed', durationMs: 5, checks: [], captured: {} };
    const events: RunEvent[] = [
      { event: 'run-start', data: { id: 'r1', environment: 'local', files: ['a.yaml', 'b.yaml'] } },
      { event: 'scenario-start', data: { file: 'a.yaml' } },
      { event: 'step-start', data: { file: 'a.yaml', index: 0, name: 'Call' } },
    ];

    let view: RunView = { status: 'running', scenarios: [] };
    for (const event of events) {
      view = applyRunEvent(view, event);
    }

    assert.deepEqual(view.scenarios[0].steps, [{ name: 'Call', status: 'running' }]);
    assert.deepEqual(view.scenarios[1], { file: 'b.yaml', steps: [] });

    view = applyRunEvent(view, { event: 'step-end', data: { file: 'a.yaml', index: 0, result: step } });
    const result = { file: 'a.yaml', name: 'A', passed: true, durationMs: 5, steps: [step] };
    view = applyRunEvent(view, { event: 'scenario-end', data: { result } });
    view = applyRunEvent(view, { event: 'run-end', data: { id: 'r1', passed: 1, failed: 0 } });

    assert.equal(view.status, 'done');
    assert.deepEqual(view.scenarios[0], { file: 'a.yaml', steps: [step], result });
  });
});
