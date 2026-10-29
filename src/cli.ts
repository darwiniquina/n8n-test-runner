import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnvironment } from './config.ts';
import { harnessStatus, installHarness, uninstallHarness } from './harness.ts';
import { createN8nClient } from './n8n-client.ts';
import { printResult, printSummary } from './report.ts';
import { runScenario, type ScenarioResult } from './runner.ts';
import { findScenarioFiles, loadScenario } from './scenario.ts';

const ENV_FILE = '.env';

// Captured before .env is loaded, to tell real environment variables apart
// from values that came from .env.
const REAL_ENVIRONMENT_KEYS = new Set(Object.keys(process.env));

const USAGE = `Usage:
  n8nt doctor                 check the connection to n8n
  n8nt run <paths...>         run scenario files or folders
  n8nt harness install        add the harness workflow to n8n (for harness triggers)
  n8nt harness uninstall      remove the harness workflow and its credential

Options:
  --config <file>   config file (default: n8nt.config.yaml)
  --env <name>      environment from the config (default: defaultEnvironment)
  --json            print results as JSON instead of text`;

type CommonOptions = { configPath?: string; envName?: string };

async function doctor(options: CommonOptions) {
  const environment = await loadEnvironment(options);
  const client = createN8nClient(environment);

  console.log(`environment  ${environment.name}`);
  console.log(`api          ${environment.baseUrl}`);
  console.log(`webhooks     ${environment.webhookBaseUrl}`);

  if (!(await client.isHealthy())) {
    throw new Error(`n8n is not reachable at ${environment.baseUrl}. Is it running?`);
  }
  console.log('ok           n8n is reachable');

  await client.checkApiKey();
  console.log(`ok           API key from ${environment.apiKeyEnv} is accepted`);

  // The harness is optional, so its state is reported, not treated as an error.
  const status = await harnessStatus(client);
  const secret = environment.harnessSecret
    ? `${environment.harnessSecretEnv} is set`
    : `${environment.harnessSecretEnv} is not set`;
  console.log(`harness      ${status}, ${secret}`);
}

async function harness(action: string | undefined, options: CommonOptions) {
  const environment = await loadEnvironment(options);
  const client = createN8nClient(environment);

  if (action === 'install') {
    const result = await installHarness(client, environment, ENV_FILE);
    console.log(`ok   harness workflow installed and active (${result.workflowId})`);
    console.log(`ok   secret saved to ${ENV_FILE} as ${environment.harnessSecretEnv}`);
    console.log(`     keep ${ENV_FILE} out of git`);

    // A real environment variable wins over .env, so the new secret would be
    // ignored until that variable is updated or removed.
    if (REAL_ENVIRONMENT_KEYS.has(environment.harnessSecretEnv)) {
      console.log(
        `warn ${environment.harnessSecretEnv} is also set in your environment, ` +
          `which wins over ${ENV_FILE}. Remove or update it, or harness calls get 403.`,
      );
    }
    return;
  }

  if (action === 'uninstall') {
    const result = await uninstallHarness(client);
    console.log(
      result.deletedWorkflow
        ? 'ok   harness workflow deleted'
        : 'ok   no harness workflow to delete',
    );
    console.log(`ok   deleted ${result.deletedCredentials} harness credential(s)`);
    return;
  }

  throw new Error(`Use "n8nt harness install" or "n8nt harness uninstall".`);
}

async function run(
  paths: string[],
  options: CommonOptions & { json: boolean },
) {
  if (paths.length === 0) {
    throw new Error('Give at least one scenario file or folder.');
  }

  const environment = await loadEnvironment(options);
  const client = createN8nClient(environment);
  const files = await findScenarioFiles(paths);
  const results: ScenarioResult[] = [];

  // Run one at a time: it keeps execution lookups simple and avoids flooding
  // a local n8n with parallel runs.
  for (const file of files) {
    let result: ScenarioResult;

    try {
      const scenario = await loadScenario(file);
      result = await runScenario(scenario, client, environment.variables);
    } catch (error) {
      result = {
        file,
        name: basename(file),
        passed: false,
        durationMs: 0,
        steps: [],
        error: (error as Error).message,
      };
    }

    results.push(result);
    if (!options.json) {
      printResult(result);
    }
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printSummary(results);
  }

  if (results.length === 0 || results.some((result) => !result.passed)) {
    process.exitCode = 1;
  }
}

function loadDotEnv() {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // .env is optional. The API key can come from the real environment.
  }
}

async function main() {
  loadDotEnv();

  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      env: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const [command, ...paths] = positionals;
  const options = { configPath: values.config, envName: values.env };

  if (values.help || !command) {
    console.log(USAGE);
    return;
  }

  if (command === 'doctor') {
    await doctor(options);
  } else if (command === 'run') {
    await run(paths, { ...options, json: values.json });
  } else if (command === 'harness') {
    await harness(paths[0], options);
  } else {
    throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main().catch((error: Error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
