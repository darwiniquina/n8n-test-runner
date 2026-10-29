import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

// Maps a path (like "user.email" or "[0].id") to an expected value or matcher.
const expectationsSchema = z.record(z.string(), z.unknown());

const webhookTriggerSchema = z
  .strictObject({
    method: z
      .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
      .default('POST'),
    path: z.string().min(1),
    headers: z.record(z.string(), z.string()).default({}),
    query: z.record(z.string(), z.string()).default({}),
    body: z.unknown().optional(),
    bodyFile: z.string().optional(),
  })
  .refine(
    (trigger) => trigger.body === undefined || trigger.bodyFile === undefined,
    'Use either body or bodyFile, not both.',
  );

const nodeExpectationSchema = z.strictObject({
  ran: z.boolean().default(true),
  output: expectationsSchema.optional(),
});

const scenarioSchema = z.strictObject({
  name: z.string().min(1),
  workflow: z.string().min(1),
  trigger: z.strictObject({
    webhook: webhookTriggerSchema,
  }),
  expect: z
    .strictObject({
      response: z
        .strictObject({
          status: z.number().int().optional(),
          maxDurationMs: z.number().positive().optional(),
          body: expectationsSchema.optional(),
        })
        .optional(),
      execution: z
        .strictObject({
          status: z
            .enum(['success', 'error', 'canceled', 'crashed', 'waiting'])
            .optional(),
          nodes: z.record(z.string(), nodeExpectationSchema).optional(),
        })
        .optional(),
    })
    .default({}),
});

export type Scenario = z.infer<typeof scenarioSchema> & { file: string };
export type WebhookTrigger = Scenario['trigger']['webhook'];

const SCENARIO_EXTENSIONS = new Set(['.yaml', '.yml']);
const CONFIG_FILE_PATTERN = /^n8nt\.config\.ya?ml$/;

export async function findScenarioFiles(paths: string[]) {
  const files: string[] = [];

  for (const path of paths) {
    const info = await stat(path);

    if (info.isFile()) {
      files.push(path);
      continue;
    }

    const entries = await readdir(path, { recursive: true });
    const scenarios = entries
      .filter((entry) => SCENARIO_EXTENSIONS.has(extname(entry)))
      .filter((entry) => !CONFIG_FILE_PATTERN.test(entry.split(/[\\/]/).pop()!))
      .map((entry) => join(path, entry));

    files.push(...scenarios.sort());
  }

  return files;
}

export async function loadScenario(file: string): Promise<Scenario> {
  const text = await readFile(file, 'utf8');
  const result = scenarioSchema.safeParse(parse(text));

  if (!result.success) {
    throw new Error(`Invalid scenario:\n${z.prettifyError(result.error)}`);
  }

  const scenario = { ...result.data, file };
  const { bodyFile } = scenario.trigger.webhook;

  // Fixture paths are relative to the scenario file, not the working directory.
  if (bodyFile) {
    const fixturePath = resolve(dirname(file), bodyFile);
    const fixture = await readFile(fixturePath, 'utf8');
    scenario.trigger.webhook.body =
      extname(fixturePath) === '.json' ? JSON.parse(fixture) : fixture;
  }

  return scenario;
}
