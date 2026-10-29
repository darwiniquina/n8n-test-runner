import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { VARIABLE_NAME, type Variables } from './variables.ts';

// Maps a path (like "user.email" or "[0].id") to an expected value or matcher.
const expectationsSchema = z.record(z.string(), z.unknown());

const variableNameSchema = z
  .string()
  .regex(VARIABLE_NAME, 'Variable names use letters, digits and _ only.');

const variablesSchema = z.record(variableNameSchema, z.unknown());

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

// Runs the scenario's workflow through the harness, so it needs no webhook.
// The input becomes the single item the target's trigger receives.
const harnessTriggerSchema = z.strictObject({
  input: z.record(z.string(), z.unknown()).default({}),
});

const triggerSchema = z.union([
  z.strictObject({ webhook: webhookTriggerSchema }),
  z.strictObject({ harness: harnessTriggerSchema }),
]);

const nodeExpectationSchema = z.strictObject({
  ran: z.boolean().default(true),
  output: expectationsSchema.optional(),
});

const expectSchema = z
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
  });

// "response.body.id" reads the webhook response. The object form reads a
// node's output, since node names can contain dots and spaces.
const captureSchema = z.union([
  z.string().regex(/^response\./, 'Capture paths start with "response.".'),
  z.strictObject({
    node: z.string().min(1),
    path: z.string().default(''),
  }),
]);

const capturesSchema = z.record(variableNameSchema, captureSchema);

// Defaults live only on the step fields. In zod 4, `.default()` still fills in
// a value under `.optional()`, which would break the single/multi-step check.
const stepSchema = z.strictObject({
  name: z.string().min(1).optional(),
  workflow: z.string().min(1).optional(),
  trigger: triggerSchema,
  expect: expectSchema.default({}),
  capture: capturesSchema.default({}),
});

const scenarioFileSchema = z
  .strictObject({
    name: z.string().min(1),
    workflow: z.string().min(1).optional(),
    variables: variablesSchema.default({}),
    steps: z.array(stepSchema).min(1).optional(),
    // Single-step form: trigger, expect and capture at the top level.
    trigger: triggerSchema.optional(),
    expect: expectSchema.optional(),
    capture: capturesSchema.optional(),
  })
  .superRefine((scenario, context) => {
    const isSingleStep = scenario.trigger !== undefined;
    const isMultiStep = scenario.steps !== undefined;

    if (isSingleStep === isMultiStep) {
      context.addIssue({
        code: 'custom',
        message: 'Use either "steps" or a top-level "trigger", not both.',
      });
    }

    if (isMultiStep && (scenario.expect || scenario.capture)) {
      context.addIssue({
        code: 'custom',
        message: 'With "steps", put "expect" and "capture" inside each step.',
      });
    }

    const stepWorkflows = isMultiStep
      ? scenario.steps!.map((step) => step.workflow)
      : [undefined];

    if (!scenario.workflow && stepWorkflows.some((workflow) => !workflow)) {
      context.addIssue({
        code: 'custom',
        message: 'Set "workflow" on the scenario or on every step.',
      });
    }
  });

type ScenarioFile = z.infer<typeof scenarioFileSchema>;

export type WebhookTrigger = z.infer<typeof webhookTriggerSchema>;
export type Trigger = z.infer<typeof triggerSchema>;
export type Expectations = z.infer<typeof expectSchema>;
export type Capture = z.infer<typeof captureSchema>;

export type Step = {
  name: string;
  workflow: string;
  trigger: Trigger;
  expect: Expectations;
  capture: Record<string, Capture>;
};

export type Scenario = {
  file: string;
  name: string;
  variables: Variables;
  steps: Step[];
};

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

function toSteps(scenario: ScenarioFile): Step[] {
  if (!scenario.steps) {
    return [
      {
        name: scenario.name,
        workflow: scenario.workflow!,
        trigger: scenario.trigger!,
        expect: scenario.expect ?? {},
        capture: scenario.capture ?? {},
      },
    ];
  }

  return scenario.steps.map((step, index) => ({
    ...step,
    name: step.name ?? `Step ${index + 1}`,
    workflow: step.workflow ?? scenario.workflow!,
  }));
}

// Fixture paths are relative to the scenario file, not the working directory.
async function loadBodyFile(scenarioFile: string, trigger: WebhookTrigger) {
  if (!trigger.bodyFile) {
    return;
  }

  const fixturePath = resolve(dirname(scenarioFile), trigger.bodyFile);
  const fixture = await readFile(fixturePath, 'utf8');
  trigger.body = extname(fixturePath) === '.json' ? JSON.parse(fixture) : fixture;
}

// Validates parsed YAML and turns both scenario forms into a list of steps.
// Does not read bodyFile fixtures; loadScenario does that.
export function parseScenario(data: unknown, file: string): Scenario {
  const result = scenarioFileSchema.safeParse(data);

  if (!result.success) {
    throw new Error(`Invalid scenario:\n${z.prettifyError(result.error)}`);
  }

  return {
    file,
    name: result.data.name,
    variables: result.data.variables,
    steps: toSteps(result.data),
  };
}

export async function loadScenario(file: string): Promise<Scenario> {
  const text = await readFile(file, 'utf8');
  const scenario = parseScenario(parse(text), file);

  for (const step of scenario.steps) {
    if ('webhook' in step.trigger) {
      await loadBodyFile(file, step.trigger.webhook);
    }
  }

  return scenario;
}
