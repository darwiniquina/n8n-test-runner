import { styleText } from 'node:util';
import type { ScenarioResult } from './runner.ts';

function format(value: unknown) {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

export function printResult(result: ScenarioResult) {
  const badge = result.passed
    ? styleText(['bold', 'green'], 'PASS')
    : styleText(['bold', 'red'], 'FAIL');

  const details = [result.file, `${result.durationMs}ms`];
  if (result.executionId) {
    details.push(`execution ${result.executionId}`);
  }

  console.log(`${badge}  ${result.name}  ${styleText('dim', `(${details.join(', ')})`)}`);

  if (result.error) {
    console.log(styleText('red', `      ${result.error.replace(/\n/g, '\n      ')}`));
    return;
  }

  for (const check of result.checks) {
    if (check.passed) {
      console.log(styleText('dim', `      ✓ ${check.label}`));
      continue;
    }

    let line = `      ✗ ${check.label}`;
    if ('expected' in check) {
      line += `: expected ${format(check.expected)}, got ${format(check.actual)}`;
    } else if ('actual' in check) {
      line += `: got ${format(check.actual)}`;
    }

    console.log(styleText('red', line));
  }

  if (result.executionError && !result.passed) {
    console.log(styleText('yellow', `      n8n error: ${result.executionError}`));
  }
}

export function printSummary(results: ScenarioResult[]) {
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  const summary = `${passed} passed, ${failed} failed (${results.length} scenarios)`;

  console.log(`\n${failed > 0 ? styleText('red', summary) : styleText('green', summary)}`);
}
