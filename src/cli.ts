#!/usr/bin/env node

import 'dotenv/config';

import chalk from 'chalk';
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

import { applyOverrides, CONFIG_TEMPLATE_JSON, CONFIG_TEMPLATE_YAML, loadConfig, resolveConfigPath } from './config';
import { pull, push, status } from './sync/engine';
import { SyncResult } from './types';
import pkg from '../package.json';

// ─── CLI definition ───────────────────────────────────────────────────────────

const program = new Command();

program
  .name('ado-sync')
  .description('Bidirectional sync between local test specs and Azure DevOps Test Cases')
  .version(pkg.version);

// Global option: --config / -c
program.option('-c, --config <path>', 'Path to config file (default: ado-sync.json)');

/** Collect repeatable option values into an array. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

// ─── init ─────────────────────────────────────────────────────────────────────

program
  .command('init [output]')
  .description('Generate a starter config file (default: ado-sync.json). Pass ado-sync.yml for YAML.')
  .action((output: string | undefined) => {
    const outFile = output ?? 'ado-sync.json';
    const outPath = path.resolve(outFile);
    if (fs.existsSync(outPath)) {
      console.error(chalk.red(`File already exists: ${outPath}`));
      process.exit(1);
    }
    const ext = path.extname(outFile).toLowerCase();
    const isYaml = ext === '.yml' || ext === '.yaml';
    fs.writeFileSync(outPath, isYaml ? CONFIG_TEMPLATE_YAML : CONFIG_TEMPLATE_JSON, 'utf8');
    console.log(chalk.green(`Created ${outPath}`));
    console.log(chalk.dim('Edit the file with your Azure DevOps details, then run:'));
    console.log(chalk.dim('  ado-sync push   (to create test cases from local specs)'));
    console.log(chalk.dim('  ado-sync pull   (to pull updates from Azure DevOps)'));
  });

// ─── push ─────────────────────────────────────────────────────────────────────

program
  .command('push')
  .description('Push local test specs to Azure DevOps (create or update test cases)')
  .option('--dry-run', 'Show what would change without making any modifications')
  .option('--tags <expression>', 'Only sync scenarios matching this tag expression (e.g. "@smoke and not @wip")')
  .option('--config-override <path=value>', 'Override a config value (repeatable, e.g. --config-override sync.tagPrefix=mytag)', collect, [])
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

      const results = await push(config, configDir, { dryRun: opts.dryRun, tags: opts.tags });
      printResults(results);
    } catch (err: any) {
      console.error(chalk.red(err.message));
      process.exit(1);
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

      const results = await pull(config, configDir, { dryRun: opts.dryRun, tags: opts.tags });
      printResults(results);
    } catch (err: any) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
  });

// ─── status ───────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show diff between local specs and Azure DevOps without making changes')
  .option('--tags <expression>', 'Only check scenarios matching this tag expression')
  .option('--config-override <path=value>', 'Override a config value (repeatable)', collect, [])
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

      const results = await status(config, configDir, { tags: opts.tags });
      printResults(results);
    } catch (err: any) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
  });

// ─── Output helpers ───────────────────────────────────────────────────────────

function printResults(results: SyncResult[]): void {
  const counts = { created: 0, updated: 0, pulled: 0, skipped: 0, conflict: 0, removed: 0, error: 0 };

  for (const r of results) {
    counts[r.action]++;
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

// ─── Run ─────────────────────────────────────────────────────────────────────

program.parse(process.argv);
