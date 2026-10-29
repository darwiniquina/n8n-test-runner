import { setTimeout as sleep } from 'node:timers/promises';
import type { Environment } from './config.ts';
import type { WebhookTrigger } from './scenario.ts';

// Added to every webhook call so we can find the execution it started.
export const TEST_RUN_PARAM = '__testRunId';

type NodeRun = {
  data?: { main?: Array<Array<{ json: unknown }> | null> };
  error?: { message?: string };
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

export type WebhookResponse = {
  status: number;
  body: unknown;
  durationMs: number;
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

export function createN8nClient(environment: Environment) {
  async function api<T>(method: string, path: string): Promise<T> {
    if (!environment.apiKey) {
      throw new Error(`${environment.apiKeyEnv} is not set.`);
    }

    const response = await fetch(`${environment.baseUrl}/api/v1${path}`, {
      method,
      headers: { 'X-N8N-API-KEY': environment.apiKey },
    });

    const text = await response.text();
    if (!response.ok) {
      throw new ApiError(
        `${method} ${path} -> ${response.status}: ${text}`,
        response.status,
      );
    }

    return JSON.parse(text) as T;
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

  async function resolveWorkflow(nameOrId: string): Promise<Workflow> {
    const { data } = await api<{ data: Workflow[] }>(
      'GET',
      `/workflows?name=${encodeURIComponent(nameOrId)}`,
    );

    let workflow = data.find((candidate) => candidate.name === nameOrId);

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

    // We never activate workflows ourselves, to avoid changing the user's n8n.
    if (!workflow.active) {
      throw new Error(
        `Workflow "${workflow.name}" is not active, so its production ` +
          'webhook does not exist. Activate it in n8n first.',
      );
    }

    return workflow;
  }

  async function triggerWebhook(
    trigger: WebhookTrigger,
    testRunId: string,
  ): Promise<WebhookResponse> {
    const path = trigger.path.replace(/^\/+/, '');
    const url = new URL(`${environment.webhookBaseUrl}/webhook/${path}`);

    for (const [key, value] of Object.entries(trigger.query)) {
      url.searchParams.set(key, value);
    }

    url.searchParams.set(TEST_RUN_PARAM, testRunId);

    const headers = { ...trigger.headers };
    let body: string | undefined;

    if (trigger.body !== undefined) {
      const isText = typeof trigger.body === 'string';
      body = isText ? (trigger.body as string) : JSON.stringify(trigger.body);

      const hasContentType = Object.keys(headers).some(
        (name) => name.toLowerCase() === 'content-type',
      );
      if (!isText && !hasContentType) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const startedAt = Date.now();
    const response = await fetch(url, {
      method: trigger.method,
      headers,
      body,
    });
    const responseBody = parseBody(await response.text());
    const durationMs = Date.now() - startedAt;

    // A wrong path or method would otherwise surface later as a confusing
    // "execution not found" after polling.
    if (response.status === 404 && /not registered/i.test(JSON.stringify(responseBody))) {
      throw new Error(
        `Webhook "${trigger.method} ${path}" is not registered in n8n. ` +
          'Check the path, the method, and that the workflow is active.',
      );
    }

    return { status: response.status, body: responseBody, durationMs };
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
    resolveWorkflow,
    triggerWebhook,
    findExecution,
  };
}

export type N8nClient = ReturnType<typeof createN8nClient>;
