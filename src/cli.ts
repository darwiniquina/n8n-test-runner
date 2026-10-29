import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnvironment } from './config.ts';
import { createN8nClient } from './n8n-client.ts';
import { printResult, printSummary } from './report.ts';
import { runScenario, type ScenarioResult } from './runner.ts';
import { findScenarioFiles, loadScenario } from './scenario.ts';

const USAGE = `Usage:
  n8nt doctor                 check the connection to n8n
  n8nt run <paths...>         run scenario files or folders

Options:
  --config <file>   config file (default: n8nt.config.yaml)
  --env <name>      environment from the config (default: defaultEnvironment)
  --json            print results as JSON instead of text`;

async function doctor(options: { configPath?: string; envName?: string }) {
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
}

async function run(
  paths: string[],
  options: { configPath?: string; envName?: string; json: boolean },
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
    process.loadEnvFile('.env');
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
  } else {
    throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main().catch((error: Error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
