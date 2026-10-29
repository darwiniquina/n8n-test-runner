import { setTimeout as sleep } from 'node:timers/promises';
import type { Environment } from './config.ts';
import type { WebhookTrigger } from './scenario.ts';

// Added to every webhook call so we can find the execution it started.
export const TEST_RUN_PARAM = '__testRunId';

type NodeRun = {
  data?: { main?: Array<Array<{ json: unknown }> | null> };
  metadata?: { subExecution?: { executionId?: string; workflowId?: string } };
  error?: { message?: string; executionId?: string };
};

export type Execution = {
  id: string;
  status: string;
  mode: string;
  startedAt: string;
  stoppedAt: string | null;
  data?: {
    resultData?: {
      runData?: Record<string, NodeRun[]>;
      error?: { message?: string };
    };
  };
};

export type Workflow = {
  id: string;
  name: string;
  active: boolean;
};

export type Credential = {
  id: string;
  name: string;
  type: string;
};

export type WebhookResponse = {
  status: number;
  body: unknown;
  durationMs: number;
};

type WebhookCall = {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
};

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// Output items of a node's first run, or undefined when the node never ran.
export function nodeItems(execution: Execution, nodeName: string) {
  const runs = execution.data?.resultData?.runData?.[nodeName];
  if (!runs) {
    return undefined;
  }

  const items = runs[0]?.data?.main?.[0] ?? [];
  return items.map((item) => item.json);
}

export function firstNodeRun(execution: Execution, nodeName: string) {
  return execution.data?.resultData?.runData?.[nodeName]?.[0];
}

function containsTestRun(execution: Execution, testRunId: string) {
  const runData = execution.data?.resultData?.runData ?? {};

  // The trigger node exposes the query string it received, wherever it sits.
  return Object.values(runData).some((runs) => {
    const firstItem = runs[0]?.data?.main?.[0]?.[0]?.json as
      | { query?: Record<string, unknown> }
      | undefined;

    return firstItem?.query?.[TEST_RUN_PARAM] === testRunId;
  });
}

function parseBody(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isNotRegistered(response: WebhookResponse) {
  return response.status === 404 && /not registered/i.test(JSON.stringify(response.body));
}

export function createN8nClient(environment: Environment) {
  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!environment.apiKey) {
      throw new Error(`${environment.apiKeyEnv} is not set.`);
    }

    const response = await fetch(`${environment.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        'X-N8N-API-KEY': environment.apiKey,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new ApiError(
        `${method} ${path} -> ${response.status}: ${text}`,
        response.status,
      );
    }

    return (text ? JSON.parse(text) : null) as T;
  }

  async function isHealthy() {
    const response = await fetch(`${environment.baseUrl}/healthz`).catch(
      () => null,
    );

    return Boolean(response?.ok);
  }

  async function checkApiKey() {
    await api('GET', '/workflows?limit=1');
  }

  async function findWorkflowByName(name: string) {
    const { data } = await api<{ data: Workflow[] }>(
      'GET',
      `/workflows?name=${encodeURIComponent(name)}`,
    );

    return data.find((workflow) => workflow.name === name);
  }

  async function resolveWorkflow(nameOrId: string): Promise<Workflow> {
    let workflow = await findWorkflowByName(nameOrId);

    if (!workflow) {
      workflow = await api<Workflow>(
        'GET',
        `/workflows/${encodeURIComponent(nameOrId)}`,
      ).catch((error) => {
        if (error instanceof ApiError && error.status === 404) {
          return undefined;
        }

        throw error;
      });
    }

    if (!workflow) {
      throw new Error(`No workflow named or with ID "${nameOrId}".`);
    }

    // n8n 2.x only runs published workflows from webhooks and from other
    // workflows. We never activate them ourselves, to avoid changing the
    // user's n8n.
    if (!workflow.active) {
      throw new Error(
        `Workflow "${workflow.name}" is not active (published). n8n only ` +
          'runs published workflows from webhooks and from other workflows. ' +
          'Activate it in n8n first.',
      );
    }

    return workflow;
  }

  async function createWorkflow(definition: object) {
    return api<Workflow>('POST', '/workflows', definition);
  }

  async function activateWorkflow(id: string) {
    await api('POST', `/workflows/${id}/activate`);
  }

  async function deleteWorkflow(workflow: Workflow) {
    // n8n 2.x refuses to delete a published workflow, and unpublishing
    // finishes in the background, so the delete answers 409 for a moment.
    if (workflow.active) {
      await api('POST', `/workflows/${workflow.id}/deactivate`);
    }

    for (let attempt = 1; ; attempt++) {
      try {
        await api('DELETE', `/workflows/${workflow.id}`);
        return;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409 || attempt >= 10) {
          throw error;
        }

        await sleep(500);
      }
    }
  }

  async function createCredential(definition: {
    name: string;
    type: string;
    data: Record<string, unknown>;
  }) {
    return api<Credential>('POST', '/credentials', definition);
  }

  async function findCredentialsByName(name: string) {
    const { data } = await api<{ data: Credential[] }>(
      'GET',
      '/credentials?limit=250',
    );

    return data.filter((credential) => credential.name === name);
  }

  async function deleteCredential(id: string) {
    await api('DELETE', `/credentials/${id}`);
  }

  async function callWebhook(call: WebhookCall): Promise<WebhookResponse> {
    const path = call.path.replace(/^\/+/, '');
    const url = new URL(`${environment.webhookBaseUrl}/webhook/${path}`);

    for (const [key, value] of Object.entries(call.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const headers = { ...call.headers };
    let body: string | undefined;

    if (call.body !== undefined) {
      const isText = typeof call.body === 'string';
      body = isText ? (call.body as string) : JSON.stringify(call.body);

      const hasContentType = Object.keys(headers).some(
        (name) => name.toLowerCase() === 'content-type',
      );
      if (!isText && !hasContentType) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const startedAt = Date.now();
    const response = await fetch(url, { method: call.method, headers, body });
    const responseBody = parseBody(await response.text());

    return {
      status: response.status,
      body: responseBody,
      durationMs: Date.now() - startedAt,
    };
  }

  async function triggerWebhook(
    trigger: WebhookTrigger,
    testRunId: string,
  ): Promise<WebhookResponse> {
    const response = await callWebhook({
      ...trigger,
      query: { ...trigger.query, [TEST_RUN_PARAM]: testRunId },
    });

    // A wrong path or method would otherwise surface later as a confusing
    // "execution not found" after polling.
    if (isNotRegistered(response)) {
      throw new Error(
        `Webhook "${trigger.method} ${trigger.path}" is not registered in n8n. ` +
          'Check the path, the method, and that the workflow is active.',
      );
    }

    return response;
  }

  async function triggerHarness(call: {
    path: string;
    secretHeader: string;
    workflowId: string;
    input: unknown;
    testRunId: string;
  }): Promise<WebhookResponse> {
    if (!environment.harnessSecret) {
      throw new Error(
        `${environment.harnessSecretEnv} is not set. Run "n8nt harness install".`,
      );
    }

    const response = await callWebhook({
      method: 'POST',
      path: call.path,
      query: { [TEST_RUN_PARAM]: call.testRunId },
      headers: { [call.secretHeader]: environment.harnessSecret },
      body: { workflowId: call.workflowId, input: call.input },
    });

    if (isNotRegistered(response)) {
      throw new Error(
        'The harness is not installed or not active. Run "n8nt harness install".',
      );
    }

    if (response.status === 403) {
      throw new Error(
        `The harness rejected the secret in ${environment.harnessSecretEnv}. ` +
          'Reinstall the harness to get a new one.',
      );
    }

    return response;
  }

  async function getExecution(id: string) {
    return api<Execution>('GET', `/executions/${id}?includeData=true`);
  }

  async function findExecution(
    workflowId: string,
    testRunId: string,
    timeoutMs = 15_000,
  ): Promise<Execution> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const { data } = await api<{ data: Execution[] }>(
        'GET',
        `/executions?workflowId=${workflowId}&includeData=true&limit=20`,
      );

      const match = data.find((execution) =>
        containsTestRun(execution, testRunId),
      );

      if (match && match.status !== 'running' && match.status !== 'new') {
        return match;
      }

      await sleep(500);
    }

    throw new Error(
      'No execution found for this run. Check that the workflow saves ' +
        'successful executions (workflow settings) and that it was not ' +
        'flooded by other runs.',
    );
  }

  return {
    isHealthy,
    checkApiKey,
    findWorkflowByName,
    resolveWorkflow,
    createWorkflow,
    activateWorkflow,
    deleteWorkflow,
    createCredential,
    findCredentialsByName,
    deleteCredential,
    triggerWebhook,
    triggerHarness,
    getExecution,
    findExecution,
  };
}

export type N8nClient = ReturnType<typeof createN8nClient>;
