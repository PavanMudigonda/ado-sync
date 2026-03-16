/**
 * Sync engine — orchestrates push, pull, and status operations.
 */

import parseTagExpression from '@cucumber/tag-expressions';
import * as fs from 'fs';
import { glob } from 'glob';
import * as path from 'path';

import { AiSummaryOpts, summarizeTest } from '../ai/summarizer';
import { AzureClient } from '../azure/client';
import {
  addTestCaseToConditionSuites,
  addTestCaseToRootSuite,
  addTestCaseToSuite,
  createTestCase,
  getOrCreateNamedSuite,
  getOrCreateSuiteForFile,
  getTestCase,
  getTestCasesInSuite,
  tagTestCaseAsRemoved,
  updateTestCase,
} from '../azure/test-cases';
import { parseCsharpFile } from '../parsers/csharp';
import { applyRemoteToCsv, parseCsvFile } from '../parsers/csv';
import { parseDartFile } from '../parsers/dart';
import { parseExcelFile } from '../parsers/excel';
import { parseGherkinFile } from '../parsers/gherkin';
import { parseGoFile } from '../parsers/go';
import { parseJavaFile } from '../parsers/java';
import { parseJavaScriptFile } from '../parsers/javascript';
import { parseKotlinFile } from '../parsers/kotlin';
import { parseMarkdownFile } from '../parsers/markdown';
import { parsePhpFile } from '../parsers/php';
import { parsePythonFile } from '../parsers/python';
import { parseRobotFile } from '../parsers/robot';
import { parseRubyFile } from '../parsers/ruby';
import { parseRustFile } from '../parsers/rust';
import { parseSwiftFile } from '../parsers/swift';
import { parseTestCafeFile } from '../parsers/testcafe';
import { AzureTestCase, ParsedStep, ParsedTest, SuiteRoute, SyncConfig, SyncResult, TestPlanEntry } from '../types';
import { CacheEntry, hashSteps, hashString, loadCache, saveCache, SyncCache } from './cache';
import { writebackDocComment, writebackId } from './writeback';

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
        case 'reqnroll':
          tests = parseGherkinFile(fp, tagPrefix, linkConfigs, attachmentsConfig);
          break;
        case 'csv':
          tests = parseCsvFile(fp, tagPrefix, linkConfigs);
          break;
        case 'excel':
          tests = await parseExcelFile(fp, tagPrefix, linkConfigs);
          break;
        case 'csharp':
          tests = parseCsharpFile(fp, tagPrefix, linkConfigs);
          break;
        case 'java':
          tests = parseJavaFile(fp, tagPrefix, linkConfigs);
          break;
        case 'python':
          tests = parsePythonFile(fp, tagPrefix, linkConfigs);
          break;
        case 'javascript':
        case 'playwright':
        case 'puppeteer':
        case 'cypress':
        case 'detox':
          tests = parseJavaScriptFile(fp, tagPrefix, linkConfigs);
          break;
        case 'testcafe':
          tests = parseTestCafeFile(fp, tagPrefix, linkConfigs);
          break;
        case 'espresso':
          tests = parseJavaFile(fp, tagPrefix, linkConfigs);
          break;
        case 'xcuitest':
          tests = parseSwiftFile(fp, tagPrefix, linkConfigs);
          break;
        case 'flutter':
          tests = parseDartFile(fp, tagPrefix, linkConfigs);
          break;
        case 'robot':
          tests = parseRobotFile(fp, tagPrefix, linkConfigs);
          break;
        case 'go':
          tests = parseGoFile(fp, tagPrefix, linkConfigs);
          break;
        case 'rspec':
          tests = parseRubyFile(fp, tagPrefix, linkConfigs);
          break;
        case 'phpunit':
          tests = parsePhpFile(fp, tagPrefix, linkConfigs);
          break;
        case 'rust':
          tests = parseRustFile(fp, tagPrefix, linkConfigs);
          break;
        case 'kotlin':
          tests = parseKotlinFile(fp, tagPrefix, linkConfigs);
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
  /** Called during AI summarisation phase (before sync loop). done=0 signals start of a test. */
  onAiProgress?: (done: number, total: number, title: string) => void;
  /** AI auto-summary options: generate title/steps for tests that have none. */
  aiSummary?: AiSummaryOpts;
  /** Internal: pre-parsed tests injected by multi-plan push to skip re-parsing. */
  _preloadedTests?: ParsedTest[];
}

// ─── Multi-plan helpers ───────────────────────────────────────────────────────

/**
 * Build an effective config for a single plan entry in testPlans[] mode.
 * Overrides testPlan and local include/exclude without mutating the original.
 * Also merges per-entry suiteConditions and suiteRouting.
 */
function configForPlanEntry(base: SyncConfig, entry: TestPlanEntry): SyncConfig {
  // Merge suiteConditions: entry-level overrides base sync.suiteConditions when present
  const mergedSync = entry.suiteConditions !== undefined
    ? { ...base.sync, suiteConditions: entry.suiteConditions }
    : base.sync;

  return {
    ...base,
    sync: mergedSync,
    testPlan: {
      id: entry.id,
      suiteId: entry.suiteId ?? base.testPlan.suiteId,
      suiteMapping: entry.suiteMapping ?? base.testPlan.suiteMapping,
      suiteRouting: entry.suiteRouting ?? base.testPlan.suiteRouting,
    },
    local: {
      ...base.local,
      include: entry.include ?? base.local.include,
      exclude: entry.exclude ?? base.local.exclude,
    },
  };
}

/**
 * Resolve the primary suite ID for a test case using suiteRouting rules.
 * Routes are evaluated in order; the first matching tag expression wins.
 * When a route's suite is a string, the suite is looked up or created under the plan.
 * Returns undefined if no route matches (caller falls back to suiteId or root suite).
 */
async function resolveTargetSuiteFromRouting(
  client: AzureClient,
  config: SyncConfig,
  test: ParsedTest,
  suiteCache: Map<string, number>
): Promise<number | undefined> {
  const routes: SuiteRoute[] | undefined = config.testPlan.suiteRouting;
  if (!routes?.length) return undefined;

  for (const route of routes) {
    const matches = !route.tags || matchesTags(test, route.tags);
    if (!matches) continue;

    // Numeric suite ID — use directly
    if (typeof route.suite === 'number') return route.suite;

    // Named suite — look up or create under the plan
    const cacheKey = `route:${config.testPlan.id}:${route.suite}`;
    if (suiteCache.has(cacheKey)) return suiteCache.get(cacheKey)!;

    try {
      const suiteId = await getOrCreateNamedSuite(client, config, route.suite as string);
      suiteCache.set(cacheKey, suiteId);
      return suiteId;
    } catch {
      // If suite creation fails, fall through to the next route
      continue;
    }
  }

  return undefined;
}

// ─── Push ─────────────────────────────────────────────────────────────────────

export async function push(
  config: SyncConfig,
  configDir: string,
  opts: SyncOpts = {}
): Promise<SyncResult[]> {
  // Multi-plan: run AI summarisation across all plans first so progress totals
  // are correct, then delegate each plan's sync loop (with AI already applied).
  if (config.testPlans?.length) {
    // Collect all tests across plans and run AI in one pass
    const planTests: Array<{ entryConfig: SyncConfig; tests: ParsedTest[] }> = [];
    for (const entry of config.testPlans) {
      const entryConfig = configForPlanEntry(config, entry);
      const files = await discoverFiles(entryConfig.local.include, entryConfig.local.exclude, configDir);
      const tests = await parseLocalFiles(files, entryConfig, opts.tags);
      planTests.push({ entryConfig, tests });
    }
    if (opts.aiSummary) {
      const CODE_TYPES = new Set(['javascript', 'playwright', 'puppeteer', 'cypress', 'testcafe', 'detox', 'espresso', 'xcuitest', 'flutter', 'java', 'csharp', 'python']);
      const allTargets = planTests.flatMap(({ entryConfig, tests }) =>
        CODE_TYPES.has(entryConfig.local.type) ? tests.filter(t => t.steps.length === 0 || !t.description) : []
      );
      let aiDone = 0;
      for (const { entryConfig, tests } of planTests) {
        if (!CODE_TYPES.has(entryConfig.local.type)) continue;
        for (const test of tests) {
          const needsSteps = test.steps.length === 0;
          const needsDescription = !test.description;
          if (needsSteps || needsDescription) {
            opts.onAiProgress?.(aiDone, allTargets.length, test.title);
            const result = await summarizeTest(test, entryConfig.local.type, opts.aiSummary);
            aiDone++;
            opts.onAiProgress?.(aiDone, allTargets.length, test.title);
            if (needsSteps) { if (test.titleIsHeuristic !== false) test.title = result.title; test.steps = result.steps; }
            if (needsDescription && result.description) test.description = result.description;
          }
        }
      }
      if (allTargets.length > 0) opts.onAiProgress?.(allTargets.length, allTargets.length, '');
    }
    // Run sync loop per plan (AI already applied, skip AI phase inside pushSingle)
    const all: SyncResult[] = [];
    for (const { entryConfig, tests } of planTests) {
      all.push(...await pushSingle(entryConfig, configDir, { ...opts, aiSummary: undefined, onAiProgress: undefined, _preloadedTests: tests } as SyncOpts));
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
  const files = opts._preloadedTests
    ? []
    : await discoverFiles(config.local.include, config.local.exclude, configDir);
  const tests = opts._preloadedTests
    ?? await parseLocalFiles(files, config, opts.tags);

  // AI auto-summary: for code-based local types, default to the local node-llama-cpp
  // provider (with heuristic fallback) when no explicit aiSummary opts are provided.
  // If no GGUF model path is set, the local provider transparently falls back to
  // heuristic mode so the push always succeeds even without a model installed.
  const CODE_TYPES = new Set(['javascript', 'playwright', 'puppeteer', 'cypress', 'testcafe', 'detox', 'espresso', 'xcuitest', 'flutter', 'java', 'csharp', 'python']);
  const effectiveAiOpts: AiSummaryOpts | undefined =
    opts._preloadedTests ? undefined  // AI already applied in multi-plan pre-pass
    : opts.aiSummary ?? (CODE_TYPES.has(config.local.type) ? { provider: 'local', heuristicFallback: true } : undefined);

  if (effectiveAiOpts) {
    const aiTargets = tests.filter(t => t.steps.length === 0 || !t.description);
    let aiDone = 0;
    for (const test of tests) {
      const needsSteps = test.steps.length === 0;
      const needsDescription = !test.description;
      if (needsSteps || needsDescription) {
        opts.onAiProgress?.(aiDone, aiTargets.length, test.title);
        const result = await summarizeTest(test, config.local.type, effectiveAiOpts);
        aiDone++;
        opts.onAiProgress?.(aiDone, aiTargets.length, test.title);
        if (needsSteps) {
          // Only replace the title when it was heuristically generated (e.g. from a
          // method name transformation). If titleIsHeuristic is false the title came
          // directly from the source file (it('…'), test('…'), etc.) and must not be
          // overridden — that would produce a different title on every push and break
          // the Azure ID match on subsequent runs.
          if (test.titleIsHeuristic !== false) test.title = result.title;
          test.steps = result.steps;
        }
        if (needsDescription && result.description) {
          test.description = result.description;
        }

        // JSDoc doc-comment writeback: persist the AI-generated steps to the source
        // file so they are read back on the next push (preventing re-invocation).
        // Only applies to JS/TS frameworks that use the JavaScript parser.
        const jsTypes = new Set(['javascript', 'playwright', 'puppeteer', 'cypress', 'detox', 'xcuitest', 'flutter']);
        if (
          config.sync?.ai?.writebackDocComment &&
          !(config.sync?.disableLocalChanges) &&
          jsTypes.has(config.local.type) &&
          test.steps.length > 0
        ) {
          writebackDocComment(test, test.title, test.description, test.steps);
        }
      }
    }
    if (aiTargets.length > 0) opts.onAiProgress?.(aiTargets.length, aiTargets.length, '');
  }

  const client = await AzureClient.create(config);
  const tagPrefix = config.sync?.tagPrefix ?? 'tc';
  const titleField = config.sync?.titleField ?? 'System.Title';
  const conflictAction = config.sync?.conflictAction ?? 'overwrite';
  const disableLocal = config.sync?.disableLocalChanges ?? false;
  const byFolder = config.testPlan.suiteMapping === 'byFolder' || config.testPlan.suiteMapping === 'byFile';
  const suiteCache = new Map<string, number>();
  const conditionSuiteCache = new Map<string, number>();
  const results: SyncResult[] = [];
  const conflicts: SyncResult[] = [];
  const createdIds = new Set<number>();
  const pendingWritebacks: Array<{ test: ParsedTest; newId: number }> = [];

  // Load local cache for conflict detection and skip optimisation
  const cache = loadCache(configDir);

  // ── automatedTestName fallback matching ───────────────────────────────────
  // When markAutomated is true and a local test has no @tc:ID annotation, try
  // to find its existing TC in Azure by AutomatedTestName. This recovers from
  // situations where writeback files were not committed (e.g. first push was a
  // dry-run, or the developer didn't stage the file changes). Without this,
  // every unlinked test would be created as a new TC on each push, causing the
  // plan to grow unboundedly while old TCs accumulate as ado-sync:removed.
  const markAutomated = config.sync?.markAutomated ?? false;
  const recoveredIds = new Set<string>(); // "filePath:line" keys
  let preloadedRemoteTcs: Awaited<ReturnType<typeof getTestCasesInSuite>> | undefined;
  const unlinkedWithAtName = tests.filter(t => !t.azureId && t.automatedTestName);
  if (markAutomated && unlinkedWithAtName.length > 0) {
    try {
      preloadedRemoteTcs = await getTestCasesInSuite(client, config);
      const byAtName = new Map(
        preloadedRemoteTcs
          .filter(tc => tc.automatedTestName)
          .map(tc => [tc.automatedTestName!, tc])
      );
      for (const test of unlinkedWithAtName) {
        const match = byAtName.get(test.automatedTestName!);
        if (match) {
          test.azureId = match.id;
          recoveredIds.add(`${test.filePath}:${test.line}`);
        }
      }
    } catch { /* best-effort: if pre-load fails, continue without matching */ }
  }

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
              : await resolveTargetSuiteFromRouting(client, config, test, suiteCache);
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
            : await resolveTargetSuiteFromRouting(client, config, test, suiteCache) ?? config.testPlan.suiteId;
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
            : await resolveTargetSuiteFromRouting(client, config, test, suiteCache);
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

  // Playwright migration: convert existing comment-style IDs to native annotations.
  // For all other framework types this is a no-op.
  if (!opts.dryRun && !disableLocal && config.local.type === 'playwright') {
    const alreadyQueued = new Set(pendingWritebacks.map((wb) => `${wb.test.filePath}:${wb.test.line}`));
    for (const test of tests) {
      if (test.azureId && !alreadyQueued.has(`${test.filePath}:${test.line}`)) {
        pendingWritebacks.push({ test, newId: test.azureId });
      }
    }
  }

  // Write back recovered IDs (matched by automatedTestName above).
  // These tests had their azureId set in the pre-pass but were not in pendingWritebacks
  // (no new TC was created). Queue them so the source annotation is restored.
  if (!opts.dryRun && !disableLocal && recoveredIds.size > 0) {
    const alreadyQueued = new Set(pendingWritebacks.map((wb) => `${wb.test.filePath}:${wb.test.line}`));
    for (const test of tests) {
      const key = `${test.filePath}:${test.line}`;
      if (test.azureId && recoveredIds.has(key) && !alreadyQueued.has(key)) {
        pendingWritebacks.push({ test, newId: test.azureId });
      }
    }
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
      // Reuse the pre-loaded remote TCs if we already fetched them for automatedTestName
      // matching, otherwise fetch now. This avoids a redundant round-trip.
      const remoteTcs = preloadedRemoteTcs ?? await getTestCasesInSuite(client, config);
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
  opts: Pick<SyncOpts, 'tags' | 'onProgress' | 'onAiProgress' | 'aiSummary'> = {}
): Promise<SyncResult[]> {
  return push(config, configDir, { dryRun: true, tags: opts.tags, onProgress: opts.onProgress, onAiProgress: opts.onAiProgress, aiSummary: opts.aiSummary });
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
  localType: 'gherkin' | 'reqnroll' | 'markdown' | 'csv' | 'excel' | 'csharp' | 'java' | 'python' | 'javascript' | 'playwright' | 'puppeteer' | 'cypress' | 'testcafe' | 'detox' | 'espresso' | 'xcuitest' | 'flutter' | 'robot' | 'go' | 'rspec' | 'phpunit' | 'rust' | 'kotlin',
  tagPrefix: string
): void {
  if (localType === 'gherkin' || localType === 'reqnroll') {
    applyRemoteToGherkin(test, newTitle, newSteps);
  } else if (localType === 'markdown') {
    applyRemoteToMarkdown(test, newTitle, newSteps, newDescription, tagPrefix);
  } else if (localType === 'csv') {
    applyRemoteToCsv(test.filePath, test.title, newTitle, newSteps);
  }
  // excel: pull not yet supported (in-place XML surgery for xlsx is complex)
  // csharp / java / python / javascript: pull not supported (code files are managed locally)
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
  const ext = (localType === 'gherkin' || localType === 'reqnroll') ? '.feature' : '.md';
  const baseDir = path.resolve(configDir, config.sync?.pull?.targetFolder ?? '.');
  if (write) fs.mkdirSync(baseDir, { recursive: true });
  const filePath = path.join(baseDir, `${safeTitle}${ext}`);

  if (write) {
    if (localType === 'gherkin' || localType === 'reqnroll') {
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
