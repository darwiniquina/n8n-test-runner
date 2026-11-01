import type { ExecutionSummary } from '../../src/runner.ts';
import type { RunSummary } from './api.ts';
import type { RunView, ScenarioView, StepView } from './run.ts';

type Status = 'passed' | 'failed' | 'skipped' | 'running' | 'waiting';

const ICONS: Record<Status, string> = {
  passed: '✔',
  failed: '✖',
  skipped: '–',
  running: '…',
  waiting: '○',
};

type Props = {
  view?: RunView;
  history: RunSummary[];
  onOpenRun: (id: string) => void;
};

export function RunPanel({ view, history, onOpenRun }: Props) {
  const inHistory = history.some((run) => run.id === view?.id);

  return (
    <section className="runs" aria-label="Runs">
      <div className="runs-header">
        <strong>Runs</strong>
        {history.length > 0 && (
          <select
            aria-label="Past runs"
            value={inHistory ? view!.id : ''}
            onChange={(event) => onOpenRun(event.target.value)}
          >
            <option value="" disabled>
              Past runs
            </option>
            {history.map((run) => (
              <option key={run.id} value={run.id}>
                {new Date(run.startedAt).toLocaleString()} · {run.environment} · {run.passed} ✔{' '}
                {run.failed} ✖
              </option>
            ))}
          </select>
        )}
      </div>
      {view ? (
        <RunDetails view={view} />
      ) : (
        <p className="muted">No run yet. Run a file or the whole folder.</p>
      )}
    </section>
  );
}

function StatusIcon({ status }: { status: Status }) {
  return <span className={`status status-${status}`}>{ICONS[status]}</span>;
}

function RunDetails({ view }: { view: RunView }) {
  const finished = view.scenarios.filter((scenario) => scenario.result);
  const passed = finished.filter((scenario) => scenario.result!.passed).length;

  return (
    <div className="run">
      <p className="muted">
        {view.status === 'running' ? 'Running…' : `${passed} passed, ${finished.length - passed} failed`}
        {view.environment && ` · ${view.environment}`}
      </p>
      {view.error && <p className="error">{view.error}</p>}
      {view.scenarios.map((scenario) => (
        <Scenario key={scenario.file} scenario={scenario} />
      ))}
    </div>
  );
}

function Scenario({ scenario }: { scenario: ScenarioView }) {
  const { result } = scenario;
  const status: Status = result
    ? result.passed
      ? 'passed'
      : 'failed'
    : scenario.steps.length > 0
      ? 'running'
      : 'waiting';

  return (
    <details className="scenario" open={status !== 'passed'}>
      <summary>
        <StatusIcon status={status} /> {result?.name ?? scenario.file}{' '}
        {result && <span className="muted">{result.durationMs} ms</span>}
      </summary>
      <div className="muted file">{scenario.file}</div>
      {result?.error && <p className="error">{result.error}</p>}
      <ul className="steps">
        {scenario.steps.map((step, index) => (
          <Step key={index} step={step} />
        ))}
      </ul>
    </details>
  );
}

function Step({ step }: { step: StepView }) {
  if (step.status === 'running' || step.status === 'skipped') {
    return (
      <li className={step.status === 'skipped' ? 'muted' : undefined}>
        <StatusIcon status={step.status} /> {step.name}
        {step.status === 'skipped' && ' (skipped after a failure)'}
      </li>
    );
  }

  const failedChecks = step.checks.filter((check) => !check.passed);
  const passedCount = step.checks.length - failedChecks.length;

  return (
    <li>
      <details open={step.status === 'failed'}>
        <summary>
          <StatusIcon status={step.status} /> {step.name}{' '}
          <span className="muted">{step.durationMs} ms</span>
        </summary>
        {step.error && <p className="error">{step.error}</p>}
        {failedChecks.map((check, index) => (
          <div key={index} className="check">
            <div className="error">✖ {check.label}</div>
            {'expected' in check && (
              <div>
                expected <code>{JSON.stringify(check.expected)}</code>, got{' '}
                <code>{JSON.stringify(check.actual) ?? 'nothing'}</code>
              </div>
            )}
          </div>
        ))}
        {passedCount > 0 && (
          <p className="muted">
            {passedCount} {passedCount === 1 ? 'check' : 'checks'} passed.
          </p>
        )}
        {Object.keys(step.captured).length > 0 && (
          <p>
            Captured <code>{JSON.stringify(step.captured)}</code>
          </p>
        )}
        {step.execution ? (
          <Nodes execution={step.execution} />
        ) : (
          // A lookup a check needed would have failed the step with an error.
          !step.error && (
            <p className="muted">
              No node output: n8n did not save this execution, or it could not be found. Check
              the workflow's "Save successful production executions" setting.
            </p>
          )
        )}
      </details>
    </li>
  );
}

function Nodes({ execution }: { execution: ExecutionSummary }) {
  return (
    <div className="nodes">
      <div className="muted">
        Execution {execution.id} · {execution.status}
      </div>
      {execution.nodes.map((node) => (
        <details key={node.name}>
          <summary>
            <StatusIcon status={node.status === 'error' ? 'failed' : 'passed'} /> {node.name}{' '}
            <span className="muted">
              {node.itemCount} {node.itemCount === 1 ? 'item' : 'items'}
            </span>
          </summary>
          {node.error && <p className="error">{node.error}</p>}
          <pre>{JSON.stringify(node.items, null, 2)}</pre>
          {node.itemCount > node.items.length && (
            <p className="muted">
              Showing the first {node.items.length} of {node.itemCount} items.
            </p>
          )}
        </details>
      ))}
    </div>
  );
}
