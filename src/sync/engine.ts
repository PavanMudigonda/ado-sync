/**
 * Sync engine — orchestrates push, pull, and status operations.
 */

import parseTagExpression from '@cucumber/tag-expressions';
import * as fs from 'fs';
import { glob } from 'glob';
import * as path from 'path';

import { AzureClient } from '../azure/client';
import {
  addTestCaseToConditionSuites,
  addTestCaseToRootSuite,
  addTestCaseToSuite,
  createTestCase,
  getOrCreateSuiteForFile,
  getTestCase,
  getTestCasesInSuite,
  tagTestCaseAsRemoved,
  updateTestCase,
} from '../azure/test-cases';
import { parseCsvFile } from '../parsers/csv';
import { parseExcelFile } from '../parsers/excel';
import { parseGherkinFile } from '../parsers/gherkin';
import { parseMarkdownFile } from '../parsers/markdown';
import { AzureTestCase, ParsedStep, ParsedTest, SyncConfig, SyncResult, TestPlanEntry } from '../types';
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
    if (pattern.startsWith('/')) {
      throw new Error(
        `local.include pattern "${pattern}" is an absolute path. Use a relative glob (e.g. "**/*.csv") — patterns are resolved relative to the config file directory.`
      );
    }
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

async function parseLocalFiles(
  filePaths: string[],
  config: SyncConfig,
  tagsFilter?: string
): Promise<ParsedTest[]> {
  const tagPrefix = config.sync?.tagPrefix ?? 'tc';
  const linkConfigs = config.sync?.links;
  const attachmentsConfig = config.sync?.attachments;
  const localCondition = config.local.condition;
  const results: ParsedTest[] = [];

  for (const fp of filePaths) {
    try {
      let tests: ParsedTest[];
      switch (config.local.type) {
        case 'gherkin':
          tests = parseGherkinFile(fp, tagPrefix, linkConfigs, attachmentsConfig);
          break;
        case 'csv':
          tests = parseCsvFile(fp, tagPrefix, linkConfigs);
          break;
        case 'excel':
          tests = await parseExcelFile(fp, tagPrefix, linkConfigs);
          break;
        default:
          tests = parseMarkdownFile(fp, tagPrefix, linkConfigs, attachmentsConfig);
      }

      for (const t of tests) {
        if (localCondition && !matchesTags(t, localCondition)) continue;
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
  /** Called after each test case is processed. Useful for rendering a live progress bar. */
  onProgress?: (done: number, total: number, result: SyncResult) => void;
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
  const tests = await parseLocalFiles(files, config, opts.tags);
  const client = await AzureClient.create(config);
  const tagPrefix = config.sync?.tagPrefix ?? 'tc';
  const titleField = config.sync?.titleField ?? 'System.Title';
  const conflictAction = config.sync?.conflictAction ?? 'overwrite';
  const disableLocal = config.sync?.disableLocalChanges ?? false;
  const byFolder = config.testPlan.suiteMapping === 'byFolder';
  const suiteCache = new Map<string, number>();
  const conditionSuiteCache = new Map<string, number>();
  const results: SyncResult[] = [];
  const conflicts: SyncResult[] = [];
  const createdIds = new Set<number>();
  const pendingWritebacks: Array<{ test: ParsedTest; newId: number }> = [];

  // Load local cache for conflict detection and skip optimisation
  const cache = loadCache(configDir);

  let done = 0;
  const reportProgress = (result: SyncResult) => {
    results.push(result);
    opts.onProgress?.(++done, tests.length, result);
  };

  for (const test of tests) {
    if (test.azureId) {
      try {
        const cached = cache[test.azureId];
        const remote = await getTestCase(client, test.azureId, titleField);

        if (!remote) {
          // TC was deleted from Azure — re-create it and write back the new ID.
          let newId: number | undefined;
          if (!opts.dryRun) {
            const suiteIdOverride = byFolder
              ? await getOrCreateSuiteForFile(client, config, test.filePath, configDir, suiteCache)
              : undefined;
            newId = await createTestCase(client, test, config, suiteIdOverride, configDir);
            createdIds.add(newId);
            if (!disableLocal) {
              pendingWritebacks.push({ test, newId });
            }
            await addTestCaseToConditionSuites(client, config, newId, test, conditionSuiteCache);
            const created = await getTestCase(client, newId, titleField);
            if (created) updateCacheEntry(cache, test, created);
          }
          reportProgress({ action: 'created', filePath: test.filePath, title: test.title, azureId: newId });
          continue;
        }

        // For Scenario Outlines, local steps use <param> but Azure stores @param@.
        // Normalise local to @param@ before comparing so outlines don't report
        // stepsChanged on every push after the first successful sync.
        const isOutline = !!test.outlineParameters?.headers.length;
        const localStepsText = test.steps
          .map((s) => {
            const raw = `${s.keyword} ${s.text}`;
            return isOutline ? raw.replace(/<([^>]+)>/g, '@$1@') : raw;
          })
          .join('\n');
        const remoteStepsText = remote.steps.map((s) => s.action).join('\n');
        const titleChanged = remote.title !== test.title;
        const stepsChanged = localStepsText !== remoteStepsText;
        // For tags: push is additive (merges local into Azure), so only flag a change
        // when the local file has tags that are NOT yet present in Azure.
        const localTags = new Set(test.tags.filter((t) => !t.startsWith(tagPrefix + ':')));
        const remoteTags = new Set(remote.tags);
        const tagsChanged = [...localTags].some((t) => !remoteTags.has(t));
        // Description: compare local hash against what we last pushed (cache), not what
        // Azure returns (which may have been reformatted by Azure's rich-text editor).
        const localDescHash = hashString(test.description);
        const cachedDescHash = cached?.descriptionHash ?? '';
        const descriptionChanged = localDescHash !== cachedDescHash;

        if (!titleChanged && !stepsChanged && !tagsChanged && !descriptionChanged) {
          // Update cache entry even on skip (changedDate may differ due to other fields)
          updateCacheEntry(cache, test, remote);
          reportProgress({ action: 'skipped', filePath: test.filePath, title: test.title, azureId: test.azureId });
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
            reportProgress(conflict);
            continue;
          }
          if (conflictAction === 'fail') {
            conflicts.push(conflict);
            done++;
            continue;
          }
          // 'overwrite' — fall through to update
        }

        if (!opts.dryRun) {
          await updateTestCase(client, test.azureId, test, config, configDir);
          // Ensure the TC is in the configured suite (it may not be if the suite was
          // changed in config, or if the TC was imported with an ID but never pushed before).
          const updateSuiteId = byFolder
            ? await getOrCreateSuiteForFile(client, config, test.filePath, configDir, suiteCache)
            : config.testPlan.suiteId;
          if (updateSuiteId) {
            await addTestCaseToSuite(client, config, test.azureId, updateSuiteId);
          } else {
            await addTestCaseToRootSuite(client, config, test.azureId);
          }
          await addTestCaseToConditionSuites(client, config, test.azureId, test, conditionSuiteCache);
          updateCacheEntry(cache, test, remote);
        }
        reportProgress({ action: 'updated', filePath: test.filePath, title: test.title, azureId: test.azureId });
      } catch (err: any) {
        reportProgress({ action: 'error', filePath: test.filePath, title: test.title, azureId: test.azureId, detail: err.message });
      }
    } else {
      try {
        let newId: number | undefined;
        if (!opts.dryRun) {
          const suiteIdOverride = byFolder
            ? await getOrCreateSuiteForFile(client, config, test.filePath, configDir, suiteCache)
            : undefined;
          newId = await createTestCase(client, test, config, suiteIdOverride, configDir);
          createdIds.add(newId);
          if (!disableLocal) {
            pendingWritebacks.push({ test, newId });
          }
          await addTestCaseToConditionSuites(client, config, newId, test, conditionSuiteCache);
          // Fetch back to get changedDate for cache
          const created = await getTestCase(client, newId, titleField);
          if (created) updateCacheEntry(cache, test, created);
        }
        reportProgress({ action: 'created', filePath: test.filePath, title: test.title, azureId: newId });
      } catch (err: any) {
        reportProgress({ action: 'error', filePath: test.filePath, title: test.title, detail: err.message });
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
        await writebackId(t, newId, config.local.type, tagPrefix);
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
  const tests = await parseLocalFiles(files, config, opts.tags);
  const client = await AzureClient.create(config);
  const titleField = config.sync?.titleField ?? 'System.Title';
  const tagPrefix = config.sync?.tagPrefix ?? 'tc';
  const disableLocal = config.sync?.disableLocalChanges ?? false;
  const results: SyncResult[] = [];
  const cache = loadCache(configDir);

  const linked = tests.filter((t) => t.azureId !== undefined);

  let done = 0;
  const reportProgress = (result: SyncResult) => {
    results.push(result);
    opts.onProgress?.(++done, linked.length, result);
  };

  for (const test of linked) {
    try {
      const remote = await getTestCase(client, test.azureId!, titleField);

      if (!remote) {
        // TC was deleted from Azure — skip on pull; run push to re-create it.
        reportProgress({
          action: 'skipped',
          filePath: test.filePath,
          title: test.title,
          azureId: test.azureId,
          detail: `TC #${test.azureId} not found in Azure (run push to re-create)`,
        });
        continue;
      }

      const titleChanged = remote.title !== test.title;
      const remoteStepsText = remote.steps.map((s) => s.action + '|' + s.expected).join('\n');
      const localStepsText = test.steps.map((s) => s.keyword + ' ' + s.text + '|' + (s.expected ?? '')).join('\n');
      const stepsChanged = remoteStepsText !== localStepsText;
      const descriptionChanged = (remote.description ?? '') !== (test.description ?? '');

      if (!titleChanged && !stepsChanged && !descriptionChanged) {
        reportProgress({ action: 'skipped', filePath: test.filePath, title: test.title, azureId: test.azureId });
        continue;
      }

      if (!opts.dryRun) {
        if (!disableLocal) {
          applyRemoteToLocal(
            test,
            remote.title,
            remote.steps.map((s) => ({ keyword: 'Step', text: s.action, expected: s.expected })),
            remote.description,
            config.local.type,
            tagPrefix
          );
        }
        updateCacheEntry(cache, test, remote);
      }

      reportProgress({
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
      reportProgress({ action: 'error', filePath: test.filePath, title: test.title, azureId: test.azureId, detail: err.message });
    }
  }

  // Pull-create: generate new local files for Azure TCs that have no local counterpart
  if (config.sync?.pull?.enableCreatingNewLocalTestCases && !disableLocal) {
    try {
      const remoteTcs = await getTestCasesInSuite(client, config);
      const linkedIds = new Set(linked.map((t) => t.azureId));
      const unlinked = remoteTcs.filter((tc) => !linkedIds.has(tc.id));

      for (const tc of unlinked) {
        try {
          const newFilePath = createLocalFileFromRemote(tc, config, configDir, tagPrefix, !opts.dryRun);
          if (!opts.dryRun) {
            updateCacheEntry(cache, { filePath: newFilePath, title: tc.title, description: tc.description, steps: tc.steps.map((s) => ({ keyword: 'Step', text: s.action, expected: s.expected })), tags: tc.tags, line: 1, azureId: tc.id }, tc);
          }
          results.push({
            action: 'created',
            filePath: newFilePath,
            title: tc.title,
            azureId: tc.id,
            detail: 'new local file from Azure TC',
          });
        } catch (err: any) {
          results.push({ action: 'error', filePath: '', title: tc.title, azureId: tc.id, detail: `pull-create: ${err.message}` });
        }
      }
    } catch { /* best-effort */ }
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
  opts: Pick<SyncOpts, 'tags' | 'onProgress'> = {}
): Promise<SyncResult[]> {
  return push(config, configDir, { dryRun: true, tags: opts.tags, onProgress: opts.onProgress });
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

function updateCacheEntry(cache: SyncCache, test: ParsedTest, remote: { id: number; title: string; steps: any[]; description?: string; changedDate?: string; }): void {
  if (!remote.changedDate) return;
  cache[remote.id] = {
    title: remote.title,
    stepsHash: hashSteps(remote.steps),
    // Store the LOCAL description hash so we compare against what we pushed,
    // not Azure's potentially-reformatted version of the HTML.
    descriptionHash: hashString(test.description),
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
  localType: 'gherkin' | 'markdown' | 'csv' | 'excel',
  tagPrefix: string
): void {
  if (localType === 'gherkin') {
    applyRemoteToGherkin(test, newTitle, newSteps);
  } else if (localType === 'markdown') {
    applyRemoteToMarkdown(test, newTitle, newSteps, newDescription, tagPrefix);
  }
  // csv / excel: pull not supported (files are typically generated by external tools)
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
  newDescription: string | undefined,
  tagPrefix: string
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
  // Matches HTML comment lines (legacy) and plain @tc:ID tag lines (new format)
  const COMMENT_RE = new RegExp(`^<!--|^@${tagPrefix}:\\d+`);

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

// ─── Create local file from remote Azure TC ──────────────────────────────────

/**
 * Create a new local .feature or .md file for an Azure TC that has no local counterpart.
 * Returns the absolute path of the (would-be) file.
 * Pass write=false in dry-run mode to compute the path without touching the filesystem.
 */
function createLocalFileFromRemote(
  tc: AzureTestCase,
  config: SyncConfig,
  configDir: string,
  tagPrefix: string,
  write = true
): string {
  const localType = config.local.type;
  const safeTitle = tc.title.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_');
  const ext = localType === 'gherkin' ? '.feature' : '.md';
  const baseDir = path.resolve(configDir, config.sync?.pull?.targetFolder ?? '.');
  if (write) fs.mkdirSync(baseDir, { recursive: true });
  const filePath = path.join(baseDir, `${safeTitle}${ext}`);

  if (write) {
    if (localType === 'gherkin') {
      const lines: string[] = [];
      lines.push(`@${tagPrefix}:${tc.id}`);
      for (const tag of tc.tags) {
        if (!tag.startsWith(`${tagPrefix}:`)) lines.push(`@${tag}`);
      }
      lines.push(`Feature: ${tc.title}`);
      lines.push('');
      lines.push(`  Scenario: ${tc.title}`);
      for (const step of tc.steps) {
        lines.push(`    ${step.action}`);
      }
      lines.push('');
      fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    } else {
      const lines: string[] = [];
      lines.push(`### ${tc.title}`);
      lines.push(`@${tagPrefix}:${tc.id}`);
      for (const tag of tc.tags) {
        if (!tag.startsWith(`${tagPrefix}:`)) lines.push(`@${tag}`);
      }
      if (tc.description) {
        lines.push('');
        lines.push(stripHtml(tc.description));
      }
      lines.push('');
      lines.push('Steps:');
      tc.steps.forEach((step, idx) => {
        lines.push(`${idx + 1}. ${step.action}`);
      });
      if (tc.steps.some((s) => s.expected)) {
        lines.push('');
        lines.push('Expected results:');
        const lastExpected = [...tc.steps].reverse().find((s) => s.expected)?.expected;
        if (lastExpected) lines.push(`- ${lastExpected}`);
      }
      lines.push('');
      fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    }
  }

  return filePath;
}
