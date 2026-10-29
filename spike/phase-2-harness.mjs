// Phase 2 spike: can a "harness" workflow run any workflow by ID, and can the
// runner then find the target's own execution?
//
// Questions:
//   1. Does the harness execution record the sub-execution ID?
//   2. What does a target receive with an "Accept all data" trigger versus a
//      trigger with defined input fields, when the workflow ID is dynamic?
//   3. What do failed executions look like, in the harness and the target?
//   4. Does Header Auth on the harness webhook reject calls without the secret?
//
// Usage:
//   node spike/phase-2-harness.mjs            set up, run all cases, print findings
//   node spike/phase-2-harness.mjs --cleanup  delete everything the spike created
//
// Env: N8N_API_KEY (required), N8N_BASE_URL (default http://localhost:5678)

import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE_URL = (process.env.N8N_BASE_URL ?? 'http://localhost:5678').replace(
  /\/$/,
  '',
);
const API_KEY = process.env.N8N_API_KEY;
const PREFIX = 'n8nt spike';
const HARNESS_PATH = 'n8nt-spike-harness';
const SECRET_HEADER = 'X-N8nt-Harness-Secret';

async function api(method, path, body) {
  const response = await fetch(`${BASE_URL}/api/v1${path}`, {
    method,
    headers: {
      'X-N8N-API-KEY': API_KEY,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${method} ${path} -> ${response.status}: ${text}`);
    error.status = response.status;
    throw error;
  }

  return text ? JSON.parse(text) : null;
}

async function retryOn(status, action, maxAttempts = 10) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (error.status !== status || attempt >= maxAttempts) {
        throw error;
      }

      await sleep(500);
    }
  }
}

function node(name, type, typeVersion, parameters, extra = {}) {
  return {
    id: randomUUID(),
    name,
    type,
    typeVersion,
    position: [0, 0],
    parameters,
    ...extra,
  };
}

function chain(...names) {
  const connections = {};

  for (let index = 0; index < names.length - 1; index++) {
    connections[names[index]] = {
      main: [[{ node: names[index + 1], type: 'main', index: 0 }]],
    };
  }

  return connections;
}

function setNode(name, fields) {
  return node(name, 'n8n-nodes-base.set', 3.4, {
    assignments: {
      assignments: fields.map(([fieldName, value, type]) => ({
        id: randomUUID(),
        name: fieldName,
        value,
        type,
      })),
    },
    options: {},
  });
}

function triggerNode(parameters) {
  return node(
    'When Executed by Another Workflow',
    'n8n-nodes-base.executeWorkflowTrigger',
    1.1,
    parameters,
  );
}

const RECEIVED_KEYS = [
  'receivedKeys',
  '={{ Object.keys($json).sort().join(",") }}',
  'string',
];

function targetDefinitions() {
  return {
    passthrough: {
      name: `${PREFIX} target (accept all data)`,
      nodes: [
        triggerNode({ inputSource: 'passthrough' }),
        setNode('Double', [
          ['doubled', '={{ $json.value * 2 }}', 'number'],
          RECEIVED_KEYS,
        ]),
      ],
      connections: chain('When Executed by Another Workflow', 'Double'),
      settings: { executionOrder: 'v1' },
    },
    defined: {
      name: `${PREFIX} target (defined inputs)`,
      nodes: [
        triggerNode({
          inputSource: 'workflowInputs',
          workflowInputs: { values: [{ name: 'value', type: 'number' }] },
        }),
        setNode('Echo', [['value', '={{ $json.value }}', 'number'], RECEIVED_KEYS]),
      ],
      connections: chain('When Executed by Another Workflow', 'Echo'),
      settings: { executionOrder: 'v1' },
    },
    failing: {
      name: `${PREFIX} target (fails)`,
      nodes: [
        triggerNode({ inputSource: 'passthrough' }),
        node('Fail On Purpose', 'n8n-nodes-base.stopAndError', 1, {
          errorMessage: 'Spike failure requested',
        }),
      ],
      connections: chain('When Executed by Another Workflow', 'Fail On Purpose'),
      settings: { executionOrder: 'v1' },
    },
  };
}

function harnessDefinition(credential) {
  return {
    name: `${PREFIX} harness`,
    nodes: [
      node(
        'Webhook',
        'n8n-nodes-base.webhook',
        2,
        {
          httpMethod: 'POST',
          path: HARNESS_PATH,
          authentication: 'headerAuth',
          responseMode: 'lastNode',
          responseData: 'allEntries',
          options: {},
        },
        {
          webhookId: randomUUID(),
          credentials: {
            httpHeaderAuth: { id: credential.id, name: credential.name },
          },
        },
      ),
      node('Prepare Input', 'n8n-nodes-base.set', 3.4, {
        mode: 'raw',
        jsonOutput: '={{ JSON.stringify($json.body.input ?? {}) }}',
        options: {},
      }),
      node('Run Target', 'n8n-nodes-base.executeWorkflow', 1.2, {
        source: 'database',
        workflowId: {
          __rl: true,
          mode: 'id',
          value: "={{ $('Webhook').item.json.body.workflowId }}",
        },
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
    connections: chain('Webhook', 'Prepare Input', 'Run Target'),
    settings: { executionOrder: 'v1' },
  };
}

async function listSpikeWorkflows() {
  const { data } = await api('GET', '/workflows?limit=250');
  return data.filter((workflow) => workflow.name.startsWith(PREFIX));
}

async function setup() {
  const existing = await listSpikeWorkflows();
  if (existing.length > 0) {
    throw new Error('Spike workflows already exist. Run --cleanup first.');
  }

  const secret = randomBytes(24).toString('hex');
  const credential = await api('POST', '/credentials', {
    name: `${PREFIX} harness secret`,
    type: 'httpHeaderAuth',
    data: { name: SECRET_HEADER, value: secret },
  });
  console.log(`ok   created credential ${credential.id}`);

  // n8n 2.x only runs published (active) sub-workflows from production runs.
  const targets = {};
  for (const [key, definition] of Object.entries(targetDefinitions())) {
    targets[key] = await api('POST', '/workflows', definition);
    await api('POST', `/workflows/${targets[key].id}/activate`);
    console.log(`ok   created and activated ${definition.name} (${targets[key].id})`);
  }

  const harness = await api('POST', '/workflows', harnessDefinition(credential));
  await api('POST', `/workflows/${harness.id}/activate`);
  console.log(`ok   created and activated harness (${harness.id})`);

  return { secret, targets, harness };
}

async function callHarness(body, headers) {
  const url = `${BASE_URL}/webhook/${HARNESS_PATH}?__testRunId=${body.testRunId}`;

  for (let attempt = 1; attempt <= 10; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await response.text();

    // The webhook registers a moment after activation (Phase 0 finding).
    if (response.status === 404 && attempt < 10) {
      await sleep(500);
      continue;
    }

    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Keep raw text.
    }

    return { status: response.status, body: parsed };
  }
}

async function findHarnessExecution(harnessId, testRunId) {
  for (let attempt = 1; attempt <= 20; attempt++) {
    const { data } = await api(
      'GET',
      `/executions?workflowId=${harnessId}&includeData=true&limit=20`,
    );

    const match = data.find((execution) => {
      const webhook = execution.data?.resultData?.runData?.Webhook;
      const query = webhook?.[0]?.data?.main?.[0]?.[0]?.json?.query;
      return query?.__testRunId === testRunId;
    });

    if (match && !['running', 'new'].includes(match.status)) {
      return match;
    }

    await sleep(500);
  }

  return null;
}

function summarizeExecution(execution) {
  if (!execution) {
    return null;
  }

  const runData = execution.data?.resultData?.runData ?? {};

  return {
    id: execution.id,
    workflowId: execution.workflowId,
    status: execution.status,
    mode: execution.mode,
    error: execution.data?.resultData?.error?.message,
    lastNodeExecuted: execution.data?.resultData?.lastNodeExecuted,
    nodes: Object.fromEntries(
      Object.entries(runData).map(([name, runs]) => [
        name,
        {
          // Headers carry the harness secret, so keep them out of the output.
          output: runs[0]?.data?.main?.[0]?.map(({ json }) => {
            const { headers, ...rest } = json ?? {};
            return headers ? { ...rest, headers: '(redacted)' } : rest;
          }),
          error: runs[0]?.error?.message,
          metadata: runs[0]?.metadata,
        },
      ]),
    ),
  };
}

async function runCase(label, state, target, input) {
  const testRunId = randomUUID();
  const response = await callHarness(
    { workflowId: target.id, input, testRunId },
    { [SECRET_HEADER]: state.secret },
  );

  const harnessExecution = await findHarnessExecution(state.harness.id, testRunId);
  const runTarget = harnessExecution?.data?.resultData?.runData?.['Run Target'];
  const subExecutionId = runTarget?.[0]?.metadata?.subExecution?.executionId;

  const subExecution = subExecutionId
    ? await api('GET', `/executions/${subExecutionId}?includeData=true`)
    : null;

  return {
    case: label,
    input,
    response,
    harnessExecution: summarizeExecution(harnessExecution),
    subExecutionId: subExecutionId ?? null,
    subExecution: summarizeExecution(subExecution),
  };
}

async function runSpike() {
  if (!API_KEY) {
    throw new Error('N8N_API_KEY is not set.');
  }

  const state = await setup();

  const noAuth = await callHarness({ testRunId: randomUUID() }, {});
  const wrongAuth = await callHarness(
    { testRunId: randomUUID() },
    { [SECRET_HEADER]: 'wrong' },
  );

  const findings = {
    auth: {
      withoutHeader: noAuth.status,
      withWrongSecret: wrongAuth.status,
    },
    cases: [
      await runCase('accept all data', state, state.targets.passthrough, {
        value: 21,
        extra: 'kept?',
      }),
      await runCase('defined inputs', state, state.targets.defined, {
        value: 21,
        extra: 'kept?',
      }),
      await runCase('target fails', state, state.targets.failing, { value: 1 }),
    ],
  };

  console.log(JSON.stringify(findings, null, 2));
}

async function cleanup() {
  for (const workflow of await listSpikeWorkflows()) {
    if (workflow.active) {
      await api('POST', `/workflows/${workflow.id}/deactivate`);
    }

    // Unpublishing finishes in the background (Phase 0 finding).
    await retryOn(409, () => api('DELETE', `/workflows/${workflow.id}`));
    console.log(`ok   deleted workflow ${workflow.name}`);
  }

  const { data } = await api('GET', '/credentials?limit=250');
  for (const credential of data.filter((item) => item.name.startsWith(PREFIX))) {
    await api('DELETE', `/credentials/${credential.id}`);
    console.log(`ok   deleted credential ${credential.name}`);
  }
}

const command = process.argv.includes('--cleanup') ? cleanup : runSpike;

command().catch((error) => {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
});
