import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

export const DEFAULT_CONFIG_PATH = 'n8nt.config.yaml';

const environmentSchema = z.strictObject({
  baseUrl: z.url(),
  // Webhooks can live elsewhere (for example a tunnel) while the API stays local.
  webhookBaseUrl: z.url().optional(),
  apiKeyEnv: z.string().default('N8N_API_KEY'),
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
};

const BUILT_IN_CONFIG: Config = {
  defaultEnvironment: 'local',
  environments: {
    local: {
      baseUrl: 'http://localhost:5678',
      apiKeyEnv: 'N8N_API_KEY',
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

  const result = configSchema.safeParse(parse(text));
  if (!result.success) {
    throw new Error(
      `Invalid config ${configPath}:\n${z.prettifyError(result.error)}`,
    );
  }

  return result.data;
}

function trimSlash(url: string) {
  return url.replace(/\/+$/, '');
}

export async function loadEnvironment(options: {
  configPath?: string;
  envName?: string;
}): Promise<Environment> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const config = await readConfig(configPath, Boolean(options.configPath));

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
  };
}
