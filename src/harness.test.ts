import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { saveEnvValue, targetExecutionId } from './harness.ts';
import type { Execution } from './n8n-client.ts';

function harnessRun(runTarget: object): Execution {
  return {
    id: '888',
    status: 'success',
    mode: 'webhook',
    startedAt: '2026-10-29T00:00:00.000Z',
    stoppedAt: '2026-10-29T00:00:01.000Z',
    data: { resultData: { runData: { 'Run Target': [runTarget] } } },
  };
}

// Run shapes copied from the spike against n8n 2.44.5.
describe('targetExecutionId', () => {
  it('reads the sub-execution from metadata when the target succeeded', () => {
    const run = harnessRun({
      data: { main: [[{ json: { doubled: 42 } }]] },
      metadata: {
        subExecution: { executionId: '885', workflowId: 'e57JFzWlz64Q7r3I' },
        subExecutionsCount: 1,
      },
    });

    assert.equal(targetExecutionId(run), '885');
  });

  it('reads the sub-execution from the error when the target failed', () => {
    const run = harnessRun({
      error: {
        message: 'Spike failure requested',
        executionId: '889',
        workflowId: '9lKDCoFNPVudwHEw',
      },
    });

    assert.equal(targetExecutionId(run), '889');
  });

  it('returns undefined when the target never started', () => {
    const run: Execution = { ...harnessRun({}), data: { resultData: { runData: {} } } };

    assert.equal(targetExecutionId(run), undefined);
  });
});

describe('saveEnvValue', () => {
  it('replaces an existing value and keeps other lines', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'n8nt-')), '.env');
    await writeFile(file, 'N8N_API_KEY=abc\nN8N_HARNESS_SECRET=old\nOTHER=1');

    await saveEnvValue(file, 'N8N_HARNESS_SECRET', 'new');

    assert.equal(
      await readFile(file, 'utf8'),
      'N8N_API_KEY=abc\nN8N_HARNESS_SECRET=new\nOTHER=1',
    );
  });

  it('appends to a file without a trailing newline, or creates the file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'n8nt-'));
    const existing = join(directory, 'existing.env');
    const missing = join(directory, 'missing.env');
    await writeFile(existing, 'N8N_API_KEY=abc');

    await saveEnvValue(existing, 'N8N_HARNESS_SECRET', 'value');
    await saveEnvValue(missing, 'N8N_HARNESS_SECRET', 'value');

    assert.equal(
      await readFile(existing, 'utf8'),
      'N8N_API_KEY=abc\nN8N_HARNESS_SECRET=value\n',
    );
    assert.equal(await readFile(missing, 'utf8'), 'N8N_HARNESS_SECRET=value\n');
  });
});
