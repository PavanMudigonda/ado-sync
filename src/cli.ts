#!/usr/bin/env node

// Suppress the url.parse() deprecation warning (DEP0169) emitted by azure-devops-node-api
// internals. Cannot be fixed on our side; use the warning event listener instead of
// monkey-patching process.emit.
process.on('warning', (warning) => {
  if ((warning as NodeJS.ErrnoException).code === 'DEP0169') return;
  process.stderr.write(`[node:warning] ${warning.name}: ${warning.message}\n`);
});

import 'dotenv/config';

import chalk from 'chalk';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

import pkg from '../package.json';
import { AiSummaryOpts } from './ai/summarizer';
import { AzureClient } from './azure/client';
import { applyOverrides, CONFIG_TEMPLATE_JSON, CONFIG_TEMPLATE_YAML, loadConfig, resolveConfigPath } from './config';
import { coverageReport, detectStaleTestCases, pull, push, status } from './sync/engine';
import { generateSpecs } from './sync/generate';
import { generateManifests } from './sync/manifest';
import { publishTestResults } from './sync/publish-results';
import { SyncConfig, SyncResult } from './types';

// ─── CLI definition ───────────────────────────────────────────────────────────

const program = new Command();

program
  .name('ado-sync')
  .description('Bidirectional sync between local test specs and Azure DevOps Test Cases')
  .version(pkg.version);

// Global options
program.option('-c, --config <path>', 'Path to config file (default: ado-sync.json)');
program.option('--output <format>', 'Output format: text (default) or json');

// ─── Error formatting (L) ─────────────────────────────────────────────────────

function toError(err: unknown): { message: string; statusCode?: number; status?: number; stack?: string } {
  if (err instanceof Error) return err as any;
  return { message: String(err) };
}

function formatError(err: unknown): string {
  const e = toError(err);
  const status: number = (e as any).statusCode ?? (e as any).status ?? 0;
  if (status === 401) return 'Authentication failed. Check your token (auth.token) and permissions.';
  if (status === 403) return 'Access denied. Your token lacks the required Azure DevOps scopes.';
  if (status === 404) return `Resource not found. Check your orgUrl, project, or test plan ID.\n  ${e.message}`;
  if (status === 429) return 'Azure DevOps rate limit hit. Reduce concurrent operations or retry later.';
  if (status === 503) return 'Azure DevOps is temporarily unavailable (503). Retry later.';
  return e.message;
}

function handleError(err: unknown): never {
  const e = toError(err);
  console.error(chalk.red(formatError(e)));
  if (process.env.DEBUG) console.error(chalk.dim(e.stack ?? ''));
  process.exit(1);
}

/** Collect repeatable option values into an array. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

// ─── AI summary helper ────────────────────────────────────────────────────────

/**
 * Build AiSummaryOpts from parsed CLI opts, falling back to config file values.
 * CLI flags always take precedence. Returns undefined when provider is 'none'.
 */
function buildAiOpts(
  opts: { aiProvider?: string; aiModel?: string; aiUrl?: string; aiKey?: string; aiContext?: string },
  config?: SyncConfig,
  configDir?: string
): AiSummaryOpts | undefined {
  const cfgAi = config?.sync?.ai;
  // CLI --ai-provider none wins over config; config provider='none' also disables
  const provider = opts.aiProvider ?? cfgAi?.provider ?? 'local';
  if (provider === 'none') return undefined;

  const resolveEnvRef = (value?: string): string | undefined => {
    if (!value) return undefined;
    if (!value.startsWith('$')) return value;
    return process.env[value.slice(1)] ?? value;
  };

  const expandHome = (value?: string): string | undefined => {
    if (!value) return undefined;
    if (value === '~') return os.homedir();
    if (value.startsWith('~/') || value.startsWith('~\\')) {
      return path.join(os.homedir(), value.slice(2));
    }
    return value;
  };

  let model = opts.aiModel ?? cfgAi?.model;
  if (provider === 'local' && model) {
    model = resolveEnvRef(model);
    model = expandHome(model);
    if (model && !path.isAbsolute(model)) {
      model = path.resolve(configDir ?? process.cwd(), model);
    }
  }

  // Resolve and read the context file (CLI flag takes precedence over config)
  let contextContent: string | undefined;
  const contextFilePath = opts.aiContext ?? cfgAi?.contextFile;
  if (contextFilePath) {
    const absContextPath = path.isAbsolute(contextFilePath)
      ? contextFilePath
      : path.resolve(configDir ?? process.cwd(), contextFilePath);
    try {
      contextContent = fs.readFileSync(absContextPath, 'utf8');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  [ai-summary] Warning: could not read contextFile "${absContextPath}": ${msg}\n`);
    }
  }

  return {
    provider: provider as AiSummaryOpts['provider'],
    model,
    baseUrl:  opts.aiUrl   ?? cfgAi?.baseUrl,
    apiKey:   opts.aiKey   ?? cfgAi?.apiKey,
    heuristicFallback: true,
    contextContent,
  };
}

// ─── init ─────────────────────────────────────────────────────────────────────

program
  .command('init [output]')
  .description('Generate a starter config file (default: ado-sync.json). Pass ado-sync.yml for YAML.')
  .option('--no-interactive', 'Skip the wizard and dump a template file directly')
  .action(async (output: string | undefined, opts) => {
    const outFile = output ?? 'ado-sync.json';
    const outPath = path.resolve(outFile);
    if (fs.existsSync(outPath)) {
      console.error(chalk.red(`File already exists: ${outPath}`));
      process.exit(1);
    }
    const ext = path.extname(outFile).toLowerCase();
    const isYaml = ext === '.yml' || ext === '.yaml';

    // K: interactive wizard when stdin is a TTY and --no-interactive is not set
    if (opts.interactive && process.stdin.isTTY) {
      const answers = await runInitWizard(isYaml);
      fs.writeFileSync(outPath, answers, 'utf8');
    } else {
      fs.writeFileSync(outPath, isYaml ? CONFIG_TEMPLATE_YAML : CONFIG_TEMPLATE_JSON, 'utf8');
    }

    console.log(chalk.green(`Created ${outPath}`));
    console.log(chalk.dim('Next steps:'));
    console.log(chalk.dim('  ado-sync push   — create test cases from local specs'));
    console.log(chalk.dim('  ado-sync pull   — pull updates from Azure DevOps'));
    console.log(chalk.dim('  ado-sync validate — check config and connectivity'));
  });

// ─── Interactive init wizard (K) ──────────────────────────────────────────────

async function runInitWizard(isYaml: boolean): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

  console.log(chalk.bold('\nado-sync init — interactive setup wizard'));
  console.log(chalk.dim('Press Enter to accept the default shown in [brackets].\n'));

  const orgUrl = (await ask('Azure DevOps org URL [https://dev.azure.com/myorg]: ')) ||
    'https://dev.azure.com/myorg';
  const project = (await ask('Project name [MyProject]: ')) || 'MyProject';
  const authType = (await ask('Auth type (pat / accessToken / managedIdentity) [pat]: ')) || 'pat';
  const tokenEnv = authType === 'managedIdentity'
    ? ''
    : (await ask('Token env var name [AZURE_DEVOPS_TOKEN]: ')) || 'AZURE_DEVOPS_TOKEN';
  const planId = parseInt((await ask('Test plan ID [42]: ')) || '42', 10) || 42;
  const localType = (await ask(
    'Local spec type (gherkin / markdown / playwright / csharp / java / python / ...) [gherkin]: '
  )) || 'gherkin';
  const defaultGlob = localType === 'gherkin' || localType === 'reqnroll'
    ? '**/*.feature'
    : localType === 'markdown'
    ? '**/*.md'
    : '**/*.spec.ts';
  const includeGlob = (await ask(`Include glob pattern [${defaultGlob}]: `)) || defaultGlob;

  rl.close();

  const cfg: Record<string, any> = {
    orgUrl,
    project,
    auth: authType === 'managedIdentity'
      ? { type: 'managedIdentity', applicationIdURI: 'api://your-app-id' }
      : { type: authType, token: `$${tokenEnv}` },
    testPlan: { id: planId },
    local: { type: localType, include: includeGlob },
  };

  if (isYaml) {
    const yaml = await import('js-yaml');
    return yaml.dump(cfg, { indent: 2 });
  }
  return JSON.stringify(cfg, null, 2) + '\n';
}

// ─── push ─────────────────────────────────────────────────────────────────────

program
  .command('push')
  .description('Push local test specs to Azure DevOps (create or update test cases)')
  .option('--dry-run', 'Show what would change without making any modifications')
  .option('--tags <expression>', 'Only sync scenarios matching this tag expression (e.g. "@smoke and not @wip")')
  .option('--config-override <path=value>', 'Override a config value (repeatable, e.g. --config-override sync.tagPrefix=mytag)', collect, [])
  .option('--ai-provider <provider>', 'AI provider for test step generation: local (default, node-llama-cpp), heuristic, ollama, openai, anthropic, none (disable)')
  .option('--ai-model <model>', 'local: path to GGUF file; ollama: model tag; openai/anthropic: model name')
  .option('--ai-url <url>', 'Base URL for ollama or OpenAI-compatible endpoint')
  .option('--ai-key <key>', 'API key for openai or anthropic')
  .option('--ai-context <file>', 'Path to a markdown file with domain context/instructions injected into the AI prompt')
  .action(async (opts) => {
    const globalOpts = program.opts();
    try {
      const configPath = resolveConfigPath(globalOpts.config);
      const config = loadConfig(configPath);
      if (opts.configOverride?.length) applyOverrides(config, opts.configOverride);
      const configDir = path.dirname(configPath);

      console.log(chalk.bold('ado-sync push'));
      console.log(chalk.dim(`Config:  ${configPath}`));
      console.log(chalk.dim(`Project: ${config.project}`));
      console.log(chalk.dim(`Plan:    ${config.testPlan.id}`));
      if (opts.dryRun) console.log(chalk.yellow('Dry run — no changes will be made'));
      if (opts.tags) console.log(chalk.dim(`Tags:    ${opts.tags}`));
      if (opts.configOverride?.length) console.log(chalk.dim(`Overrides: ${opts.configOverride.join(', ')}`));
      console.log('');

      const aiSummary = buildAiOpts(opts, config, configDir);
      const isTTY = process.stdout.isTTY ?? false;
      const outputFormat = program.opts().output;
      const onProgress = outputFormat === 'json' ? undefined : createProgressCallback(isTTY);
      const onAiProgress = outputFormat === 'json' ? undefined : createAiProgressCallback(isTTY);
      const results = await push(config, configDir, { dryRun: opts.dryRun, tags: opts.tags, onProgress, onAiProgress, aiSummary });
      if (isTTY && outputFormat !== 'json') clearProgressLine();
      printResults(results, config.toolSettings?.outputLevel, outputFormat);
    } catch (err: unknown) {
      handleError(err);
    }
  });

// ─── pull ─────────────────────────────────────────────────────────────────────

program
  .command('pull')
  .description('Pull updates from Azure DevOps into local spec files')
  .option('--dry-run', 'Show what would change without modifying local files')
  .option('--tags <expression>', 'Only sync scenarios matching this tag expression (e.g. "@smoke and not @wip")')
  .option('--config-override <path=value>', 'Override a config value (repeatable)', collect, [])
  .action(async (opts) => {
    const globalOpts = program.opts();
    try {
      const configPath = resolveConfigPath(globalOpts.config);
      const config = loadConfig(configPath);
      if (opts.configOverride?.length) applyOverrides(config, opts.configOverride);
      const configDir = path.dirname(configPath);

      console.log(chalk.bold('ado-sync pull'));
      console.log(chalk.dim(`Config:  ${configPath}`));
      if (opts.dryRun) console.log(chalk.yellow('Dry run — no changes will be made'));
      if (opts.tags) console.log(chalk.dim(`Tags:    ${opts.tags}`));
      console.log('');

      const isTTY = process.stdout.isTTY ?? false;
      const outputFormat = program.opts().output;
      const onProgress = outputFormat === 'json' ? undefined : createProgressCallback(isTTY);
      const results = await pull(config, configDir, { dryRun: opts.dryRun, tags: opts.tags, onProgress });
      if (isTTY && outputFormat !== 'json') clearProgressLine();
      printResults(results, config.toolSettings?.outputLevel, outputFormat);
    } catch (err: unknown) {
      handleError(err);
    }
  });

// ─── status ───────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show diff between local specs and Azure DevOps without making changes')
  .option('--tags <expression>', 'Only check scenarios matching this tag expression')
  .option('--config-override <path=value>', 'Override a config value (repeatable)', collect, [])
  .option('--ai-provider <provider>', 'AI provider for test step generation: local (default, node-llama-cpp), heuristic, ollama, openai, anthropic, none (disable)')
  .option('--ai-model <model>', 'local: path to GGUF file; ollama: model tag; openai/anthropic: model name')
  .option('--ai-url <url>', 'Base URL for ollama or OpenAI-compatible endpoint')
  .option('--ai-key <key>', 'API key for openai or anthropic')
  .option('--ai-context <file>', 'Path to a markdown file with domain context/instructions injected into the AI prompt')
  .action(async (opts) => {
    const globalOpts = program.opts();
    try {
      const configPath = resolveConfigPath(globalOpts.config);
      const config = loadConfig(configPath);
      if (opts.configOverride?.length) applyOverrides(config, opts.configOverride);
      const configDir = path.dirname(configPath);

      console.log(chalk.bold('ado-sync status'));
      console.log(chalk.dim(`Config: ${configPath}`));
      if (opts.tags) console.log(chalk.dim(`Tags:   ${opts.tags}`));
      console.log('');

      const aiSummary = buildAiOpts(opts, config, configDir);
      const isTTY = process.stdout.isTTY ?? false;
      const outputFormat = program.opts().output;
      const onProgress = outputFormat === 'json' ? undefined : createProgressCallback(isTTY);
      const onAiProgress = outputFormat === 'json' ? undefined : createAiProgressCallback(isTTY);
      const results = await status(config, configDir, { tags: opts.tags, onProgress, onAiProgress, aiSummary });
      if (isTTY && outputFormat !== 'json') clearProgressLine();
      printResults(results, config.toolSettings?.outputLevel, outputFormat);
    } catch (err: unknown) {
      handleError(err);
    }
  });

// ─── publish-test-results ─────────────────────────────────────────────────────

program
  .command('publish-test-results')
  .description('Publish test results from result files (TRX, JUnit, Cucumber JSON, CTRF) to Azure DevOps')
  .option('--testResult <path>', 'Path to a test result file (repeatable)', collect, [])
  .option('--testResultFormat <format>', 'Result file format: trx, nunitXml, junit, cucumberJson, playwrightJson, ctrfJson')
  .option('--attachmentsFolder <path>', 'Folder with screenshots/videos/logs to attach to test results')
  .option('--runName <name>', 'Name for the test run in Azure DevOps')
  .option('--buildId <id>', 'Build ID to associate with the test run')
  .option('--dry-run', 'Parse results and show summary without publishing')
  .option('--create-issues-on-failure', 'File GitHub Issues or ADO Bugs for each failed test')
  .option('--issue-provider <provider>', 'Issue provider: github (default) or ado')
  .option('--github-repo <owner/repo>', 'GitHub repository to file issues in (e.g. "myorg/myrepo")')
  .option('--github-token <token>', 'GitHub token ($ENV_VAR reference supported)')
  .option('--bug-threshold <percent>', 'Failure % above which one env-failure issue is filed instead of per-test (default: 20)')
  .option('--max-issues <n>', 'Hard cap on issues filed per run (default: 50)')
  .option('--config-override <path=value>', 'Override a config value (repeatable)', collect, [])
  .action(async (opts) => {
    const globalOpts = program.opts();
    try {
      const configPath = resolveConfigPath(globalOpts.config);
      const config = loadConfig(configPath);
      if (opts.configOverride?.length) applyOverrides(config, opts.configOverride);
      const configDir = path.dirname(configPath);

      console.log(chalk.bold('ado-sync publish-test-results'));
      console.log(chalk.dim(`Config: ${configPath}`));
      if (opts.dryRun) console.log(chalk.yellow('Dry run — no changes will be made'));
      console.log('');

      const result = await publishTestResults(config, configDir, {
        dryRun: opts.dryRun,
        resultFiles: opts.testResult?.length ? opts.testResult : undefined,
        resultFormat: opts.testResultFormat,
        attachmentsFolder: opts.attachmentsFolder,
        runName: opts.runName,
        buildId: opts.buildId ? parseInt(opts.buildId) : undefined,
        createIssuesOnFailure: opts.createIssuesOnFailure,
        issueOverrides: {
          ...(opts.issueProvider  && { provider:   opts.issueProvider }),
          ...(opts.githubRepo     && { repo:        opts.githubRepo }),
          ...(opts.githubToken    && { token:       opts.githubToken }),
          ...(opts.bugThreshold   && { threshold:   parseInt(opts.bugThreshold) }),
          ...(opts.maxIssues      && { maxIssues:   parseInt(opts.maxIssues) }),
        },
      });

      console.log(chalk.green(`Total results: ${result.totalResults}`));
      console.log(`  ${chalk.green(`${result.passed} passed`)}  ${chalk.red(`${result.failed} failed`)}  ${chalk.dim(`${result.other} other`)}`);
      if (result.runId) {
        console.log(chalk.dim(`Run ID: ${result.runId}`));
        console.log(chalk.dim(`URL: ${result.runUrl}`));
      }

      if (result.issuesSummary) {
        const s = result.issuesSummary;
        console.log('');
        console.log(chalk.bold('Issues filed:'));
        console.log(chalk.dim(`  Mode: ${s.mode}  |  Total failed: ${s.totalFailed}  |  Suppressed: ${s.suppressed}`));
        for (const issue of s.issued) {
          const prefix = issue.action === 'created' ? chalk.green('+')
                       : issue.action === 'skipped'  ? chalk.dim('=')
                       : chalk.yellow('~');
          const detail = issue.url    ? chalk.dim(` → ${issue.url}`)
                       : issue.reason ? chalk.dim(` (${issue.reason})`)
                       : '';
          console.log(`  ${prefix} ${issue.title}${detail}`);
        }
      }
    } catch (err: unknown) {
      handleError(err);
    }
  });

// ─── Progress bar ─────────────────────────────────────────────────────────────

const ACTION_SYMBOL: Record<string, string> = {
  created:  chalk.green('+'),
  updated:  chalk.blue('~'),
  pulled:   chalk.cyan('↓'),
  skipped:  chalk.dim('='),
  conflict: chalk.yellow('!'),
  removed:  chalk.magenta('−'),
  error:    chalk.red('✗'),
};

const PROGRESS_WIDTH = 20;

/**
 * Returns an onProgress callback if stdout is a TTY, otherwise undefined.
 * The callback overwrites the current line with a live progress bar.
 * Call clearProgressLine() after the operation finishes.
 */
function createProgressCallback(
  isTTY: boolean
): ((done: number, total: number, result: SyncResult) => void) | undefined {
  if (!isTTY) return undefined;

  return (done: number, total: number, result: SyncResult) => {
    const filled = total > 0 ? Math.round((done / total) * PROGRESS_WIDTH) : 0;
    const bar = '█'.repeat(filled) + '░'.repeat(PROGRESS_WIDTH - filled);
    const symbol = ACTION_SYMBOL[result.action] ?? ' ';
    const idStr = result.azureId ? chalk.dim(` [#${result.azureId}]`) : '';
    const maxTitle = 38;
    const title = result.title.length > maxTitle
      ? result.title.slice(0, maxTitle - 1) + '…'
      : result.title;
    const line = `  [${bar}] ${done}/${total}  ${symbol} ${title}${idStr}`;
    // \r returns to start of line; pad to overwrite any previous longer line
    process.stdout.write(`\r${line.padEnd(process.stdout.columns ?? 80)}`);
  };
}

/** Erase the progress bar line (call once before printing results). */
function clearProgressLine(): void {
  process.stdout.write(`\r${' '.repeat(process.stdout.columns ?? 80)}\r`);
}

/**
 * Returns an onAiProgress callback if stdout is a TTY.
 * Shows a spinner-style line during the AI summarisation phase.
 */
function createAiProgressCallback(
  isTTY: boolean
): ((done: number, total: number, title: string) => void) | undefined {
  if (!isTTY) return undefined;

  return (done: number, total: number, title: string) => {
    if (total === 0 || (done === total && title === '')) {
      process.stdout.write(`\r${' '.repeat(process.stdout.columns ?? 80)}\r`);
      return;
    }
    const filled = total > 0 ? Math.round((done / total) * PROGRESS_WIDTH) : 0;
    const bar = '█'.repeat(filled) + '░'.repeat(PROGRESS_WIDTH - filled);
    const maxTitle = 38;
    const t = title.length > maxTitle ? title.slice(0, maxTitle - 1) + '…' : title;
    const line = `  [${bar}] ${done}/${total}  ${chalk.dim('✦')} ${chalk.dim('ai')} ${t}`;
    process.stdout.write(`\r${line.padEnd(process.stdout.columns ?? 80)}`);
  };
}

// ─── Output helpers ───────────────────────────────────────────────────────────

function printResults(results: SyncResult[], outputLevel?: string, outputFormat?: string): void {
  // J: machine-readable JSON output
  if (outputFormat === 'json') {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
    return;
  }
  const counts = { created: 0, updated: 0, pulled: 0, skipped: 0, conflict: 0, removed: 0, error: 0 };
  const quiet = outputLevel === 'quiet';

  for (const r of results) {
    counts[r.action]++;
    // In quiet mode, only print actionable results (skip the '= skipped' lines)
    if (quiet && r.action === 'skipped') continue;

    const idStr = r.azureId ? chalk.dim(` [#${r.azureId}]`) : '';
    const detailStr = r.detail ? chalk.dim(` — ${r.detail}`) : '';
    const filePart = r.filePath
      ? chalk.dim(path.relative(process.cwd(), r.filePath) + ':')
      : chalk.dim('(azure):');

    switch (r.action) {
      case 'created':
        console.log(`${chalk.green('+')} ${filePart} ${r.title}${idStr}`);
        break;
      case 'updated':
        console.log(`${chalk.blue('~')} ${filePart} ${r.title}${idStr}`);
        break;
      case 'pulled':
        console.log(`${chalk.cyan('↓')} ${filePart} ${r.title}${idStr}${detailStr}`);
        break;
      case 'skipped':
        console.log(`${chalk.dim('=')} ${filePart} ${chalk.dim(r.title)}${idStr}`);
        break;
      case 'conflict':
        console.log(`${chalk.yellow('!')} ${filePart} ${r.title}${idStr}${detailStr}`);
        break;
      case 'removed':
        console.log(`${chalk.magenta('−')} ${filePart} ${r.title}${idStr}${detailStr}`);
        break;
      case 'error':
        console.log(`${chalk.red('✗')} ${filePart} ${r.title}${idStr}${chalk.red(detailStr)}`);
        break;
    }
  }

  console.log('');
  const summary = [
    counts.created   && chalk.green(`${counts.created} created`),
    counts.updated   && chalk.blue(`${counts.updated} updated`),
    counts.pulled    && chalk.cyan(`${counts.pulled} pulled`),
    counts.skipped   && chalk.dim(`${counts.skipped} skipped`),
    counts.conflict  && chalk.yellow(`${counts.conflict} conflicts`),
    counts.removed   && chalk.magenta(`${counts.removed} removed`),
    counts.error     && chalk.red(`${counts.error} errors`),
  ].filter(Boolean).join(chalk.dim('  '));

  console.log(summary || chalk.dim('Nothing to sync.'));
}

// ─── validate ────────────────────────────────────────────────────────────────

program
  .command('validate')
  .description('Check config validity and Azure DevOps connectivity')
  .option('--config-override <path=value>', 'Override a config value (repeatable)', collect, [])
  .action(async (opts) => {
    const globalOpts = program.opts();
    const configPath = resolveConfigPath(globalOpts.config);
    console.log(chalk.bold('ado-sync validate'));
    console.log(chalk.dim(`Config: ${configPath}`));
    console.log('');

    // 1. Load config
    let config: SyncConfig;
    try {
      config = loadConfig(configPath);
      if (opts.configOverride?.length) applyOverrides(config, opts.configOverride);
      console.log(chalk.green('  ✓ Config is valid'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`  ✗ Config error: ${msg}`));
      process.exit(1);
    }

    // 2. Connect to Azure
    let client: AzureClient;
    try {
      client = await AzureClient.create(config);
      console.log(chalk.green(`  ✓ Azure connection established (${config.orgUrl})`));
    } catch (err: unknown) {
      console.log(chalk.red(`  ✗ Azure connection failed: ${formatError(err)}`));
      process.exit(1);
    }

    // 3. Verify project
    try {
      const coreApi = await client.getCoreApi();
      const project = await coreApi.getProject(config.project);
      if (!project) throw new Error('not found');
      console.log(chalk.green(`  ✓ Project "${config.project}" found`));
    } catch (err: unknown) {
      console.log(chalk.red(`  ✗ Project "${config.project}" not found: ${formatError(err)}`));
      process.exit(1);
    }

    // 4. Verify test plan(s)
    const plans = config.testPlans ?? [config.testPlan];
    const testPlanApi = await client.getTestPlanApi();
    let allPlansOk = true;
    for (const plan of plans) {
      try {
        const tp = await testPlanApi.getTestPlanById(config.project, plan.id);
        console.log(chalk.green(`  ✓ Test Plan ${plan.id} "${tp.name}" found`));
      } catch (err: unknown) {
        console.log(chalk.red(`  ✗ Test Plan ${plan.id} not found: ${formatError(err)}`));
        allPlansOk = false;
      }
    }

    if (!allPlansOk) process.exit(1);
    console.log('');
    console.log(chalk.green('All checks passed.'));
  });

// ─── diff ────────────────────────────────────────────────────────────────────

program
  .command('diff')
  .description('Show field-level diff between local specs and Azure DevOps')
  .option('--tags <expression>', 'Only check scenarios matching this tag expression')
  .option('--config-override <path=value>', 'Override a config value (repeatable)', collect, [])
  .option('--format <fmt>', 'Output format: text (default) or json')
  .option('--fail-on-drift', 'Exit with code 1 when any differences are found (useful as a CI quality gate)')
  .option('--ai-provider <provider>', 'AI provider for test step generation')
  .option('--ai-model <model>', 'AI model path or name')
  .option('--ai-url <url>', 'Base URL for AI endpoint')
  .option('--ai-key <key>', 'API key for AI provider')
  .action(async (opts) => {
    const globalOpts = program.opts();
    try {
      const configPath = resolveConfigPath(globalOpts.config);
      const config = loadConfig(configPath);
      if (opts.configOverride?.length) applyOverrides(config, opts.configOverride);
      const configDir = path.dirname(configPath);

      console.log(chalk.bold('ado-sync diff'));
      console.log(chalk.dim(`Config: ${configPath}`));
      if (opts.tags) console.log(chalk.dim(`Tags:   ${opts.tags}`));
      console.log('');

      const aiSummary = buildAiOpts(opts, config, configDir);
      const results = await status(config, configDir, { tags: opts.tags, aiSummary });

      // --format json or global --output json
      const outputFormat = opts.format ?? program.opts().output;
      if (outputFormat === 'json') {
        const diffs = results
          .filter((r) => r.action === 'updated' || r.action === 'conflict')
          .map((r) => ({
            action: r.action,
            azureId: r.azureId,
            title: r.title,
            filePath: r.filePath ? path.relative(process.cwd(), r.filePath) : '',
            changedFields: r.changedFields ?? [],
            diffDetail: r.diffDetail ?? [],
          }));
        process.stdout.write(JSON.stringify({ total: results.length, diffs }, null, 2) + '\n');
        if (opts.failOnDrift && diffs.length > 0) process.exit(1);
        return;
      }

      let anyDiff = false;
      for (const r of results) {
        if (r.action !== 'updated' && r.action !== 'conflict') continue;
        anyDiff = true;
        const idStr = r.azureId ? chalk.dim(` [#${r.azureId}]`) : '';
        const filePart = r.filePath ? chalk.dim(path.relative(process.cwd(), r.filePath) + ':') : '';
        const symbol = r.action === 'conflict' ? chalk.yellow('!') : chalk.blue('~');
        console.log(`${symbol} ${filePart} ${r.title}${idStr}`);
        if (r.changedFields?.length) {
          console.log(chalk.dim(`    changed fields: ${r.changedFields.join(', ')}`));
        }
        if (r.diffDetail?.length) {
          for (const d of r.diffDetail) {
            const local  = String(d.local).slice(0, 80).replace(/\n/g, '↵');
            const remote = String(d.remote).slice(0, 80).replace(/\n/g, '↵');
            console.log(chalk.dim(`    ${d.field}:`));
            console.log(chalk.green(`      local:  ${local}`));
            console.log(chalk.red(`      remote: ${remote}`));
          }
        } else if (r.detail) {
          console.log(chalk.dim(`    ${r.detail}`));
        }
      }
      if (!anyDiff) console.log(chalk.dim('No differences found.'));
      if (opts.failOnDrift && anyDiff) process.exit(1);
    } catch (err: unknown) {
      handleError(err);
    }
  });

// ─── generate ────────────────────────────────────────────────────────────────

program
  .command('generate')
  .description('Generate local spec files (or AI workflow manifests) from Azure DevOps User Stories')
  .option('--story-ids <ids>', 'Comma-separated ADO work item IDs (e.g. 1234,5678)')
  .option('--query <wiql>', 'WIQL query string to select stories')
  .option('--area-path <path>', 'Filter by area path')
  .option('--format <fmt>', 'Output format: gherkin or markdown (default: markdown)')
  .option('--output-folder <dir>', 'Where to write files (default: config pull.targetFolder or .)')
  .option('--manifest', 'Generate .ai-workflow-manifest-{id}.json instead of spec files')
  .option('--force', 'Overwrite existing files')
  .option('--dry-run', 'Show what would be created without writing files')
  .option('--config-override <path=value>', 'Override a config value (repeatable)', collect, [])
  .action(async (opts) => {
    const globalOpts = program.opts();
    try {
      const configPath = resolveConfigPath(globalOpts.config);
      const config = loadConfig(configPath);
      if (opts.configOverride?.length) applyOverrides(config, opts.configOverride);
      const configDir = path.dirname(configPath);
      const outputFormat = globalOpts.output;

      const storyIds = opts.storyIds
        ? opts.storyIds.split(',').map((s: string) => parseInt(s.trim(), 10)).filter(Boolean)
        : undefined;

      if (opts.manifest) {
        // ── Manifest mode ──────────────────────────────────────────────────────
        if (!storyIds?.length) {
          console.error(chalk.red('--story-ids is required with --manifest'));
          process.exit(1);
        }
        console.log(chalk.bold('ado-sync generate --manifest'));
        console.log(chalk.dim(`Config: ${configPath}`));
        if (opts.dryRun) console.log(chalk.yellow('Dry run — no files will be written'));
        console.log('');

        const results = await generateManifests(config, configDir, {
          storyIds,
          outputFolder: opts.outputFolder,
          format: opts.format,
          force: opts.force ?? false,
          dryRun: opts.dryRun ?? false,
        });

        if (outputFormat === 'json') {
          process.stdout.write(JSON.stringify(results, null, 2) + '\n');
          return;
        }

        for (const r of results) {
          const symbol = r.action === 'created' ? chalk.green('+') : chalk.dim('=');
          const relPath = path.relative(process.cwd(), r.filePath);
          console.log(`${symbol} [#${r.storyId}] ${relPath} — ${r.title}`);
          if (r.manifest && r.action === 'created') {
            console.log(chalk.dim(`    ${r.manifest.context.acceptanceCriteria.length} AC items · ${r.manifest.context.suggestedTags.join(' ')} · ${r.manifest.context.relatedTestCases.length} linked TCs`));
          }
        }
        console.log('');
        const created = results.filter((r) => r.action === 'created').length;
        const skipped = results.filter((r) => r.action === 'skipped').length;
        console.log([
          created && chalk.green(`${created} manifest${created !== 1 ? 's' : ''} created`),
          skipped && chalk.dim(`${skipped} skipped`),
        ].filter(Boolean).join(chalk.dim('  ')) || chalk.dim('Nothing to generate.'));
        return;
      }

      // ── Spec file mode ─────────────────────────────────────────────────────
      console.log(chalk.bold('ado-sync generate'));
      console.log(chalk.dim(`Config: ${configPath}`));
      if (opts.dryRun) console.log(chalk.yellow('Dry run — no files will be written'));
      console.log('');

      const results = await generateSpecs(config, configDir, {
        storyIds,
        query: opts.query,
        areaPath: opts.areaPath,
        format: opts.format,
        outputFolder: opts.outputFolder,
        force: opts.force ?? false,
        dryRun: opts.dryRun ?? false,
      });

      if (outputFormat === 'json') {
        process.stdout.write(JSON.stringify(results, null, 2) + '\n');
        return;
      }

      for (const r of results) {
        const symbol = r.action === 'created' ? chalk.green('+') : chalk.dim('=');
        const relPath = path.relative(process.cwd(), r.filePath);
        console.log(`${symbol} [#${r.storyId}] ${relPath} — ${r.title}`);
      }
      console.log('');
      const created = results.filter((r) => r.action === 'created').length;
      const skipped = results.filter((r) => r.action === 'skipped').length;
      console.log([
        created && chalk.green(`${created} created`),
        skipped && chalk.dim(`${skipped} skipped`),
      ].filter(Boolean).join(chalk.dim('  ')) || chalk.dim('Nothing to generate.'));
    } catch (err: unknown) {
      handleError(err);
    }
  });

// ─── story-context ────────────────────────────────────────────────────────────

program
  .command('story-context')
  .description('Show planner-agent context for an ADO User Story (AC items, suggested tags, linked TCs)')
  .requiredOption('--story-id <id>', 'ADO work item ID')
  .option('--config-override <path=value>', 'Override a config value (repeatable)', collect, [])
  .action(async (opts) => {
    const globalOpts = program.opts();
    try {
      const configPath = resolveConfigPath(globalOpts.config);
      const config = loadConfig(configPath);
      if (opts.configOverride?.length) applyOverrides(config, opts.configOverride);

      const { AzureClient } = await import('./azure/client');
      const { getStoryContext } = await import('./azure/work-items');
      const client = await AzureClient.create(config);
      const ctx = await getStoryContext(client, config.project, parseInt(opts.storyId, 10), config.orgUrl);

      if (globalOpts.output === 'json') {
        process.stdout.write(JSON.stringify(ctx, null, 2) + '\n');
        return;
      }

      console.log(chalk.bold(`Story #${ctx.storyId}: ${ctx.title}`));
      console.log(chalk.dim(`State: ${ctx.state ?? 'unknown'}  |  ${ctx.url}`));
      console.log('');

      if (ctx.acItems.length) {
        console.log(chalk.bold('Acceptance Criteria:'));
        ctx.acItems.forEach((item, i) => console.log(`  ${chalk.dim(`${i + 1}.`)} ${item}`));
        console.log('');
      }

      if (ctx.suggestedTags.length) {
        console.log(`${chalk.bold('Suggested tags:')}  ${ctx.suggestedTags.join('  ')}`);
      }
      if (ctx.suggestedActors.length) {
        console.log(`${chalk.bold('Actors:')}          ${ctx.suggestedActors.join(', ')}`);
      }
      if (ctx.relatedTestCases.length) {
        console.log(`${chalk.bold('Linked TCs:')}      ${ctx.relatedTestCases.map((id) => `#${id}`).join(', ')}`);
      } else {
        console.log(chalk.dim('No linked test cases yet.'));
      }
    } catch (err: unknown) {
      handleError(err);
    }
  });

// ─── stale ───────────────────────────────────────────────────────────────────

program
  .command('stale')
  .description('List Azure DevOps Test Cases that have no corresponding local spec')
  .option('--tags <expression>', 'Only consider local specs matching this tag expression')
  .option('--config-override <path=value>', 'Override a config value (repeatable)', collect, [])
  .action(async (opts) => {
    const globalOpts = program.opts();
    try {
      const configPath = resolveConfigPath(globalOpts.config);
      const config = loadConfig(configPath);
      if (opts.configOverride?.length) applyOverrides(config, opts.configOverride);
      const configDir = path.dirname(configPath);

      console.log(chalk.bold('ado-sync stale'));
      console.log(chalk.dim(`Config: ${configPath}`));
      if (opts.tags) console.log(chalk.dim(`Tags:   ${opts.tags}`));
      console.log('');

      const staleCases = await detectStaleTestCases(config, configDir, { tags: opts.tags });

      const outputFormat = globalOpts.output;
      if (outputFormat === 'json') {
        process.stdout.write(JSON.stringify(staleCases, null, 2) + '\n');
        return;
      }

      if (staleCases.length === 0) {
        console.log(chalk.green('No stale test cases found.'));
        return;
      }

      for (const tc of staleCases) {
        const tagsStr = tc.tags.length ? chalk.dim(`  [${tc.tags.join(', ')}]`) : '';
        console.log(`${chalk.yellow('?')} ${chalk.dim(`[#${tc.id}]`)} ${tc.title}${tagsStr}`);
      }
      console.log('');
      console.log(chalk.yellow(`${staleCases.length} stale test case${staleCases.length !== 1 ? 's' : ''} — not referenced by any local spec.`));
      console.log(chalk.dim('Run `ado-sync push` to tag them as ado-sync:removed, or delete them manually.'));
    } catch (err: unknown) {
      handleError(err);
    }
  });

// ─── coverage ────────────────────────────────────────────────────────────────

program
  .command('coverage')
  .description('Show spec link rate and story coverage for local specs vs Azure DevOps')
  .option('--tags <expression>', 'Only consider local specs matching this tag expression')
  .option('--config-override <path=value>', 'Override a config value (repeatable)', collect, [])
  .option('--fail-below <percent>', 'Exit with code 1 when spec link rate is below this threshold (0–100)')
  .action(async (opts) => {
    const globalOpts = program.opts();
    try {
      const configPath = resolveConfigPath(globalOpts.config);
      const config = loadConfig(configPath);
      if (opts.configOverride?.length) applyOverrides(config, opts.configOverride);
      const configDir = path.dirname(configPath);

      console.log(chalk.bold('ado-sync coverage'));
      console.log(chalk.dim(`Config: ${configPath}`));
      if (opts.tags) console.log(chalk.dim(`Tags:   ${opts.tags}`));
      console.log('');

      const report = await coverageReport(config, configDir, { tags: opts.tags });

      const outputFormat = globalOpts.output;
      if (outputFormat === 'json') {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      } else {
        const linkColor = report.specLinkRate >= 80 ? chalk.green : report.specLinkRate >= 50 ? chalk.yellow : chalk.red;
        console.log(chalk.bold('Spec link rate'));
        console.log(`  ${linkColor(`${report.specLinkRate}%`)}  ${chalk.dim(`(${report.linkedSpecs} of ${report.totalLocalSpecs} specs linked to Azure Test Cases)`)}`);
        if (report.unlinkedSpecs > 0) {
          console.log(`  ${chalk.dim(`${report.unlinkedSpecs} unlinked — run \`ado-sync push\` to create Azure Test Cases for them`)}`);
        }

        if (report.storiesReferenced.length > 0) {
          console.log('');
          const storyColor = report.storyCoverageRate >= 80 ? chalk.green : report.storyCoverageRate >= 50 ? chalk.yellow : chalk.red;
          console.log(chalk.bold('Story coverage'));
          console.log(`  ${storyColor(`${report.storyCoverageRate}%`)}  ${chalk.dim(`(${report.storiesCovered.length} of ${report.storiesReferenced.length} referenced stories have linked specs)`)}`);
          if (report.storiesUncovered.length > 0) {
            console.log(`  ${chalk.dim('Uncovered stories: ')}${report.storiesUncovered.map((id) => `#${id}`).join(', ')}`);
          }
        } else {
          console.log('');
          console.log(chalk.dim('No @story: tags found — add @story:ID tags to specs to track story coverage.'));
        }
      }

      const threshold = opts.failBelow ? parseInt(opts.failBelow, 10) : undefined;
      if (threshold !== undefined && report.specLinkRate < threshold) {
        console.error(chalk.red(`\nSpec link rate ${report.specLinkRate}% is below threshold ${threshold}%`));
        process.exit(1);
      }
    } catch (err: unknown) {
      handleError(err);
    }
  });

// ─── watch ────────────────────────────────────────────────────────────────────

program
  .command('watch')
  .description('Watch local spec files for changes and auto-push on save')
  .option('--dry-run', 'Show what would change without making any modifications')
  .option('--tags <expression>', 'Only sync scenarios matching this tag expression')
  .option('--debounce <ms>', 'Debounce delay in milliseconds before running push (default: 800)', '800')
  .option('--config-override <path=value>', 'Override a config value (repeatable)', collect, [])
  .option('--ai-provider <provider>', 'AI provider for test step generation')
  .option('--ai-model <model>', 'AI model path or name')
  .option('--ai-url <url>', 'Base URL for AI endpoint')
  .option('--ai-key <key>', 'API key for AI provider')
  .action(async (opts) => {
    const globalOpts = program.opts();
    try {
      const configPath = resolveConfigPath(globalOpts.config);
      const config = loadConfig(configPath);
      if (opts.configOverride?.length) applyOverrides(config, opts.configOverride);
      const configDir = path.dirname(configPath);
      const debounceMs = parseInt(opts.debounce ?? '800', 10);

      console.log(chalk.bold('ado-sync watch'));
      console.log(chalk.dim(`Config:  ${configPath}`));
      console.log(chalk.dim(`Project: ${config.project}`));
      console.log(chalk.dim(`Plan:    ${config.testPlan.id}`));
      if (opts.dryRun) console.log(chalk.yellow('Dry run — no changes will be made'));
      if (opts.tags) console.log(chalk.dim(`Tags:    ${opts.tags}`));
      console.log('');
      console.log(chalk.dim(`Watching ${configDir} for changes... (Ctrl+C to stop)`));
      console.log('');

      const aiSummary = buildAiOpts(opts, config, configDir);

      let debounceTimer: ReturnType<typeof setTimeout> | undefined;
      let running = false;

      const runPush = async () => {
        if (running) return;
        running = true;
        const ts = new Date().toLocaleTimeString();
        console.log(chalk.dim(`[${ts}] Change detected — running push...`));
        try {
          const isTTY = process.stdout.isTTY ?? false;
          const onProgress = createProgressCallback(isTTY);
          const results = await push(config, configDir, {
            dryRun: opts.dryRun,
            tags: opts.tags,
            onProgress,
            aiSummary,
          });
          if (isTTY) clearProgressLine();
          printResults(results, config.toolSettings?.outputLevel);
        } catch (err: unknown) {
          console.error(chalk.red(`Push failed: ${err instanceof Error ? err.message : String(err)}`));
        } finally {
          running = false;
        }
      };

      const onChange = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(runPush, debounceMs);
      };

      // Watch the config directory recursively for changes to spec files
      const watcher = fs.watch(configDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        // Only react to spec file changes, not the cache or config file itself
        const skipPatterns = ['.ado-sync-cache.json', 'ado-sync.json', 'ado-sync.yml', 'node_modules'];
        if (skipPatterns.some((p) => filename.includes(p))) return;
        onChange();
      });

      // Keep process alive
      process.on('SIGINT', () => {
        watcher.close();
        console.log('\n' + chalk.dim('Watch mode stopped.'));
        process.exit(0);
      });

      // Trigger an initial push on start
      await runPush();

    } catch (err: unknown) {
      handleError(err);
    }
  });

// ─── Run ─────────────────────────────────────────────────────────────────────

program.parse(process.argv);
