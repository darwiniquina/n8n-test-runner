// Phase 0 spike for the n8n test runner.
//
// Proves three things against a real n8n instance before we design anything:
//   1. We can reach n8n and the public API accepts our key.
//   2. We can trigger a workflow through its production webhook.
//   3. We can find that exact execution afterwards and read each node's output.
//
// Usage:
//   node spike/phase-0.mjs            run the spike (creates a tiny test workflow once)
//   node spike/phase-0.mjs --cleanup  delete the test workflow
//
// Env: N8N_API_KEY (required), N8N_BASE_URL (default http://localhost:5678)

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE_URL = (process.env.N8N_BASE_URL ?? 'http://localhost:5678').replace(
  /\/$/,
  '',
);
const API_KEY = process.env.N8N_API_KEY;
const SPIKE_NAME = 'n8nt spike (safe to delete)';
const WEBHOOK_PATH = 'n8nt-spike';

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

async function doctor() {
  const health = await fetch(`${BASE_URL}/healthz`).catch(() => null);
  if (!health?.ok) {
    throw new Error(`n8n is not reachable at ${BASE_URL}. Is the container up?`);
  }

  if (!API_KEY) {
    throw new Error('N8N_API_KEY is not set.');
  }

  await api('GET', '/workflows?limit=1');
  console.log(`ok   n8n reachable and API key accepted (${BASE_URL})`);
}

function spikeWorkflowDefinition() {
  return {
    name: SPIKE_NAME,
    nodes: [
      {
        id: randomUUID(),
        name: 'Webhook',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        position: [0, 0],
        webhookId: randomUUID(),
        parameters: {
          httpMethod: 'POST',
          path: WEBHOOK_PATH,
          responseMode: 'lastNode',
          options: {},
        },
      },
      {
        id: randomUUID(),
        name: 'Build Reply',
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        position: [220, 0],
        parameters: {
          assignments: {
            assignments: [
              {
                id: randomUUID(),
                name: 'echo',
                value: '={{ $json.body.message }}',
                type: 'string',
              },
              {
                id: randomUUID(),
                name: 'testRunId',
                value: '={{ $json.body.__testRunId }}',
                type: 'string',
              },
            ],
          },
          options: {},
        },
      },
    ],
    connections: {
      Webhook: {
        main: [[{ node: 'Build Reply', type: 'main', index: 0 }]],
      },
    },
    settings: { executionOrder: 'v1' },
  };
}

async function findSpikeWorkflow() {
  const { data } = await api(
    'GET',
    `/workflows?name=${encodeURIComponent(SPIKE_NAME)}`,
  );

  return data.find((workflow) => workflow.name === SPIKE_NAME);
}

async function ensureSpikeWorkflow() {
  let workflow = await findSpikeWorkflow();

  if (!workflow) {
    workflow = await api('POST', '/workflows', spikeWorkflowDefinition());
    console.log(`ok   created workflow "${SPIKE_NAME}" (${workflow.id})`);
  }

  // Production webhooks only exist while the workflow is active.
  if (!workflow.active) {
    await api('POST', `/workflows/${workflow.id}/activate`);
    console.log('ok   activated workflow');
  }

  return workflow;
}

// n8n registers a production webhook shortly after activation returns, so a
// call made right away can 404. A 404 means nothing ran, so retrying is safe.
async function triggerWebhook(payload) {
  const maxAttempts = 10;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    const response = await fetch(`${BASE_URL}/webhook/${WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (response.status === 404 && attempt < maxAttempts) {
      await sleep(500);
      continue;
    }

    const body = await response.json().catch(() => null);

    return {
      status: response.status,
      body,
      durationMs: Date.now() - startedAt,
      attempts: attempt,
    };
  }
}

function nodeOutput(execution, nodeName) {
  const runs = execution.data?.resultData?.runData?.[nodeName];
  const items = runs?.[0]?.data?.main?.[0];

  return items ? items.map((item) => item.json) : null;
}

// The webhook response does not include an execution ID, so we tag the
// payload with a unique test run ID and look for it in recent executions.
async function findExecution(workflowId, testRunId) {
  const maxAttempts = 10;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { data } = await api(
      'GET',
      `/executions?workflowId=${workflowId}&includeData=true&limit=10`,
    );

    const match = data.find((execution) => {
      const webhookItems = nodeOutput(execution, 'Webhook');
      return webhookItems?.[0]?.body?.__testRunId === testRunId;
    });

    if (match && match.status !== 'running') {
      return { execution: match, attempts: attempt };
    }

    await sleep(500);
  }

  throw new Error(`No execution found for test run ${testRunId}`);
}

function check(label, passed, detail) {
  console.log(`${passed ? 'pass' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
  return passed;
}

async function runSpike() {
  await doctor();
  const workflow = await ensureSpikeWorkflow();

  const testRunId = randomUUID();
  const message = 'hello from n8nt';
  const response = await triggerWebhook({ message, __testRunId: testRunId });
  console.log(
    `ok   webhook answered ${response.status} in ${response.durationMs}ms ` +
      `(attempt ${response.attempts})`,
  );

  const { execution, attempts } = await findExecution(workflow.id, testRunId);
  console.log(`ok   found execution ${execution.id} after ${attempts} poll(s)`);

  // The runner will fetch single executions by ID, so confirm that path too.
  const byId = await api('GET', `/executions/${execution.id}?includeData=true`);
  const reply = nodeOutput(byId, 'Build Reply')?.[0];

  console.log('\n--- execution summary ---');
  console.log(
    JSON.stringify(
      {
        id: byId.id,
        status: byId.status,
        mode: byId.mode,
        startedAt: byId.startedAt,
        stoppedAt: byId.stoppedAt,
        nodesThatRan: Object.keys(byId.data?.resultData?.runData ?? {}),
        buildReplyOutput: reply,
      },
      null,
      2,
    ),
  );

  console.log('\n--- checks ---');
  const results = [
    check('response status is 200', response.status === 200, response.status),
    check('response echoes message', response.body?.echo === message),
    check('execution status is success', byId.status === 'success', byId.status),
    check('node output readable by ID', reply?.testRunId === testRunId),
  ];

  if (results.includes(false)) {
    process.exitCode = 1;
  }
}

async function cleanup() {
  const workflow = await findSpikeWorkflow();
  if (!workflow) {
    console.log('nothing to clean up');
    return;
  }

  // n8n 2.x refuses to delete a published (active) workflow, and unpublishing
  // finishes in the background, so the delete answers 409 for a moment.
  if (workflow.active) {
    await api('POST', `/workflows/${workflow.id}/deactivate`);
  }

  for (let attempt = 1; ; attempt++) {
    try {
      await api('DELETE', `/workflows/${workflow.id}`);
      break;
    } catch (error) {
      if (error.status !== 409 || attempt >= 10) {
        throw error;
      }

      await sleep(500);
    }
  }
  console.log(`ok   deleted workflow ${workflow.id}`);
}

const command = process.argv.includes('--cleanup') ? cleanup : runSpike;

command().catch((error) => {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
});
