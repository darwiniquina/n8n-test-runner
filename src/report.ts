import { styleText } from 'node:util';
import type { Check } from './assertions.ts';
import type { ScenarioResult, StepResult } from './runner.ts';

const STEP_ICONS = {
  passed: styleText('green', '✓'),
  failed: styleText('red', '✗'),
  skipped: styleText('dim', '-'),
};

function format(value: unknown) {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

function printLines(text: string, indent: string, color: 'red' | 'yellow') {
  console.log(styleText(color, `${indent}${text.replace(/\n/g, `\n${indent}`)}`));
}

function printCheck(check: Check, indent: string) {
  if (check.passed) {
    console.log(styleText('dim', `${indent}✓ ${check.label}`));
    return;
  }

  let line = `${indent}✗ ${check.label}`;
  if ('expected' in check) {
    line += `: expected ${format(check.expected)}, got ${format(check.actual)}`;
  } else if ('actual' in check) {
    line += `: got ${format(check.actual)}`;
  }

  console.log(styleText('red', line));
}

function printStepBody(step: StepResult, indent: string) {
  for (const check of step.checks) {
    printCheck(check, indent);
  }

  for (const [name, value] of Object.entries(step.captured)) {
    console.log(styleText('dim', `${indent}→ ${name} = ${format(value)}`));
  }

  if (step.error) {
    printLines(step.error, indent, 'red');
  }

  if (step.executionError && step.status === 'failed') {
    printLines(`n8n error: ${step.executionError}`, indent, 'yellow');
  }
}

export function printResult(result: ScenarioResult) {
  const badge = result.passed
    ? styleText(['bold', 'green'], 'PASS')
    : styleText(['bold', 'red'], 'FAIL');

  // A single-step scenario prints like before: no step headings.
  const singleStep = result.steps.length === 1 ? result.steps[0] : undefined;

  const details = [result.file, `${result.durationMs}ms`];
  if (singleStep?.executionId) {
    details.push(`execution ${singleStep.executionId}`);
  }

  console.log(`${badge}  ${result.name}  ${styleText('dim', `(${details.join(', ')})`)}`);

  if (result.error) {
    printLines(result.error, '      ', 'red');
    return;
  }

  if (singleStep) {
    printStepBody(singleStep, '      ');
    return;
  }

  for (const step of result.steps) {
    const stepDetails = [`${step.durationMs}ms`];
    if (step.executionId) {
      stepDetails.push(`execution ${step.executionId}`);
    }

    const suffix =
      step.status === 'skipped'
        ? styleText('dim', '(skipped)')
        : styleText('dim', `(${stepDetails.join(', ')})`);

    console.log(`      ${STEP_ICONS[step.status]} ${step.name}  ${suffix}`);

    if (step.status !== 'skipped') {
      printStepBody(step, '          ');
    }
  }
}

export function printSummary(results: ScenarioResult[]) {
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  const summary = `${passed} passed, ${failed} failed (${results.length} scenarios)`;

  console.log(`\n${failed > 0 ? styleText('red', summary) : styleText('green', summary)}`);
}
