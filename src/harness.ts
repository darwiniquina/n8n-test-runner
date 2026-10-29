// The harness is a workflow n8nt installs in n8n so it can run any published
// workflow by ID, not only ones with a webhook trigger:
//
//   Webhook (Header Auth) -> Prepare Input -> Run Target (Execute Workflow)
//
// See docs/phase-2-harness-findings.md for how n8n behaves here.

import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { Environment } from './config.ts';
import {
  firstNodeRun,
  type Credential,
  type Execution,
  type N8nClient,
} from './n8n-client.ts';

export const HARNESS_WORKFLOW_NAME = 'n8nt harness';
export const HARNESS_CREDENTIAL_NAME = 'n8nt harness secret';
const HARNESS_PATH = 'n8nt-harness';
const SECRET_HEADER = 'X-N8nt-Harness-Secret';
const RUN_TARGET_NODE = 'Run Target';

function harnessWorkflowDefinition(credential: Credential) {
  const node = (
    name: string,
    type: string,
    typeVersion: number,
    position: [number, number],
    parameters: object,
  ) => ({ id: randomUUID(), name, type, typeVersion, position, parameters });

  return {
    name: HARNESS_WORKFLOW_NAME,
    nodes: [
      {
        ...node('Webhook', 'n8n-nodes-base.webhook', 2, [0, 0], {
          httpMethod: 'POST',
          path: HARNESS_PATH,
          authentication: 'headerAuth',
          responseMode: 'lastNode',
          responseData: 'allEntries',
          options: {},
        }),
        webhookId: randomUUID(),
        credentials: {
          httpHeaderAuth: { id: credential.id, name: credential.name },
        },
      },
      node('Prepare Input', 'n8n-nodes-base.set', 3.4, [220, 0], {
        mode: 'raw',
        jsonOutput: '={{ JSON.stringify($json.body.input ?? {}) }}',
        options: {},
      }),
      node('Run Target', 'n8n-nodes-base.executeWorkflow', 1.2, [440, 0], {
        source: 'database',
        workflowId: {
          __rl: true,
          mode: 'id',
          value: "={{ $('Webhook').item.json.body.workflowId }}",
        },
        // An empty mapping passes the input through. Targets with defined
        // input fields keep the matching fields and drop the rest.
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: {},
          matchingColumns: [],
          schema: [],
          attemptToConvertTypes: false,
          convertFieldsToString: true,
        },
        options: { waitForSubWorkflow: true },
      }),
    ],
    connections: {
      Webhook: {
        main: [[{ node: 'Prepare Input', type: 'main', index: 0 }]],
      },
      'Prepare Input': {
        main: [[{ node: 'Run Target', type: 'main', index: 0 }]],
      },
    },
    settings: { executionOrder: 'v1' },
  };
}

// The target's own execution ID: in metadata when it succeeded, in the error
// when it failed.
export function targetExecutionId(harnessExecution: Execution) {
  const run = firstNodeRun(harnessExecution, RUN_TARGET_NODE);
  return run?.metadata?.subExecution?.executionId ?? run?.error?.executionId;
}

export async function saveEnvValue(file: string, name: string, value: string) {
  let text = '';

  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, 'm');

  if (pattern.test(text)) {
    text = text.replace(pattern, line);
  } else {
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    text = `${text}${separator}${line}\n`;
  }

  await writeFile(file, text);
}

export async function installHarness(
  client: N8nClient,
  environment: Environment,
  envFile = '.env',
) {
  const existingWorkflow = await client.findWorkflowByName(HARNESS_WORKFLOW_NAME);
  const existingCredentials = await client.findCredentialsByName(
    HARNESS_CREDENTIAL_NAME,
  );

  if (existingWorkflow || existingCredentials.length > 0) {
    throw new Error(
      'The harness is already installed (or partly installed). ' +
        'Run "n8nt harness uninstall" first.',
    );
  }

  const secret = randomBytes(32).toString('hex');
  const credential = await client.createCredential({
    name: HARNESS_CREDENTIAL_NAME,
    type: 'httpHeaderAuth',
    data: { name: SECRET_HEADER, value: secret },
  });

  const workflow = await client.createWorkflow(
    harnessWorkflowDefinition(credential),
  );
  await client.activateWorkflow(workflow.id);
  await saveEnvValue(envFile, environment.harnessSecretEnv, secret);

  return { workflowId: workflow.id };
}

export async function uninstallHarness(client: N8nClient) {
  const workflow = await client.findWorkflowByName(HARNESS_WORKFLOW_NAME);
  if (workflow) {
    await client.deleteWorkflow(workflow);
  }

  const credentials = await client.findCredentialsByName(HARNESS_CREDENTIAL_NAME);
  for (const credential of credentials) {
    await client.deleteCredential(credential.id);
  }

  return {
    deletedWorkflow: Boolean(workflow),
    deletedCredentials: credentials.length,
  };
}

export async function harnessStatus(client: N8nClient) {
  const workflow = await client.findWorkflowByName(HARNESS_WORKFLOW_NAME);

  if (!workflow) {
    return 'not installed';
  }

  return workflow.active ? 'active' : 'installed but not active';
}

export async function triggerThroughHarness(
  client: N8nClient,
  targetWorkflowId: string,
  input: unknown,
  testRunId: string,
) {
  return client.triggerHarness({
    path: HARNESS_PATH,
    secretHeader: SECRET_HEADER,
    workflowId: targetWorkflowId,
    input,
    testRunId,
  });
}

export async function findTargetExecution(client: N8nClient, testRunId: string) {
  const harness = await client.findWorkflowByName(HARNESS_WORKFLOW_NAME);
  if (!harness) {
    throw new Error('The harness is not installed. Run "n8nt harness install".');
  }

  const harnessExecution = await client.findExecution(harness.id, testRunId);
  const executionId = targetExecutionId(harnessExecution);

  if (!executionId) {
    const reason = harnessExecution.data?.resultData?.error?.message ?? 'unknown';
    throw new Error(`The harness did not start the target workflow: ${reason}`);
  }

  return client.getExecution(executionId);
}
