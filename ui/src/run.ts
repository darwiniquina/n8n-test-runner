// What the run panel shows: a live run built from server events, or a saved
// run from history.

import type { RunRecord } from '../../src/history.ts';
import type { ScenarioResult, StepResult } from '../../src/runner.ts';

export type StepView = StepResult | { name: string; status: 'running' };

export type ScenarioView = {
  file: string;
  steps: StepView[];
  // Set once the scenario has finished.
  result?: ScenarioResult;
};

export type RunView = {
  id?: string;
  environment?: string;
  status: 'running' | 'done' | 'error';
  error?: string;
  scenarios: ScenarioView[];
};

// The events POST /api/runs sends (see src/server.ts).
export type RunEvent =
  | { event: 'run-start'; data: { id: string; environment: string; files: string[] } }
  | { event: 'scenario-start'; data: { file: string } }
  | { event: 'step-start'; data: { file: string; index: number; name: string } }
  | { event: 'step-end'; data: { file: string; index: number; result: StepResult } }
  | { event: 'scenario-end'; data: { result: ScenarioResult } }
  | { event: 'run-end'; data: { id: string; passed: number; failed: number } }
  | { event: 'run-error'; data: { message: string } };

function updateScenario(
  view: RunView,
  file: string,
  change: (scenario: ScenarioView) => ScenarioView,
): RunView {
  return {
    ...view,
    scenarios: view.scenarios.map((scenario) =>
      scenario.file === file ? change(scenario) : scenario,
    ),
  };
}

function withStep(steps: StepView[], index: number, step: StepView) {
  const next = [...steps];
  next[index] = step;
  return next;
}

export function applyRunEvent(view: RunView, runEvent: RunEvent): RunView {
  switch (runEvent.event) {
    case 'run-start': {
      const { id, environment, files } = runEvent.data;
      return { ...view, id, environment, scenarios: files.map((file) => ({ file, steps: [] })) };
    }
    case 'step-start': {
      const { file, index, name } = runEvent.data;
      return updateScenario(view, file, (scenario) => ({
        ...scenario,
        steps: withStep(scenario.steps, index, { name, status: 'running' }),
      }));
    }
    case 'step-end': {
      const { file, index, result } = runEvent.data;
      return updateScenario(view, file, (scenario) => ({
        ...scenario,
        steps: withStep(scenario.steps, index, result),
      }));
    }
    case 'scenario-end': {
      const { result } = runEvent.data;
      return updateScenario(view, result.file, (scenario) => ({
        ...scenario,
        steps: result.steps,
        result,
      }));
    }
    case 'run-end':
      return { ...view, status: 'done' };
    case 'run-error':
      return { ...view, status: 'error', error: runEvent.data.message };
    default:
      // scenario-start: a scenario with no steps yet already shows as waiting.
      return view;
  }
}

export function fromRecord(record: RunRecord): RunView {
  return {
    id: record.id,
    environment: record.environment,
    status: 'done',
    scenarios: record.results.map((result) => ({
      file: result.file,
      steps: result.steps,
      result,
    })),
  };
}
