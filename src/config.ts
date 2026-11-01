import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { VARIABLE_NAME, type Variables } from './variables.ts';

export const DEFAULT_CONFIG_PATH = 'n8nt.config.yaml';

const environmentSchema = z.strictObject({
  baseUrl: z.url(),
  // Webhooks can live elsewhere (for example a tunnel) while the API stays local.
  webhookBaseUrl: z.url().optional(),
  apiKeyEnv: z.string().default('N8N_API_KEY'),
  harnessSecretEnv: z.string().default('N8N_HARNESS_SECRET'),
  variables: z
    .record(z.string().regex(VARIABLE_NAME), z.unknown())
    .default({}),
});

const configSchema = z.strictObject({
  defaultEnvironment: z.string().default('local'),
  environments: z.record(z.string(), environmentSchema),
});

type Config = z.infer<typeof configSchema>;

export type Environment = {
  name: string;
  baseUrl: string;
  webhookBaseUrl: string;
  apiKeyEnv: string;
  apiKey: string | undefined;
  harnessSecretEnv: string;
  harnessSecret: string | undefined;
  variables: Variables;
};

const BUILT_IN_CONFIG: Config = {
  defaultEnvironment: 'local',
  environments: {
    local: {
      baseUrl: 'http://localhost:5678',
      apiKeyEnv: 'N8N_API_KEY',
      harnessSecretEnv: 'N8N_HARNESS_SECRET',
      variables: {},
    },
  },
};

async function readConfig(configPath: string, isExplicit: boolean) {
  let text: string;

  try {
    text = await readFile(configPath, 'utf8');
  } catch (error) {
    // Without a config file, fall back to a local n8n on the default port.
    const isMissing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    if (isMissing && !isExplicit) {
      return BUILT_IN_CONFIG;
    }

    throw error;
  }

  try {
    return parseConfig(parse(text));
  } catch (error) {
    throw new Error(`Invalid config ${configPath}:\n${(error as Error).message}`);
  }
}

export function parseConfig(data: unknown): Config {
  const result = configSchema.safeParse(data);
  if (!result.success) {
    throw new Error(z.prettifyError(result.error));
  }

  return result.data;
}

function trimSlash(url: string) {
  return url.replace(/\/+$/, '');
}

export type ConfigLocation = {
  // An explicit file must exist.
  configPath?: string;
  // Otherwise n8nt.config.yaml in this folder (default: the working
  // directory), falling back to a local n8n when it does not exist.
  configDir?: string;
};

export async function loadConfig(location: ConfigLocation) {
  const configPath =
    location.configPath ?? join(location.configDir ?? '.', DEFAULT_CONFIG_PATH);

  return readConfig(configPath, Boolean(location.configPath));
}

// Environment names and URLs only, never keys or secrets. Safe to send to the UI.
export async function listEnvironments(location: ConfigLocation) {
  const config = await loadConfig(location);

  return {
    defaultEnvironment: config.defaultEnvironment,
    environments: Object.entries(config.environments).map(([name, environment]) => ({
      name,
      baseUrl: trimSlash(environment.baseUrl),
      webhookBaseUrl: trimSlash(environment.webhookBaseUrl ?? environment.baseUrl),
    })),
  };
}

export async function loadEnvironment(
  options: ConfigLocation & { envName?: string },
): Promise<Environment> {
  const config = await loadConfig(options);

  const name = options.envName ?? config.defaultEnvironment;
  const environment = config.environments[name];
  if (!environment) {
    const known = Object.keys(config.environments).join(', ');
    throw new Error(`Unknown environment "${name}". Known: ${known}`);
  }

  return {
    name,
    baseUrl: trimSlash(environment.baseUrl),
    webhookBaseUrl: trimSlash(environment.webhookBaseUrl ?? environment.baseUrl),
    apiKeyEnv: environment.apiKeyEnv,
    apiKey: process.env[environment.apiKeyEnv],
    harnessSecretEnv: environment.harnessSecretEnv,
    harnessSecret: process.env[environment.harnessSecretEnv],
    variables: environment.variables,
  };
}
