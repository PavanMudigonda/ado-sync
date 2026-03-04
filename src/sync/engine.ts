/**
 * Sync engine — orchestrates push, pull, and status operations.
 */

import parseTagExpression from '@cucumber/tag-expressions';
import * as fs from 'fs';
import { glob } from 'glob';

import { AzureClient } from '../azure/client';
import {
  createTestCase,
  getOrCreateSuiteForFile,
  getTestCase,
  getTestCasesInSuite,
  tagTestCaseAsRemoved,
  updateTestCase,
} from '../azure/test-cases';
import { parseGherkinFile } from '../parsers/gherkin';
import { parseMarkdownFile } from '../parsers/markdown';
import { ParsedStep, ParsedTest, SyncConfig, SyncResult, TestPlanEntry } from '../types';
import { CacheEntry, hashSteps, hashString, loadCache, saveCache,SyncCache } from './cache';
import { writebackId } from './writeback';

// ─── Tag filtering ────────────────────────────────────────────────────────────

function matchesTags(test: ParsedTest, expression: string): boolean {
  const node = parseTagExpression(expression);
  const tagsWithAt = test.tags.map((t) => (t.startsWith('@') ? t : `@${t}`));
  return node.evaluate(tagsWithAt);
}

// ─── File discovery ───────────────────────────────────────────────────────────

async function discoverFiles(
  include: string | string[],
  exclude: string | string[] | undefined,
  configDir: string
): Promise<string[]> {
  const patterns = Array.isArray(include) ? include : [include];
  const excludes = exclude
    ? Array.isArray(exclude)
      ? exclude
      : [exclude]
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
  const linkConfigs = config.sync?.links;
  const results: ParsedTest[] = [];

  for (const fp of filePaths) {
    try {
      const tests =
        config.local.type === 'gherkin'
          ? parseGherkinFile(fp, tagPrefix, linkConfigs)
          : parseMarkdownFile(fp, tagPrefix, linkConfigs);

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
  tags?: string;
}

// ─── Multi-plan helpers ───────────────────────────────────────────────────────

/**
 * Build an effective config for a single plan entry in testPlans[] mode.
 * Overrides testPlan and local include/exclude without mutating the original.
 */
function configForPlanEntry(base: SyncConfig, entry: TestPlanEntry): SyncConfig {
  return {
    ...base,
    testPlan: {
      id: entry.id,
      suiteId: entry.suiteId ?? base.testPlan.suiteId,
      suiteMapping: entry.suiteMapping ?? base.testPlan.suiteMapping,
    },
    local: {
      ...base.local,
      include: entry.include ?? base.local.include,
      exclude: entry.exclude ?? base.local.exclude,
    },
  };
}

// ─── Push ─────────────────────────────────────────────────────────────────────

export async function push(
  config: SyncConfig,
  configDir: string,
  opts: SyncOpts = {}
): Promise<SyncResult[]> {
  // Multi-plan: delegate to each plan entry
  if (config.testPlans?.length) {
    const all: SyncResult[] = [];
    for (const entry of config.testPlans) {
      const entryConfig = configForPlanEntry(config, entry);
      all.push(...await pushSingle(entryConfig, configDir, opts));
    }
    return all;
  }
  return pushSingle(config, configDir, opts);
}

async function pushSingle(
  config: SyncConfig,
  configDir: string,
  opts: SyncOpts
): Promise<SyncResult[]> {
  const files = await discoverFiles(config.local.include, config.local.exclude, configDir);
  const tests = parseLocalFiles(files, config, opts.tags);
  const client = await AzureClient.create(config);
  const tagPrefix = config.sync?.tagPrefix ?? 'tc';
  const titleField = config.sync?.titleField ?? 'System.Title';
  const conflictAction = config.sync?.conflictAction ?? 'overwrite';
  const disableLocal = config.sync?.disableLocalChanges ?? false;
  const byFolder = config.testPlan.suiteMapping === 'byFolder';
  const suiteCache = new Map<string, number>();
  const results: SyncResult[] = [];
  const conflicts: SyncResult[] = [];
  const createdIds = new Set<number>();
  const pendingWritebacks: Array<{ test: ParsedTest; newId: number }> = [];

  // Load local cache for conflict detection and skip optimisation
  const cache = loadCache(configDir);

  for (const test of tests) {
    if (test.azureId) {
      try {
        const cached = cache[test.azureId];
        const remote = await getTestCase(client, test.azureId, titleField);

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
          // Update cache entry even on skip (changedDate may differ due to other fields)
          updateCacheEntry(cache, test, remote);
          results.push({ action: 'skipped', filePath: test.filePath, title: test.title, azureId: test.azureId });
          continue;
        }

        // Conflict detection: remote was changed since last push AND local also differs
        if (cached && remote.changedDate && remote.changedDate !== cached.changedDate) {
          const conflict: SyncResult = {
            action: 'conflict',
            filePath: test.filePath,
            title: test.title,
            azureId: test.azureId,
            detail: 'Both local and remote have changed since last sync',
          };
          if (conflictAction === 'skip') {
            results.push(conflict);
            continue;
          }
          if (conflictAction === 'fail') {
            conflicts.push(conflict);
            continue;
          }
          // 'overwrite' — fall through to update
        }

        if (!opts.dryRun) {
          await updateTestCase(client, test.azureId, test, config);
          updateCacheEntry(cache, test, remote);
        }
        results.push({ action: 'updated', filePath: test.filePath, title: test.title, azureId: test.azureId });
      } catch (err: any) {
        results.push({ action: 'error', filePath: test.filePath, title: test.title, azureId: test.azureId, detail: err.message });
      }
    } else {
      try {
        let newId: number | undefined;
        if (!opts.dryRun) {
          const suiteIdOverride = byFolder
            ? await getOrCreateSuiteForFile(client, config, test.filePath, configDir, suiteCache)
            : undefined;
          newId = await createTestCase(client, test, config, suiteIdOverride);
          createdIds.add(newId);
          if (!disableLocal) {
            pendingWritebacks.push({ test, newId });
          }
          // Fetch back to get changedDate for cache
          const created = await getTestCase(client, newId, titleField);
          if (created) updateCacheEntry(cache, test, created);
        }
        results.push({ action: 'created', filePath: test.filePath, title: test.title, azureId: newId });
      } catch (err: any) {
        results.push({ action: 'error', filePath: test.filePath, title: test.title, detail: err.message });
      }
    }
  }

  if (conflicts.length) {
    const titles = conflicts.map((c) => `  #${c.azureId} — ${c.title}`).join('\n');
    throw new Error(`Conflicts detected (conflictAction=fail):\n${titles}`);
  }

  // Apply ID writebacks in descending line order per file so earlier insertions
  // don't shift line numbers for subsequent writebacks in the same file.
  if (!opts.dryRun && pendingWritebacks.length) {
    const byFile = new Map<string, typeof pendingWritebacks>();
    for (const wb of pendingWritebacks) {
      const fp = wb.test.filePath;
      if (!byFile.has(fp)) byFile.set(fp, []);
      byFile.get(fp)!.push(wb);
    }
    for (const wbs of byFile.values()) {
      wbs.sort((a, b) => b.test.line - a.test.line);
      for (const { test: t, newId } of wbs) {
        writebackId(t, newId, config.local.type, tagPrefix);
      }
    }
  }

  // Removed TC detection: find suite TCs not referenced by any local test
  if (!opts.dryRun || true /* show removed in dry-run too */) {
    try {
      const remoteTcs = await getTestCasesInSuite(client, config);
      const localIds = new Set([
        ...(tests.map((t) => t.azureId).filter(Boolean) as number[]),
        ...createdIds,
      ]);
      for (const remote of remoteTcs) {
        if (!localIds.has(remote.id)) {
          if (!opts.dryRun) {
            await tagTestCaseAsRemoved(client, remote.id);
          }
          results.push({
            action: 'removed',
            filePath: '',
            title: remote.title,
            azureId: remote.id,
            detail: opts.dryRun ? 'would tag as ado-sync:removed' : 'tagged ado-sync:removed',
          });
        }
      }
    } catch { /* best-effort: don't fail the whole push */ }
  }

  if (!opts.dryRun) {
    saveCache(configDir, cache);
  }

  return results;
}

// ─── Pull ─────────────────────────────────────────────────────────────────────

export async function pull(
  config: SyncConfig,
  configDir: string,
  opts: SyncOpts = {}
): Promise<SyncResult[]> {
  if (config.testPlans?.length) {
    const all: SyncResult[] = [];
    for (const entry of config.testPlans) {
      all.push(...await pullSingle(configForPlanEntry(config, entry), configDir, opts));
    }
    return all;
  }
  return pullSingle(config, configDir, opts);
}

async function pullSingle(
  config: SyncConfig,
  configDir: string,
  opts: SyncOpts
): Promise<SyncResult[]> {
  const files = await discoverFiles(config.local.include, config.local.exclude, configDir);
  const tests = parseLocalFiles(files, config, opts.tags);
  const client = await AzureClient.create(config);
  const titleField = config.sync?.titleField ?? 'System.Title';
  const disableLocal = config.sync?.disableLocalChanges ?? false;
  const results: SyncResult[] = [];
  const cache = loadCache(configDir);

  const linked = tests.filter((t) => t.azureId !== undefined);

  for (const test of linked) {
    try {
      const remote = await getTestCase(client, test.azureId!, titleField);

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
      const descriptionChanged = (remote.description ?? '') !== (test.description ?? '');

      if (!titleChanged && !stepsChanged && !descriptionChanged) {
        results.push({ action: 'skipped', filePath: test.filePath, title: test.title, azureId: test.azureId });
        continue;
      }

      if (!opts.dryRun) {
        if (!disableLocal) {
          applyRemoteToLocal(
            test,
            remote.title,
            remote.steps.map((s) => ({ keyword: 'Step', text: s.action, expected: s.expected })),
            remote.description,
            config.local.type
          );
        }
        updateCacheEntry(cache, test, remote);
      }

      results.push({
        action: 'pulled',
        filePath: test.filePath,
        title: remote.title,
        azureId: test.azureId,
        detail: [
          titleChanged && 'title',
          stepsChanged && 'steps',
          descriptionChanged && 'description',
        ].filter(Boolean).join(', ') + ' changed' + (disableLocal ? ' (local changes skipped)' : ''),
      });
    } catch (err: any) {
      results.push({ action: 'error', filePath: test.filePath, title: test.title, azureId: test.azureId, detail: err.message });
    }
  }

  if (!opts.dryRun) {
    saveCache(configDir, cache);
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

// ─── Cache helpers ────────────────────────────────────────────────────────────

function updateCacheEntry(cache: SyncCache, test: ParsedTest, remote: { id: number; title: string; steps: any[]; description?: string; changedDate?: string; }): void {
  if (!remote.changedDate) return;
  cache[remote.id] = {
    title: remote.title,
    stepsHash: hashSteps(remote.steps),
    descriptionHash: hashString(remote.description),
    changedDate: remote.changedDate,
    filePath: test.filePath,
  } as CacheEntry;
}

// ─── Apply remote changes to local file ───────────────────────────────────────

function applyRemoteToLocal(
  test: ParsedTest,
  newTitle: string,
  newSteps: ParsedStep[],
  newDescription: string | undefined,
  localType: 'gherkin' | 'markdown'
): void {
  if (localType === 'gherkin') {
    applyRemoteToGherkin(test, newTitle, newSteps);
  } else {
    applyRemoteToMarkdown(test, newTitle, newSteps, newDescription);
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

  // s.text == Azure action which already includes the keyword (e.g. "Given I navigate to...")
  const stepLines = newSteps.map((s) => `    ${s.text}`);
  lines.splice(stepStart, stepEnd - stepStart, ...stepLines);

  fs.writeFileSync(test.filePath, lines.join('\n'), 'utf8');
}

/** Strip HTML tags from Azure rich-text description. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function applyRemoteToMarkdown(
  test: ParsedTest,
  newTitle: string,
  newSteps: ParsedStep[],
  newDescription: string | undefined
): void {
  const raw = fs.readFileSync(test.filePath, 'utf8');
  const lines = raw.split('\n');
  const headingLineIdx = test.line - 1;

  // Update title
  lines[headingLineIdx] = lines[headingLineIdx].replace(
    /^(###\s+(?:\d+\.\s+)?)(.*)$/,
    `$1${newTitle}`
  );

  const STEPS_RE = /^\*{0,2}steps\s*:\*{0,2}$/i;
  const EXPECTED_RE = /^\*{0,2}expected\s+results?\s*:\*{0,2}$/i;
  const SEPARATOR_RE = /^---+\s*$/;
  const HEADING_RE = /^#{1,6}\s/;
  const COMMENT_RE = /^<!--/;

  // Find boundaries: description block, steps block, expected block
  let descEnd = -1;   // line index where description content ends (exclusive)
  let stepsStart = -1;
  let stepsEnd = -1;
  let expectedStart = -1;
  let sectionEnd = lines.length;

  for (let i = headingLineIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (HEADING_RE.test(lines[i]) || SEPARATOR_RE.test(trimmed)) {
      sectionEnd = i;
      if (stepsStart !== -1 && stepsEnd === -1) stepsEnd = i;
      break;
    }
    if (STEPS_RE.test(trimmed.replace(/^\*+/, '').replace(/\*+$/, ''))) {
      if (descEnd === -1) descEnd = i;
      stepsStart = i;
      continue;
    }
    if (EXPECTED_RE.test(trimmed.replace(/^\*+/, '').replace(/\*+$/, ''))) {
      if (stepsEnd === -1 && stepsStart !== -1) stepsEnd = i;
      expectedStart = i;
      continue;
    }
  }
  if (stepsEnd === -1 && stepsStart !== -1) stepsEnd = sectionEnd;

  // Build new step lines.
  // s.text == Azure action; for markdown TCs the action has a "Step " prefix that
  // was added on push (keyword + text). Strip it so the file stays in canonical form
  // (plain numbered list without the "Step" label) and push/pull remain idempotent.
  const newStepLines = newSteps.map((s, idx) => {
    const text = s.text.replace(/^step\s+/i, '');
    return `${idx + 1}. ${text}`;
  });

  // Replace steps section
  if (stepsStart !== -1 && stepsEnd !== -1) {
    lines.splice(stepsStart, stepsEnd - stepsStart, 'Steps:', ...newStepLines);
  }

  // Update description (Gap 8)
  if (newDescription !== undefined && descEnd !== -1) {
    const cleanDesc = stripHtml(newDescription);
    if (cleanDesc) {
      // Description block is headingLineIdx+1 .. descEnd (skip comment lines)
      let descBlockStart = headingLineIdx + 1;
      // Skip over ID/tags comment lines right after heading
      while (descBlockStart < descEnd && COMMENT_RE.test(lines[descBlockStart].trim())) {
        descBlockStart++;
      }
      const descLines = cleanDesc.split('\n');
      lines.splice(descBlockStart, descEnd - descBlockStart, ...descLines, '');
    }
  }

  // Recalculate expected section position after splices
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
