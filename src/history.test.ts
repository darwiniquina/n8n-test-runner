import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createHistory, createRunId, type RunRecord } from './history.ts';

function record(id: string, passed: boolean[]): RunRecord {
  return {
    id,
    startedAt: '2026-10-29T15:00:00.000Z',
    finishedAt: '2026-10-29T15:00:01.000Z',
    environment: 'local',
    paths: ['onboarding'],
    results: passed.map((value, index) => ({
      file: `s${index}.yaml`,
      name: `Scenario ${index}`,
      passed: value,
      durationMs: 1,
      steps: [],
    })),
  };
}

describe('history', () => {
  it('saves runs and lists them newest first with pass and fail counts', async () => {
    const history = createHistory(await mkdtemp(join(tmpdir(), 'n8nt-runs-')));
    const older = createRunId(new Date('2026-10-29T10:00:00Z'));
    const newer = createRunId(new Date('2026-10-29T11:00:00Z'));

    await history.save(record(older, [true]));
    await history.save(record(newer, [true, false]));

    const summaries = await history.list();
    assert.deepEqual(
      summaries.map((summary) => [summary.id, summary.passed, summary.failed]),
      [
        [newer, 1, 1],
        [older, 1, 0],
      ],
    );
    assert.equal(summaries[0].environment, 'local');
    assert.equal('results' in summaries[0], false);
    assert.equal((await history.get(newer))?.results.length, 2);
  });

  it('returns nothing for unknown or unsafe IDs', async () => {
    const history = createHistory(await mkdtemp(join(tmpdir(), 'n8nt-runs-')));

    assert.equal(await history.get(createRunId()), undefined);
    assert.equal(await history.get('../../etc/passwd'), undefined);
  });

  it('lists nothing before the first run', async () => {
    const directory = join(await mkdtemp(join(tmpdir(), 'n8nt-runs-')), 'not-created');
    assert.deepEqual(await createHistory(directory).list(), []);
  });

  it('keeps only the newest 100 runs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'n8nt-runs-'));
    const history = createHistory(directory);
    const start = Date.parse('2026-10-29T00:00:00Z');

    for (let index = 0; index < 101; index++) {
      await history.save(record(createRunId(new Date(start + index * 1000)), [true]));
    }

    const files = await readdir(directory);
    assert.equal(files.length, 100);
    assert.equal(files.some((file) => file.startsWith('2026-10-29T00-00-00-000Z')), false);
  });
});
