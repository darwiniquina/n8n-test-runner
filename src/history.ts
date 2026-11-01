import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScenarioResult } from './runner.ts';

// Older runs are deleted past this count, so .runs/ cannot grow forever.
const MAX_RUNS = 100;

// IDs sort by time as plain strings: 2026-10-29T15-05-33-123Z-a1b2c3
const RUN_ID = /^\d{4}-\d{2}-\d{2}T[\dZ-]+-[0-9a-f]{6}$/;

export type RunRecord = {
  id: string;
  startedAt: string;
  finishedAt: string;
  environment: string;
  paths: string[];
  results: ScenarioResult[];
};

export type RunSummary = Omit<RunRecord, 'results'> & {
  passed: number;
  failed: number;
};

export function createRunId(date = new Date()) {
  const timestamp = date.toISOString().replace(/[:.]/g, '-');
  return `${timestamp}-${randomBytes(3).toString('hex')}`;
}

function summarize(record: RunRecord): RunSummary {
  const { results, ...rest } = record;
  const passed = results.filter((result) => result.passed).length;

  return { ...rest, passed, failed: results.length - passed };
}

export function createHistory(directory: string) {
  async function runIds() {
    try {
      const files = await readdir(directory);
      return files
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.slice(0, -'.json'.length))
        .filter((id) => RUN_ID.test(id))
        .sort()
        .reverse();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }

      throw error;
    }
  }

  async function get(id: string): Promise<RunRecord | undefined> {
    // The ID comes from a URL, so never let it name a file outside .runs/.
    if (!RUN_ID.test(id)) {
      return undefined;
    }

    try {
      return JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }

      throw error;
    }
  }

  async function save(record: RunRecord) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${record.id}.json`), JSON.stringify(record));

    const stale = (await runIds()).slice(MAX_RUNS);
    for (const id of stale) {
      await rm(join(directory, `${id}.json`), { force: true });
    }
  }

  async function list(): Promise<RunSummary[]> {
    const summaries: RunSummary[] = [];

    for (const id of await runIds()) {
      const record = await get(id);
      if (record) {
        summaries.push(summarize(record));
      }
    }

    return summaries;
  }

  return { save, get, list };
}

export type History = ReturnType<typeof createHistory>;
