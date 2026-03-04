/**
 * Sync engine — orchestrates push, pull, and status operations.
 */

import * as fs from 'fs';
import { glob } from 'glob';
import parseTagExpression from '@cucumber/tag-expressions';
import { AzureClient } from '../azure/client';
import { createTestCase, getTestCase, updateTestCase } from '../azure/test-cases';
import { parseGherkinFile } from '../parsers/gherkin';
import { parseMarkdownFile } from '../parsers/markdown';
import { ParsedStep, ParsedTest, SyncConfig, SyncResult } from '../types';
import { writebackId } from './writeback';

// ─── Tag filtering ────────────────────────────────────────────────────────────

/**
 * Returns true when the test's tags satisfy the given tag expression.
 * Expression syntax mirrors Cucumber:  "@smoke and not @wip"
 * Tags in ParsedTest are stored without the leading @.
 * The expression evaluator expects them with @, so we re-add it here.
 */
function matchesTags(test: ParsedTest, expression: string): boolean {
  const node = parseTagExpression(expression);
  // Tags in ParsedTest have no leading '@'; tag-expressions evaluator needs them with '@'
  const tagsWithAt = test.tags.map((t) => (t.startsWith('@') ? t : `@${t}`));
  return node.evaluate(tagsWithAt);
}

// ─── File discovery ───────────────────────────────────────────────────────────

async function discoverFiles(config: SyncConfig, configDir: string): Promise<string[]> {
  const patterns = Array.isArray(config.local.include)
    ? config.local.include
    : [config.local.include];

  const excludes = config.local.exclude
    ? Array.isArray(config.local.exclude)
      ? config.local.exclude
      : [config.local.exclude]
    : [];

  const all: string[] = [];
  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: configDir,
      absolute: true,
      ignore: excludes,
    });
    all.push(...matches);
  }

  return [...new Set(all)].sort();
}

// ─── Local file parsing ───────────────────────────────────────────────────────

function parseLocalFiles(
  filePaths: string[],
  config: SyncConfig,
  tagsFilter?: string
): ParsedTest[] {
  const tagPrefix = config.sync?.tagPrefix ?? 'tc';
  const results: ParsedTest[] = [];

  for (const fp of filePaths) {
    try {
      const tests =
        config.local.type === 'gherkin'
          ? parseGherkinFile(fp, tagPrefix)
          : parseMarkdownFile(fp, tagPrefix);

      for (const t of tests) {
        if (tagsFilter && !matchesTags(t, tagsFilter)) continue;
        results.push(t);
      }
    } catch (err: any) {
      console.warn(`  [warn] Failed to parse ${fp}: ${err.message}`);
    }
  }

  return results;
}

// ─── Shared options ───────────────────────────────────────────────────────────

export interface SyncOpts {
  dryRun?: boolean;
  /** Cucumber tag expression to restrict which scenarios are synced.
   *  Examples:  "@smoke"   "@smoke and not @wip"   "not @manual"  */
  tags?: string;
}

// ─── Push ─────────────────────────────────────────────────────────────────────

export async function push(
  config: SyncConfig,
  configDir: string,
  opts: SyncOpts = {}
): Promise<SyncResult[]> {
  const files = await discoverFiles(config, configDir);
  const tests = parseLocalFiles(files, config, opts.tags);
  const client = await AzureClient.create(config);
  const tagPrefix = config.sync?.tagPrefix ?? 'tc';
  const results: SyncResult[] = [];

  for (const test of tests) {
    if (test.azureId) {
      try {
        const remote = await getTestCase(client, test.azureId);

        if (!remote) {
          results.push({
            action: 'error',
            filePath: test.filePath,
            title: test.title,
            azureId: test.azureId,
            detail: `Test case #${test.azureId} not found in Azure DevOps`,
          });
          continue;
        }

        const localStepsText = test.steps.map((s) => s.keyword + ' ' + s.text).join('\n');
        const remoteStepsText = remote.steps.map((s) => s.action).join('\n');
        const titleChanged = remote.title !== test.title;
        const stepsChanged = localStepsText !== remoteStepsText;

        if (!titleChanged && !stepsChanged) {
          results.push({ action: 'skipped', filePath: test.filePath, title: test.title, azureId: test.azureId });
          continue;
        }

        if (!opts.dryRun) {
          await updateTestCase(client, test.azureId, test, config);
        }
        results.push({ action: 'updated', filePath: test.filePath, title: test.title, azureId: test.azureId });
      } catch (err: any) {
        results.push({ action: 'error', filePath: test.filePath, title: test.title, azureId: test.azureId, detail: err.message });
      }
    } else {
      try {
        let newId: number | undefined;
        if (!opts.dryRun) {
          newId = await createTestCase(client, test, config);
          writebackId(test, newId, config.local.type, tagPrefix);
        }
        results.push({ action: 'created', filePath: test.filePath, title: test.title, azureId: newId });
      } catch (err: any) {
        results.push({ action: 'error', filePath: test.filePath, title: test.title, detail: err.message });
      }
    }
  }

  return results;
}

// ─── Pull ─────────────────────────────────────────────────────────────────────

export async function pull(
  config: SyncConfig,
  configDir: string,
  opts: SyncOpts = {}
): Promise<SyncResult[]> {
  const files = await discoverFiles(config, configDir);
  const tests = parseLocalFiles(files, config, opts.tags);
  const client = await AzureClient.create(config);
  const results: SyncResult[] = [];

  const linked = tests.filter((t) => t.azureId !== undefined);

  for (const test of linked) {
    try {
      const remote = await getTestCase(client, test.azureId!);

      if (!remote) {
        results.push({
          action: 'error',
          filePath: test.filePath,
          title: test.title,
          azureId: test.azureId,
          detail: `Test case #${test.azureId} not found in Azure DevOps`,
        });
        continue;
      }

      const titleChanged = remote.title !== test.title;
      const remoteStepsText = remote.steps.map((s) => s.action + '|' + s.expected).join('\n');
      const localStepsText = test.steps.map((s) => s.keyword + ' ' + s.text + '|' + (s.expected ?? '')).join('\n');
      const stepsChanged = remoteStepsText !== localStepsText;

      if (!titleChanged && !stepsChanged) {
        results.push({ action: 'skipped', filePath: test.filePath, title: test.title, azureId: test.azureId });
        continue;
      }

      if (!opts.dryRun) {
        applyRemoteToLocal(
          test,
          remote.title,
          remote.steps.map((s) => ({ keyword: 'Step', text: s.action, expected: s.expected })),
          config.local.type
        );
      }

      results.push({
        action: 'pulled',
        filePath: test.filePath,
        title: remote.title,
        azureId: test.azureId,
        detail: [titleChanged && 'title', stepsChanged && 'steps'].filter(Boolean).join(', ') + ' changed',
      });
    } catch (err: any) {
      results.push({ action: 'error', filePath: test.filePath, title: test.title, azureId: test.azureId, detail: err.message });
    }
  }

  return results;
}

// ─── Status ───────────────────────────────────────────────────────────────────

export async function status(
  config: SyncConfig,
  configDir: string,
  opts: Pick<SyncOpts, 'tags'> = {}
): Promise<SyncResult[]> {
  return push(config, configDir, { dryRun: true, tags: opts.tags });
}

// ─── Apply remote changes to local file ───────────────────────────────────────

function applyRemoteToLocal(
  test: ParsedTest,
  newTitle: string,
  newSteps: ParsedStep[],
  localType: 'gherkin' | 'markdown'
): void {
  if (localType === 'gherkin') {
    applyRemoteToGherkin(test, newTitle, newSteps);
  } else {
    applyRemoteToMarkdown(test, newTitle, newSteps);
  }
}

function applyRemoteToGherkin(test: ParsedTest, newTitle: string, newSteps: ParsedStep[]): void {
  const raw = fs.readFileSync(test.filePath, 'utf8');
  const lines = raw.split('\n');
  const scenarioLineIdx = test.line - 1;

  lines[scenarioLineIdx] = lines[scenarioLineIdx].replace(
    /^(\s*Scenario(?:\s+Outline)?:\s*)(.*)$/,
    `$1${newTitle}`
  );

  const stepStart = scenarioLineIdx + 1;
  let stepEnd = stepStart;
  while (stepEnd < lines.length) {
    const l = lines[stepEnd].trim();
    if (!l || /^(Scenario|Feature|Background|Examples|@)/.test(l) || /^---/.test(l)) break;
    stepEnd++;
  }

  const stepLines = newSteps.map((s) => `    ${s.keyword} ${s.text}`);
  lines.splice(stepStart, stepEnd - stepStart, ...stepLines);

  fs.writeFileSync(test.filePath, lines.join('\n'), 'utf8');
}

function applyRemoteToMarkdown(test: ParsedTest, newTitle: string, newSteps: ParsedStep[]): void {
  const raw = fs.readFileSync(test.filePath, 'utf8');
  const lines = raw.split('\n');
  const headingLineIdx = test.line - 1;

  lines[headingLineIdx] = lines[headingLineIdx].replace(
    /^(###\s+(?:\d+\.\s+)?)(.*)$/,
    `$1${newTitle}`
  );

  const STEPS_RE = /^steps\s*:/i;
  const EXPECTED_RE = /^expected\s+results?\s*:/i;
  const SEPARATOR_RE = /^---+\s*$/;
  const HEADING_RE = /^#{1,6}\s/;

  let stepsStart = -1;
  let stepsEnd = -1;
  let expectedStart = -1;

  for (let i = headingLineIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (HEADING_RE.test(lines[i]) || SEPARATOR_RE.test(trimmed)) {
      if (stepsStart !== -1 && stepsEnd === -1) stepsEnd = i;
      break;
    }
    if (STEPS_RE.test(trimmed)) { stepsStart = i; continue; }
    if (EXPECTED_RE.test(trimmed)) {
      if (stepsEnd === -1 && stepsStart !== -1) stepsEnd = i;
      expectedStart = i;
      continue;
    }
  }

  const newStepLines = newSteps.map((s, idx) => `${idx + 1}. ${s.text}`);

  if (stepsStart !== -1 && stepsEnd !== -1) {
    lines.splice(stepsStart, stepsEnd - stepsStart, 'Steps:', ...newStepLines);
  }

  // Recalculate after splice
  const updatedLines = lines.join('\n').split('\n');
  let newExpStart = -1;
  let newExpEnd = -1;

  if (expectedStart !== -1) {
    for (let i = headingLineIdx + 1; i < updatedLines.length; i++) {
      const trimmed = updatedLines[i].trim();
      if (HEADING_RE.test(updatedLines[i]) || SEPARATOR_RE.test(trimmed)) {
        if (newExpStart !== -1 && newExpEnd === -1) newExpEnd = i;
        break;
      }
      if (EXPECTED_RE.test(trimmed)) { newExpStart = i; continue; }
    }

    const lastExpected = [...newSteps].reverse().find((s) => s.expected)?.expected;
    if (newExpStart !== -1 && newExpEnd !== -1 && lastExpected) {
      const expLines = lastExpected.split('\n').map((l) => `- ${l.trim()}`).filter((l) => l.length > 2);
      updatedLines.splice(newExpStart, newExpEnd - newExpStart, 'Expected results:', ...expLines);
    }
  }

  fs.writeFileSync(test.filePath, updatedLines.join('\n'), 'utf8');
}
