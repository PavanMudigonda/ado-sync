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
import { AiSummaryOpts, detectAiEnvironment } from './ai/summarizer';
import { AzureClient } from './azure/client';
import { applyOverrides, CONFIG_TEMPLATE_JSON, CONFIG_TEMPLATE_YAML, loadConfig, resolveConfigPath } from './config';
import { coverageReport, detectStaleTestCases, pull, push, status } from './sync/engine';
import { generateSpecs, loadGenerateContextContent } from './sync/generate';
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
 *
 * Fallback chain: CLI flags → config file → auto-detected AI environment → 'local'.
 * When running inside an AI assistant terminal (Claude Code, Codex, Copilot, Cursor),
 * the environment is detected automatically and the appropriate provider/key is used
 * without requiring explicit --ai-provider or --ai-key flags.
 */
function buildAiOpts(
  opts: { aiProvider?: string; aiModel?: string; aiUrl?: string; aiKey?: string; aiRegion?: string; aiContext?: string },
  config?: SyncConfig,
  configDir?: string
): AiSummaryOpts | undefined {
  const cfgAi = config?.sync?.ai;
  // CLI --ai-provider none wins over config; config provider='none' also disables
  const explicitProvider = opts.aiProvider ?? cfgAi?.provider;
  const detected = !explicitProvider ? detectAiEnvironment() : undefined;
  const provider = explicitProvider ?? (cfgAi?.model ? 'local' : undefined) ?? detected?.provider ?? 'local';
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

  // Use auto-detected API key as fallback when no explicit key is configured
  const apiKey = opts.aiKey ?? cfgAi?.apiKey ?? detected?.apiKey;

  return {
    provider: provider as AiSummaryOpts['provider'],
    model,
    baseUrl:  opts.aiUrl    ?? cfgAi?.baseUrl,
    apiKey,
    region:   opts.aiRegion ?? cfgAi?.region,
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
    const ext = path.extname(outFile).toLowerCase();
    const isYaml = ext === '.yml' || ext === '.yaml';

    try {
      const fd = fs.openSync(outPath, 'wx');
      // K: interactive wizard when stdin is a TTY and --no-interactive is not set
      if (opts.interactive && process.stdin.isTTY) {
        const answers = await runInitWizard(isYaml);
        fs.writeFileSync(fd, answers, 'utf8');
      } else {
        fs.writeFileSync(fd, isYaml ? CONFIG_TEMPLATE_YAML : CONFIG_TEMPLATE_JSON, 'utf8');
      }
      fs.closeSync(fd);
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        console.error(chalk.red(`File already exists: ${outPath}`));
        process.exit(1);
      }
      throw err;
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
  .option('--ai-provider <provider>', 'AI provider: local (node-llama-cpp), heuristic, ollama, openai, anthropic, huggingface, bedrock, azureai, none (disable)')
  .option('--ai-model <model>', 'local: GGUF path; ollama: model tag; openai/anthropic/huggingface/bedrock/azureai: model name or id')
  .option('--ai-url <url>', 'Base URL for ollama, OpenAI-compatible, or Azure OpenAI endpoint')
  .option('--ai-key <key>', 'API key for openai / anthropic / huggingface / azureai ($ENV_VAR reference supported)')
  .option('--ai-region <region>', 'AWS region for bedrock provider (default: AWS_REGION env or us-east-1)')
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
  .option('--ai-provider <provider>', 'AI provider: local (node-llama-cpp), heuristic, ollama, openai, anthropic, huggingface, bedrock, azureai, none (disable)')
  .option('--ai-model <model>', 'local: GGUF path; ollama: model tag; openai/anthropic/huggingface/bedrock/azureai: model name or id')
  .option('--ai-url <url>', 'Base URL for ollama, OpenAI-compatible, or Azure OpenAI endpoint')
  .option('--ai-key <key>', 'API key for openai / anthropic / huggingface / azureai ($ENV_VAR reference supported)')
  .option('--ai-region <region>', 'AWS region for bedrock provider (default: AWS_REGION env or us-east-1)')
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
  .option('--testConfiguration <nameOrId>', 'Azure test configuration name or numeric ID for the published run')
  .option('--testSuite <nameOrId>', 'Azure test suite name or numeric ID for planned run publication')
  .option('--testPlan <nameOrId>', 'Azure test plan name or numeric ID used with --testSuite')
  .option('--dry-run', 'Parse results and show summary without publishing')
  .option('--create-issues-on-failure', 'File GitHub Issues or ADO Bugs for each failed test')
  .option('--issue-provider <provider>', 'Issue provider: github (default) or ado')
  .option('--github-repo <owner/repo>', 'GitHub repository to file issues in (e.g. "myorg/myrepo")')
  .option('--github-token <token>', 'GitHub token ($ENV_VAR reference supported)')
  .option('--bug-threshold <percent>', 'Failure % above which one env-failure issue is filed instead of per-test (default: 20)')
  .option('--max-issues <n>', 'Hard cap on issues filed per run (default: 50)')
  .option('--analyze-failures', 'Use AI to analyse each failed result and post a root-cause comment on the Azure test result')
  .option('--ai-provider <provider>', 'AI provider for failure analysis: ollama, openai, anthropic, huggingface, bedrock, azureai')
  .option('--ai-model <model>', 'Model name, tag, or id for the AI provider')
  .option('--ai-url <url>', 'Base URL for ollama, OpenAI-compatible, or Azure OpenAI endpoint')
  .option('--ai-key <key>', 'API key for openai / anthropic / huggingface / azureai ($ENV_VAR reference supported)')
  .option('--ai-region <region>', 'AWS region for bedrock provider (default: AWS_REGION env or us-east-1)')
  .option('--config-override <path=value>', 'Override a config value (repeatable)', collect, [])
  .action(async (opts) => {
    const globalOpts = program.opts();
    try {
      const configPath = resolveConfigPath(globalOpts.config);
      const config = loadConfig(configPath);
      const cliPublishOverrides = [
        ...(opts.testConfiguration ? [/^\d+$/.test(opts.testConfiguration)
          ? `publishTestResults.testConfiguration.id=${opts.testConfiguration}`
          : `publishTestResults.testConfiguration.name=${opts.testConfiguration}`] : []),
        ...(opts.testSuite ? [/^\d+$/.test(opts.testSuite)
          ? `publishTestResults.testSuite.id=${opts.testSuite}`
          : `publishTestResults.testSuite.name=${opts.testSuite}`] : []),
        ...(opts.testPlan ? [/^\d+$/.test(opts.testPlan)
          ? `publishTestResults.testSuite.testPlan=${opts.testPlan}`
          : `publishTestResults.testSuite.testPlan=${opts.testPlan}`] : []),
      ];
      const configOverrides = [...(opts.configOverride ?? []), ...cliPublishOverrides];
      if (configOverrides.length) applyOverrides(config, configOverrides);
      const configDir = path.dirname(configPath);

      console.log(chalk.bold('ado-sync publish-test-results'));
      console.log(chalk.dim(`Config: ${configPath}`));
      if (opts.dryRun) console.log(chalk.yellow('Dry run — no changes will be made'));
      console.log('');

      // Build AI opts if --analyze-failures is set or config.sync.ai.analyzeFailures is true
      const wantAnalysis = opts.analyzeFailures || config.sync?.ai?.analyzeFailures;
      const aiProvider = opts.aiProvider ?? config.sync?.ai?.provider;
      let aiOpts: AiSummaryOpts | undefined;
      if (wantAnalysis && aiProvider && aiProvider !== 'none' && aiProvider !== 'heuristic' && aiProvider !== 'local') {
        aiOpts = {
          provider: aiProvider as AiSummaryOpts['provider'],
          model:    opts.aiModel   ?? config.sync?.ai?.model,
          baseUrl:  opts.aiUrl     ?? config.sync?.ai?.baseUrl,
          apiKey:   opts.aiKey     ?? config.sync?.ai?.apiKey,
          region:   opts.aiRegion  ?? config.sync?.ai?.region,
        };
      } else if (wantAnalysis && !aiProvider) {
        process.stderr.write(chalk.yellow('  [warn] --analyze-failures requires --ai-provider (ollama, openai, or anthropic). Skipping analysis.\n'));
      }

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
          ...(opts.githubToken    && { token:       opts.githubToken.startsWith('$') ? (process.env[opts.githubToken.slice(1)] ?? opts.githubToken) : opts.githubToken }),
          ...(opts.bugThreshold   && { threshold:   parseInt(opts.bugThreshold) }),
          ...(opts.maxIssues      && { maxIssues:   parseInt(opts.maxIssues) }),
        },
        aiOpts,
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
  .option('--ai-provider <provider>', 'AI provider: local | ollama | openai | anthropic | huggingface | bedrock | azureai')
  .option('--ai-model <model>', 'Model name/path/id for the AI provider')
  .option('--ai-key <key>', 'API key for the AI provider (or $ENV_VAR reference)')
  .option('--ai-url <url>', 'Base URL override for the AI provider endpoint')
  .option('--ai-region <region>', 'AWS region for bedrock provider (default: AWS_REGION env or us-east-1)')
  .option('--ai-context <path>', 'Additional AI context file, folder, or glob for generate (repeatable)', collect, [])
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

      // Build AI opts: CLI flags → config.sync.ai (generate.ts handles the config fallback too,
      // but constructing via buildAiOpts here gives the CLI consistent env-var resolution)
      const generateProvider = opts.aiProvider
        ?? (config.sync?.ai?.provider && config.sync.ai.provider !== 'heuristic' ? config.sync.ai.provider : undefined)
        ?? (config.sync?.ai?.model ? 'local' : undefined);
      const generateContextSources = opts.aiContext?.length
        ? opts.aiContext
        : (config.sync?.ai?.contextFile ? [config.sync.ai.contextFile] : undefined);
      const generateContextContent = loadGenerateContextContent(generateContextSources, configDir);

      const aiOpts = generateProvider
        ? (() => {
            const base = buildAiOpts({ ...opts, aiContext: undefined }, config, configDir);
            if (!base) return undefined;
            return {
              provider: base.provider as import('./ai/generate-spec').AiGenerateProvider,
              model:    base.model,
              apiKey:   base.apiKey,
              baseUrl:  base.baseUrl,
              region:   base.region,
              contextContent: generateContextContent,
            };
          })()
        : undefined;

      const results = await generateSpecs(config, configDir, {
        storyIds,
        query: opts.query,
        areaPath: opts.areaPath,
        format: opts.format,
        outputFolder: opts.outputFolder,
        force: opts.force ?? false,
        dryRun: opts.dryRun ?? false,
        aiOpts,
      });

      if (outputFormat === 'json') {
        process.stdout.write(JSON.stringify(results, null, 2) + '\n');
        return;
      }

      for (const r of results) {
        const symbol = r.action === 'created' ? chalk.green('+') : chalk.dim('=');
        const relPath = path.relative(process.cwd(), r.filePath);
        console.log(`${symbol} [#${r.storyId}] ${relPath} — ${r.title}`);
        if (r.preview) {
          console.log(chalk.dim('  ┌─ preview ─────────────────────────────'));
          for (const line of r.preview.split('\n')) {
            console.log(chalk.dim(`  │ ${line}`));
          }
          console.log(chalk.dim('  └───────────────────────────────────────'));
        }
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

// ─── ac-gate ─────────────────────────────────────────────────────────────────

program
  .command('ac-gate')
  .description('Validate that ADO User Stories have Acceptance Criteria and linked Test Cases (CI quality gate)')
  .option('--story-ids <ids>', 'Comma-separated ADO work item IDs to validate (e.g. 1234,5678)')
  .option('--query <wiql>', 'WIQL query string to select stories (overrides --story-ids)')
  .option('--area-path <path>', 'Validate all User Stories under this area path (overrides --story-ids)')
  .option('--states <states>', 'Comma-separated story states to include (default: Active,Resolved,Closed)')
  .option('--fail-on-no-ac', 'Exit 1 only for stories without Acceptance Criteria (no-ac), not just missing TCs')
  .option('--config-override <path=value>', 'Override a config value (repeatable)', collect, [])
  .action(async (opts) => {
    const globalOpts = program.opts();
    try {
      const configPath = resolveConfigPath(globalOpts.config);
      const config = loadConfig(configPath);
      if (opts.configOverride?.length) applyOverrides(config, opts.configOverride);

      const { AzureClient } = await import('./azure/client');
      const { acGate, getWorkItemsByQuery, getWorkItemsByAreaPath } = await import('./azure/work-items');
      const client = await AzureClient.create(config);

      let storyIds: number[] = [];

      if (opts.query) {
        const stories = await getWorkItemsByQuery(client, config.project, opts.query);
        storyIds = stories.map((s: any) => s.id);
      } else if (opts.areaPath) {
        const stories = await getWorkItemsByAreaPath(client, config.project, opts.areaPath);
        storyIds = stories.map((s: any) => s.id);
      } else if (opts.storyIds) {
        storyIds = opts.storyIds.split(',').map((s: string) => parseInt(s.trim(), 10)).filter(Boolean);
      } else {
        // Default: all active stories in project
        const states = opts.states ?? 'Active,Resolved,Closed';
        const stateList = states.split(',').map((s: string) => `'${s.trim()}'`).join(',');
        const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${config.project.replace(/'/g, "''")}' AND [System.WorkItemType] = 'User Story' AND [System.State] IN (${stateList}) ORDER BY [System.Id]`;
        const stories = await getWorkItemsByQuery(client, config.project, wiql);
        storyIds = stories.map((s: any) => s.id);
      }

      if (storyIds.length === 0) {
        console.log(chalk.yellow('No stories found to validate.'));
        return;
      }

      console.log(chalk.bold('ado-sync ac-gate'));
      console.log(chalk.dim(`Config:  ${configPath}`));
      console.log(chalk.dim(`Stories: ${storyIds.length} to validate`));
      console.log('');

      const report = await acGate(client, config.project, storyIds, config.orgUrl);

      const outputFormat = globalOpts.output;
      if (outputFormat === 'json') {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      } else {
        for (const r of report.passed) {
          console.log(`${chalk.green('✓')} ${chalk.dim(`[#${r.storyId}]`)} ${r.title}  ${chalk.dim(`(${r.acCount} AC, ${r.linkedTcs.length} TC)`)}`);
        }
        for (const r of report.failed) {
          const reason = r.outcome === 'no-ac'
            ? chalk.red('no acceptance criteria')
            : chalk.yellow('no linked test cases');
          console.log(`${chalk.red('✗')} ${chalk.dim(`[#${r.storyId}]`)} ${r.title}  — ${reason}  ${chalk.dim(r.url)}`);
        }
        console.log('');
        if (report.failed.length === 0) {
          console.log(chalk.green(`All ${report.passed.length} stories passed the AC gate.`));
        } else {
          console.log(chalk.red(`${report.failed.length} of ${storyIds.length} stories failed the AC gate.`));
          const noAc = report.failed.filter((r) => r.outcome === 'no-ac').length;
          const noTc = report.failed.filter((r) => r.outcome === 'no-tc').length;
          if (noAc) console.log(chalk.dim(`  ${noAc} missing acceptance criteria — add AC in Azure DevOps`));
          if (noTc) console.log(chalk.dim(`  ${noTc} missing test cases        — run \`ado-sync push\` to create them`));
        }
      }

      if (report.exitCode !== 0) process.exit(report.exitCode);
    } catch (err: unknown) {
      handleError(err);
    }
  });

// ─── stale ───────────────────────────────────────────────────────────────────

program
  .command('stale')
  .description('List Azure DevOps Test Cases that have no corresponding local spec')
  .option('--tags <expression>', 'Only consider local specs matching this tag expression')
  .option('--retire', 'Automatically transition stale Test Cases to Closed state and tag ado-sync:retired')
  .option('--retire-state <state>', 'Target state when retiring (default: Closed)', 'Closed')
  .option('--dry-run', 'Show what --retire would do without making changes')
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
      if (opts.tags)  console.log(chalk.dim(`Tags:   ${opts.tags}`));
      if (opts.retire) console.log(chalk.dim(`Retire: will transition to "${opts.retireState}"${opts.dryRun ? ' (dry-run)' : ''}`));
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

      if (opts.retire) {
        const { retireTestCase } = await import('./azure/test-cases');
        const { AzureClient } = await import('./azure/client');
        const client = await AzureClient.create(config);

        let retired = 0;
        let failed  = 0;
        for (const tc of staleCases) {
          if (opts.dryRun) {
            console.log(chalk.dim(`  [dry-run] would retire #${tc.id} → ${opts.retireState}`));
            continue;
          }
          try {
            await retireTestCase(client, tc.id, opts.retireState);
            console.log(`${chalk.green('↓')} Retired  ${chalk.dim(`[#${tc.id}]`)} ${tc.title}`);
            retired++;
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.log(`${chalk.red('✗')} Failed   ${chalk.dim(`[#${tc.id}]`)} ${tc.title}  — ${msg}`);
            failed++;
          }
        }
        console.log('');
        if (!opts.dryRun) {
          if (retired > 0) console.log(chalk.green(`${retired} test case${retired !== 1 ? 's' : ''} retired → ${opts.retireState}.`));
          if (failed  > 0) console.log(chalk.red(`${failed} retirement${failed !== 1 ? 's' : ''} failed — check permissions.`));
        }
      } else {
        console.log(chalk.dim('Run `ado-sync stale --retire` to close them in Azure DevOps, or `ado-sync push` to tag them as ado-sync:removed.'));
      }
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

// ─── trend ────────────────────────────────────────────────────────────────────

program
  .command('trend')
  .description('Analyse historical test run results to detect flaky tests and failing patterns')
  .option('--days <n>', 'How many days of history to analyse (default: 30)', '30')
  .option('--max-runs <n>', 'Maximum number of test runs to sample (default: 50)', '50')
  .option('--top <n>', 'How many top-failing tests to show (default: 10)', '10')
  .option('--run-name <filter>', 'Only include runs whose name contains this string')
  .option('--webhook-url <url>', 'Post a summary to this webhook URL')
  .option('--webhook-type <type>', 'Webhook type: slack (default), teams, or generic', 'slack')
  .option('--fail-on-flaky', 'Exit with code 1 when any flaky tests are detected')
  .option('--fail-below <percent>', 'Exit with code 1 when overall pass rate is below this threshold (0–100)')
  .option('--config-override <path=value>', 'Override a config value (repeatable)', collect, [])
  .action(async (opts) => {
    const globalOpts = program.opts();
    try {
      const configPath = resolveConfigPath(globalOpts.config);
      const config = loadConfig(configPath);
      if (opts.configOverride?.length) applyOverrides(config, opts.configOverride);

      const { trendReport, postTrendToWebhook } = await import('./azure/test-runs');

      console.log(chalk.bold('ado-sync trend'));
      console.log(chalk.dim(`Config:  ${configPath}`));
      console.log(chalk.dim(`Period:  last ${opts.days} days  (max ${opts.maxRuns} runs)`));
      console.log('');

      const report = await trendReport(config, {
        days:          parseInt(opts.days,    10),
        maxRuns:       parseInt(opts.maxRuns, 10),
        topN:          parseInt(opts.top,     10),
        runNameFilter: opts.runName,
      });

      const outputFormat = globalOpts.output;
      if (outputFormat === 'json') {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      } else {
        const passColor = report.overallPassRate >= 90 ? chalk.green : report.overallPassRate >= 70 ? chalk.yellow : chalk.red;
        console.log(chalk.bold('Overall pass rate'));
        console.log(`  ${passColor(`${report.overallPassRate}%`)}  ${chalk.dim(`(${report.totalPassed} passed / ${report.totalFailed} failed across ${report.runsAnalyzed} runs)`)}`);
        console.log('');

        if (report.flakyTests.length > 0) {
          console.log(chalk.bold(`Flaky tests  (${report.flakyTests.length} detected)`));
          for (const t of report.flakyTests.slice(0, parseInt(opts.top, 10))) {
            const tcTag = t.testCaseId ? chalk.dim(` [#${t.testCaseId}]`) : '';
            console.log(`  ${chalk.yellow('~')}${tcTag} ${t.testName.slice(0, 70)}  ${chalk.dim(`${t.passRate}% pass  (${t.passed}✓ ${t.failed}✗)`)}`);
          }
          console.log('');
        } else {
          console.log(chalk.green('No flaky tests detected.'));
          console.log('');
        }

        if (report.topFailingTests.length > 0) {
          console.log(chalk.bold(`Top failing tests`));
          for (const t of report.topFailingTests) {
            const tcTag = t.testCaseId ? chalk.dim(` [#${t.testCaseId}]`) : '';
            console.log(`  ${chalk.red('✗')}${tcTag} ${t.testName.slice(0, 70)}  ${chalk.dim(`${t.failed} failure${t.failed !== 1 ? 's' : ''}  (${t.passRate}% pass)`)}`);
          }
          console.log('');
        }
      }

      if (opts.webhookUrl) {
        const webhookType = opts.webhookType ?? 'slack';
        if (!['slack', 'teams', 'generic'].includes(webhookType)) {
          throw new Error(`Unknown --webhook-type "${webhookType}". Use slack, teams, or generic.`);
        }
        await postTrendToWebhook(report, { type: webhookType as 'slack' | 'teams' | 'generic', webhookUrl: opts.webhookUrl });
        console.log(chalk.dim(`Summary posted to ${webhookType} webhook.`));
      }

      if (opts.failOnFlaky && report.flakyTests.length > 0) {
        console.error(chalk.red(`\n${report.flakyTests.length} flaky test${report.flakyTests.length !== 1 ? 's' : ''} detected.`));
        process.exit(1);
      }

      const threshold = opts.failBelow ? parseInt(opts.failBelow, 10) : undefined;
      if (threshold !== undefined && report.overallPassRate < threshold) {
        console.error(chalk.red(`\nOverall pass rate ${report.overallPassRate}% is below threshold ${threshold}%`));
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

// ─── find-tagged ──────────────────────────────────────────────────────────────

program
  .command('find-tagged')
  .description('Find work items where a specific tag was added in the last N hours or days')
  .requiredOption('--tag <name>', 'The tag to search for (e.g. "regression" or "my-label")')
  .option('--hours <n>', 'Find items where the tag was added in the last N hours')
  .option('--days <n>', 'Find items where the tag was added in the last N days')
  .option('--work-item-type <type>', 'Work item type to search (default: "User Story")', 'User Story')
  .option('--config-override <path=value>', 'Override a config value (repeatable)', collect, [])
  .action(async (opts) => {
    const globalOpts = program.opts();
    try {
      const configPath = resolveConfigPath(globalOpts.config);
      const config = loadConfig(configPath);
      if (opts.configOverride?.length) applyOverrides(config, opts.configOverride);

      if (!opts.hours && !opts.days) {
        console.error(chalk.red('Specify a time window: --hours <n> or --days <n>'));
        process.exit(1);
      }

      const windowHours = opts.hours
        ? parseFloat(opts.hours)
        : parseFloat(opts.days) * 24;

      if (isNaN(windowHours) || windowHours <= 0) {
        console.error(chalk.red('Time window must be a positive number.'));
        process.exit(1);
      }

      const since = new Date(Date.now() - windowHours * 3600 * 1000);

      const windowLabel = opts.hours
        ? `${opts.hours} hour${parseFloat(opts.hours) !== 1 ? 's' : ''}`
        : `${opts.days} day${parseFloat(opts.days) !== 1 ? 's' : ''}`;

      const outputFormat = globalOpts.output;
      const log = outputFormat === 'json'
        ? (...args: any[]) => process.stderr.write(args.join(' ') + '\n')
        : console.log.bind(console);

      log(chalk.bold('ado-sync find-tagged'));
      log(chalk.dim(`Config:   ${configPath}`));
      log(chalk.dim(`Tag:      ${opts.tag}`));
      const typeLabel = opts.workItemType.split(',').map((t: string) => t.trim()).join(', ');
      log(chalk.dim(`Type:     ${typeLabel}`));
      log(chalk.dim(`Window:   last ${windowLabel}  (since ${since.toISOString()})`));
      log('');

      const { AzureClient } = await import('./azure/client');
      const { findStoriesByTagAddedSince } = await import('./azure/work-items');
      const client = await AzureClient.create(config);

      const results = await findStoriesByTagAddedSince(
        client,
        config.project,
        opts.tag,
        since,
        config.orgUrl,
        opts.workItemType,
      );

      if (outputFormat === 'json') {
        process.stdout.write(JSON.stringify(results, null, 2) + '\n');
        return;
      }

      if (results.length === 0) {
        console.log(chalk.dim(`No ${typeLabel} items found where tag "${opts.tag}" was added in the last ${windowLabel}.`));
        return;
      }

      for (const r of results) {
        const addedDate  = new Date(r.tagAddedAt);
        const dateStr    = addedDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        const timeStr    = addedDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const byStr      = r.tagAddedBy ? chalk.dim(` by ${r.tagAddedBy}`) : '';
        const stateStr   = r.state      ? chalk.dim(` [${r.state}]`)       : '';
        const revStr     = chalk.dim(` (rev ${r.tagAddedRevision})`);
        console.log(`${chalk.green('+')} ${chalk.dim(`[#${r.id}]`)}${stateStr} ${r.title}`);
        console.log(`   ${chalk.cyan('Tag added:')} ${dateStr} ${timeStr}${byStr}${revStr}`);
        console.log(chalk.dim(`   ${r.url}`));
        console.log('');
      }

      console.log(chalk.green(`${results.length} item${results.length !== 1 ? 's' : ''} found where "${opts.tag}" was added in the last ${windowLabel}.`));
    } catch (err: unknown) {
      handleError(err);
    }
  });

// ─── Run ─────────────────────────────────────────────────────────────────────

program.parse(process.argv);
