/**
 * Sync engine — orchestrates push, pull, and status operations.
 */

import parseTagExpression from '@cucumber/tag-expressions';
import * as fs from 'fs';
import { glob } from 'glob';
import * as path from 'path';

import { AiSummaryOpts, summarizeTest } from '../ai/summarizer';
import { stripHtml } from '../html';
import { AzureClient } from '../azure/client';
import {
  addTestCaseToConditionSuites,
  addTestCaseToRootSuite,
  addTestCaseToSuite,
  buildAzureSyncContent,
  createTestCase,
  getOrCreateNamedSuite,
  getOrCreateSuiteForFile,
  getTestCase,
  getTestCasesInSuite,
  tagTestCaseAsRemoved,
  updateTestCase,
} from '../azure/test-cases';
import { getMarkerTagPrefixes, getPreferredMarkerTagPrefix, isMarkerTag } from '../id-markers';
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
import { hashSteps, hashString, loadCache, saveCache, SyncCache } from './cache';
import { writebackDocComment, writebackId } from './writeback';

// ─── Tag filtering ────────────────────────────────────────────────────────────

function matchesTags(test: ParsedTest, expression: string): boolean {
  const node = parseTagExpression(expression);
  const tagsWithAt = test.tags.map((t) => (t.startsWith('@') ? t : `@${t}`));
  return node.evaluate(tagsWithAt);
}

// ─── Code-type detection ──────────────────────────────────────────────────────

/** Local types whose test bodies are executable code and may benefit from AI summarisation. */
const CODE_TYPES = new Set(['javascript', 'playwright', 'puppeteer', 'cypress', 'testcafe', 'detox', 'espresso', 'xcuitest', 'flutter', 'java', 'csharp', 'python']);

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

interface ParseFailure {
  filePath: string;
  message: string;
}

interface ParseLocalFilesResult {
  tests: ParsedTest[];
  failures: ParseFailure[];
}

export function failOnParseErrors(operation: string, failures: ParseFailure[]): void {
  if (!failures.length) return;
  const details = failures
    .map(({ filePath, message }) => `  - ${filePath}: ${message}`)
    .join('\n');
  throw new Error(
    `Aborting ${operation}: ${failures.length} file(s) could not be parsed.\n` +
    `Fix the parse errors and rerun to avoid partial sync decisions.\n${details}`
  );
}

function supportsPullWriteback(localType: SyncConfig['local']['type']): boolean {
  return localType === 'gherkin' || localType === 'reqnroll' || localType === 'markdown' || localType === 'csv';
}

export function buildPushDiff(
  test: ParsedTest,
  remote: AzureTestCase,
  config: SyncConfig,
  cached?: SyncCache[number]
): { changedFields: string[]; diffDetail: import('../types').DiffDetail[] } {
  const markerTagPrefixes = getMarkerTagPrefixes(config);
  const desiredAzure = buildAzureSyncContent(test, config.sync?.format);
  const localStepsText = desiredAzure.steps.map((s) => `${s.action}|${s.expected ?? ''}`).join('\n');
  const remoteStepsText = remote.steps.map((s) => `${s.action}|${s.expected ?? ''}`).join('\n');
  const titleChanged = remote.title !== desiredAzure.title;
  const stepsChanged = localStepsText !== remoteStepsText;

  const localTags = new Set(test.tags.filter((t) => !isMarkerTag(t, markerTagPrefixes)));
  const remoteTags = new Set(remote.tags);
  const tagsChanged = [...localTags].some((t) => !remoteTags.has(t));

  const localDescHash = hashString(test.description);
  const cachedDescHash = cached?.descriptionHash ?? '';
  const descriptionChanged = localDescHash !== cachedDescHash;

  const remoteDescHash = hashString(remote.description);
  const cachedRemoteDescHash = cached?.remoteDescriptionHash ?? '';
  const remoteDescriptionChanged = cachedRemoteDescHash !== '' && remoteDescHash !== cachedRemoteDescHash;

  const changedFields: string[] = [];
  if (titleChanged) changedFields.push('title');
  if (stepsChanged) changedFields.push('steps');
  if (tagsChanged) changedFields.push('tags');
  if (descriptionChanged || remoteDescriptionChanged) changedFields.push('description');

  const diffDetail: import('../types').DiffDetail[] = [];
  if (titleChanged) diffDetail.push({ field: 'title', local: desiredAzure.title, remote: remote.title });
  if (stepsChanged) diffDetail.push({ field: 'steps', local: localStepsText, remote: remoteStepsText });
  if (tagsChanged) {
    const addedTags = [...localTags].filter((t) => !remoteTags.has(t));
    diffDetail.push({ field: 'tags', local: addedTags.join(', '), remote: remote.tags.join(', ') });
  }
  if (descriptionChanged || remoteDescriptionChanged) {
    diffDetail.push({ field: 'description', local: test.description ?? '', remote: remote.description ?? '' });
  }

  return { changedFields, diffDetail };
}

async function parseLocalFiles(
  filePaths: string[],
  config: SyncConfig,
  tagsFilter?: string
): Promise<ParseLocalFilesResult> {
  const tagPrefix = getMarkerTagPrefixes(config);
  const linkConfigs = config.sync?.links;
  const autoLinkStories = config.sync?.autoLinkStories ?? false;
  const attachmentsConfig = config.sync?.attachments;
  const localCondition = config.local.condition;
  const results: ParsedTest[] = [];
  const failures: ParseFailure[] = [];

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
        case 'markdown':
          tests = parseMarkdownFile(fp, tagPrefix, linkConfigs, attachmentsConfig);
          break;
        default:
          // config.ts validateConfig() catches unknown types before we get here,
          // but guard defensively rather than silently misparse as Markdown.
          throw new Error(
            `Unsupported local.type "${(config.local as any).type}" — check your config. ` +
            `Valid types: gherkin, reqnroll, markdown, csv, excel, csharp, java, javascript, ` +
            `python, playwright, puppeteer, cypress, testcafe, detox, espresso, xcuitest, ` +
            `flutter, robot, go, rspec, phpunit, rust, kotlin`
          );
      }

      for (const t of tests) {
        if (localCondition && !matchesTags(t, localCondition)) continue;
        if (tagsFilter && !matchesTags(t, tagsFilter)) continue;

        // Auto-link: if autoLinkStories is enabled and the test has @story:NNN tags
        // not already covered by an explicit sync.links entry, add implicit linkRefs.
        if (autoLinkStories) {
          const storyPrefixConfigured = linkConfigs?.some((l) => l.prefix === 'story');
          if (!storyPrefixConfigured) {
            const storyRe = /^(?:@)?story:(\d+)$/i;
            const implicitStoryRefs: Array<{ prefix: string; id: number }> = [];
            for (const tag of t.tags) {
              const m = tag.match(storyRe);
              if (m) implicitStoryRefs.push({ prefix: 'story', id: parseInt(m[1], 10) });
            }
            if (implicitStoryRefs.length > 0) {
              const existing = t.linkRefs ?? [];
              const existingIds = new Set(existing.filter((r) => r.prefix === 'story').map((r) => r.id));
              const newRefs = implicitStoryRefs.filter((r) => !existingIds.has(r.id));
              if (newRefs.length > 0) {
                t.linkRefs = [...existing, ...newRefs];
              }
            }
          }
        }

        results.push(t);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  [warn] Failed to parse ${fp}: ${msg}`);
      failures.push({ filePath: fp, message: msg });
    }
  }

  return { tests: results, failures };
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
    const parseFailures: ParseFailure[] = [];
    for (const entry of config.testPlans) {
      const entryConfig = configForPlanEntry(config, entry);
      const files = await discoverFiles(entryConfig.local.include, entryConfig.local.exclude, configDir);
      const parsed = await parseLocalFiles(files, entryConfig, opts.tags);
      parseFailures.push(...parsed.failures);
      const tests = parsed.tests;
      planTests.push({ entryConfig, tests });
    }
    failOnParseErrors('push', parseFailures);
    if (opts.aiSummary) {
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
  let resolvedTests = opts._preloadedTests ?? [];
  let parseFailures: ParseFailure[] = [];
  if (!opts._preloadedTests) {
    const files = await discoverFiles(config.local.include, config.local.exclude, configDir);
    const parsed = await parseLocalFiles(files, config, opts.tags);
    resolvedTests = parsed.tests;
    parseFailures = parsed.failures;
  }
  failOnParseErrors('push', parseFailures);

  // AI auto-summary: for code-based local types, default to the local node-llama-cpp
  // provider (with heuristic fallback) when no explicit aiSummary opts are provided.
  // If no GGUF model path is set, the local provider transparently falls back to
  // heuristic mode so the push always succeeds even without a model installed.
  const effectiveAiOpts: AiSummaryOpts | undefined =
    opts._preloadedTests ? undefined  // AI already applied in multi-plan pre-pass
    : opts.aiSummary ?? (CODE_TYPES.has(config.local.type) ? { provider: 'local', heuristicFallback: true } : undefined);

  if (effectiveAiOpts) {
    const aiTargets = resolvedTests.filter(t => t.steps.length === 0 || !t.description);
    let aiDone = 0;
    for (const test of resolvedTests) {
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

  // Preflight: validate project + plan ID before processing any tests.
  // A bad plan ID or missing PAT permission causes every test to fail — catch it early.
  if (!opts.dryRun) {
    try {
      const planApi = await client.getTestPlanApi();
      const plan = await planApi.getTestPlanById(config.project, config.testPlan.id);
      if (!plan?.id) {
        throw new Error(
          `Test Plan ${config.testPlan.id} not found in project "${config.project}". ` +
          `Verify testPlan.id and the project name in your config.`
        );
      }
    } catch (err: unknown) {
      const httpStatus = (err as any)?.statusCode ?? (err as any)?.status;
      const status: string = httpStatus ? ` (HTTP ${httpStatus})` : '';
      const base: string = err instanceof Error ? err.message : String(err);
      // Don't double-wrap if we threw the descriptive message above
      if (base.includes('not found in project')) throw err;
      throw new Error(
        `Preflight failed — could not reach project "${config.project}" / plan ${config.testPlan.id}${status}.\n` +
        `  Detail: ${base}\n` +
        `  Check: correct project name, testPlan.id, and that your PAT has "Test Management: Read & Write" permission.`
      );
    }
  }

  const tagPrefix = getPreferredMarkerTagPrefix(config);
  const titleField = config.sync?.titleField ?? 'System.Title';
  const conflictAction = config.sync?.conflictAction ?? 'overwrite';
  const disableLocal = config.sync?.disableLocalChanges ?? false;
  const byFolder = config.testPlan.suiteMapping === 'byFolder' || config.testPlan.suiteMapping === 'byFile';

  // Load local cache for conflict detection and skip optimisation
  const cache = loadCache(configDir);

  // G: seed in-memory suite cache from persisted _suites to avoid redundant API calls
  const suiteCache = new Map<string, number>(Object.entries(cache._suites ?? {}));
  const conditionSuiteCache = new Map<string, number>();
  const results: SyncResult[] = [];
  const conflicts: SyncResult[] = [];
  const createdIds = new Set<number>();
  const pendingWritebacks: Array<{ test: ParsedTest; newId: number }> = [];

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
  const unlinkedWithAtName = resolvedTests.filter(t => !t.azureId && t.automatedTestName);
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

  // ── Parallel pre-fetch of remote TCs ────────────────────────────────────
  // For suites with many linked tests, fetching each TC individually is slow.
  // Pre-fetch all linked IDs concurrently (up to 8 in-flight at once) and store
  // them in a Map so the sync loop can look them up without extra round-trips.
  const linkedTests = resolvedTests.filter((t) => t.azureId !== undefined);
  const remoteTcCache = new Map<number, AzureTestCase | null>();

  if (linkedTests.length > 0) {
    const CONCURRENCY = 8;
    const queue = [...linkedTests];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const t = queue.shift();
        if (!t?.azureId) continue;
        if (remoteTcCache.has(t.azureId)) continue;
        try {
          const tc = await getTestCase(client, t.azureId, titleField);
          remoteTcCache.set(t.azureId, tc);
        } catch {
          remoteTcCache.set(t.azureId, null);
        }
      }
    });
    await Promise.all(workers);
  }

  let done = 0;
  const reportProgress = (result: SyncResult) => {
    results.push(result);
    opts.onProgress?.(++done, resolvedTests.length, result);
  };

  // Concurrency invariant: workers share pushQueue, results, pendingWritebacks,
  // suiteCache, and conditionSuiteCache via plain Array/Map mutations. This is
  // safe because Node.js is single-threaded — array.shift() and map.set() execute
  // atomically within a tick. Suspension only occurs at `await` boundaries, so
  // no two workers mutate shared state simultaneously.
  const PUSH_CONCURRENCY = 4;
  const pushQueue = [...resolvedTests];
  const pushWorkers = Array.from({ length: Math.min(PUSH_CONCURRENCY, pushQueue.length) }, async () => {
    while (pushQueue.length > 0) {
      const test = pushQueue.shift()!;
      if (test.azureId) {
        try {
          const cached = cache[test.azureId];
          // Use pre-fetched TC from cache; fall back to live fetch on miss
          const remote = remoteTcCache.has(test.azureId)
            ? remoteTcCache.get(test.azureId)!
            : await getTestCase(client, test.azureId, titleField);

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
          const { changedFields, diffDetail } = buildPushDiff(test, remote, config, cached);

          if (changedFields.length === 0) {
            // Update cache entry even on skip (changedDate may differ due to other fields)
            updateCacheEntry(cache, test, remote);
            reportProgress({ action: 'skipped', filePath: test.filePath, title: test.title, azureId: test.azureId });
            continue;
          }

          // Conflict detection: remote was changed since last push AND local also differs
          if (cached && remote.changedDate && remote.changedDate !== cached.changedDate) {
            const relFile = path.relative(configDir, test.filePath);
            const conflict: SyncResult = {
              action: 'conflict',
              filePath: test.filePath,
              title: test.title,
              azureId: test.azureId,
              changedFields,
              diffDetail,
              detail: `${relFile}:${test.line} — changed fields: ${changedFields.join(', ')}`,
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
            const updated = await getTestCase(client, test.azureId, titleField);
            if (updated) updateCacheEntry(cache, test, updated);
          }
          reportProgress({ action: 'updated', filePath: test.filePath, title: test.title, azureId: test.azureId, changedFields, diffDetail });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          reportProgress({ action: 'error', filePath: test.filePath, title: test.title, azureId: test.azureId, detail: msg });
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
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          reportProgress({ action: 'error', filePath: test.filePath, title: test.title, detail: msg });
        }
      }
    }
  });
  await Promise.all(pushWorkers);

  if (conflicts.length) {
    const lines = conflicts.map((c) => {
      const fields = c.changedFields?.length ? `\n          Changed fields: ${c.changedFields.join(', ')}` : '';
      return `  [#${c.azureId}] ${c.detail ?? c.title}${fields}`;
    }).join('\n\n');
    throw new Error(`Conflicts detected — push aborted (conflictAction=fail):\n\n${lines}`);
  }

  // Playwright migration: convert existing comment-style IDs to native annotations.
  // For all other framework types this is a no-op.
  if (!opts.dryRun && !disableLocal && config.local.type === 'playwright') {
    const alreadyQueued = new Set(pendingWritebacks.map((wb) => `${wb.test.filePath}:${wb.test.line}`));
    for (const test of resolvedTests) {
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
    for (const test of resolvedTests) {
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

  // Removed TC detection is only safe on full-scope runs.
  // Tag-filtered or condition-filtered pushes intentionally operate on a subset.
  const shouldDetectRemoved = !opts.tags && !config.local.condition;
  if (shouldDetectRemoved) {
    try {
      // Reuse the pre-loaded remote TCs if we already fetched them for automatedTestName
      // matching, otherwise fetch now. This avoids a redundant round-trip.
      const remoteTcs = preloadedRemoteTcs ?? await getTestCasesInSuite(client, config);
      const localIds = new Set([
        ...(resolvedTests.map((t) => t.azureId).filter(Boolean) as number[]),
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
    // G: persist suite name→id map so the next push avoids redundant API traversals
    if (suiteCache.size > 0) {
      cache._suites = Object.fromEntries(suiteCache.entries());
    }
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
  const parsed = await parseLocalFiles(files, config, opts.tags);
  failOnParseErrors('pull', parsed.failures);
  const tests = parsed.tests;
  const client = await AzureClient.create(config);
  const titleField = config.sync?.titleField ?? 'System.Title';
  const tagPrefix = getPreferredMarkerTagPrefix(config);
  const disableLocal = config.sync?.disableLocalChanges ?? false;
  const results: SyncResult[] = [];
  const cache = loadCache(configDir);

  const linked = tests.filter((t) => t.azureId !== undefined);

  let done = 0;
  const reportProgress = (result: SyncResult) => {
    results.push(result);
    opts.onProgress?.(++done, linked.length, result);
  };

  const canWriteToLocal = supportsPullWriteback(config.local.type);

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

      const desiredAzure = buildAzureSyncContent(test, config.sync?.format);
      const titleChanged = remote.title !== desiredAzure.title;
      const remoteStepsText = remote.steps.map((s) => `${s.action}|${s.expected ?? ''}`).join('\n');
      const localStepsText = desiredAzure.steps.map((s) => `${s.action}|${s.expected ?? ''}`).join('\n');
      const stepsChanged = remoteStepsText !== localStepsText;
      const descriptionChanged = (remote.description ?? '') !== (test.description ?? '');

      if (!titleChanged && !stepsChanged && !descriptionChanged) {
        reportProgress({ action: 'skipped', filePath: test.filePath, title: test.title, azureId: test.azureId });
        continue;
      }

      if (!opts.dryRun) {
        if (disableLocal) {
          reportProgress({
            action: 'skipped',
            filePath: test.filePath,
            title: remote.title,
            azureId: test.azureId,
            detail: [
              titleChanged && 'title',
              stepsChanged && 'steps',
              descriptionChanged && 'description',
            ].filter(Boolean).join(', ') + ' changed (local changes skipped)',
          });
          continue;
        }

        if (!canWriteToLocal) {
          reportProgress({
            action: 'error',
            filePath: test.filePath,
            title: test.title,
            azureId: test.azureId,
            detail: `Pull is not supported for local.type "${config.local.type}".`,
          });
          continue;
        }

        applyRemoteToLocal(
          test,
          remote.title,
          remote.steps.map((s) => ({ keyword: 'Step', text: s.action, expected: s.expected })),
          remote.description,
          config.local.type,
          tagPrefix
        );
        updateCacheEntry(cache, {
          ...test,
          title: remote.title,
          description: remote.description,
          steps: remote.steps.map((s) => ({ keyword: 'Step', text: s.action, expected: s.expected })),
        }, remote);
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      reportProgress({ action: 'error', filePath: test.filePath, title: test.title, azureId: test.azureId, detail: msg });
    }
  }

  // Pull-create: generate new local files for Azure TCs that have no local counterpart
  if (config.sync?.pull?.enableCreatingNewLocalTestCases && !disableLocal) {
    if (!supportsPullWriteback(config.local.type)) {
      results.push({
        action: 'error',
        filePath: '',
        title: '',
        detail: `Pull-create is not supported for local.type "${config.local.type}".`,
      });
    } else {
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
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ action: 'error', filePath: '', title: tc.title, azureId: tc.id, detail: `pull-create: ${msg}` });
          }
        }
      } catch { /* best-effort */ }
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
    // E: also store the remote description hash to detect Azure-side description changes.
    remoteDescriptionHash: hashString(remote.description),
    changedDate: remote.changedDate,
    filePath: test.filePath,
  };
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
  } else if (localType === 'excel') {
    throw new Error('Pull is not supported for local.type "excel" (in-place xlsx editing is not implemented).');
  }
  // csharp / java / python / javascript / etc.: pull not supported (code files are managed locally)
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

// stripHtml is imported from ../html (shared, XSS-safe — does not decode &lt;/&gt;)

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
  const isGherkin = localType === 'gherkin' || localType === 'reqnroll';
  const ext = isGherkin ? '.feature' : '.md';

  // I: consistent kebab-case filename with TC ID prefix
  const slug = tc.title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || `tc-${tc.id}`;
  const filename = `${tc.id}-${slug}${ext}`;

  const baseDir = path.resolve(configDir, config.sync?.pull?.targetFolder ?? '.');
  if (write) fs.mkdirSync(baseDir, { recursive: true });
  const filePath = path.join(baseDir, filename);

  if (write) {
    const content = isGherkin
      ? buildPullGherkinContent(tc, tagPrefix)
      : buildPullMarkdownContent(tc, tagPrefix);
    fs.writeFileSync(filePath, content, 'utf8');
  }

  return filePath;
}

function buildPullGherkinContent(tc: AzureTestCase, tagPrefix: string): string {
  const lines: string[] = [];
  // Tags above Feature: (non-ID tags)
  for (const tag of tc.tags) {
    if (!tag.startsWith(`${tagPrefix}:`)) lines.push(`@${tag}`);
  }
  lines.push(`Feature: ${tc.title}`);
  if (tc.description) {
    lines.push('');
    for (const line of stripHtml(tc.description).split('\n')) {
      lines.push(`  ${line}`);
    }
  }
  lines.push('');
  // Scenario with TC ID tag
  lines.push(`  @${tagPrefix}:${tc.id}`);
  lines.push(`  Scenario: ${tc.title}`);
  const keywords = ['Given', 'When', 'Then', 'And', 'But'];
  for (const step of tc.steps) {
    const action = step.action.trim();
    const hasKeyword = keywords.some((k) => action.toLowerCase().startsWith(k.toLowerCase() + ' '));
    const stepLine = hasKeyword ? `    ${action}` : `    * ${action}`;
    lines.push(stepLine);
    if (step.expected) {
      lines.push(`    # Expected: ${step.expected}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function buildPullMarkdownContent(tc: AzureTestCase, tagPrefix: string): string {
  const lines: string[] = [];
  lines.push(`# ${tc.title}`);
  lines.push('');
  // Metadata
  const metaTags = tc.tags.filter((t) => !t.startsWith(`${tagPrefix}:`));
  if (metaTags.length) {
    lines.push(`**Tags:** ${metaTags.map((t) => `\`${t}\``).join(', ')}`);
    lines.push('');
  }
  if (tc.description) {
    lines.push(stripHtml(tc.description));
    lines.push('');
  }
  // Scenario heading with TC ID
  lines.push(`### ${tc.title} @${tagPrefix}:${tc.id}`);
  lines.push('');
  if (tc.steps.length) {
    for (const step of tc.steps) {
      lines.push(`- ${step.action}`);
      if (step.expected) {
        lines.push(`  - _Expected:_ ${step.expected}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ─── Stale test case detection ────────────────────────────────────────────────

export interface StaleTestCase {
  id: number;
  title: string;
  tags: string[];
}

/**
 * Detect Azure DevOps Test Cases that have no corresponding local spec.
 * A TC is "stale" when it exists in the plan suite but no local file references it
 * via the tc-tag (e.g. @tc:12345). Stale TCs accumulate when specs are deleted locally
 * without running push, or when TCs are created directly in Azure without a local spec.
 */
export async function detectStaleTestCases(
  config: SyncConfig,
  configDir: string,
  opts: { tags?: string } = {}
): Promise<StaleTestCase[]> {
  const files = await discoverFiles(config.local.include, config.local.exclude, configDir);
  const parsed = await parseLocalFiles(files, config, opts.tags);
  failOnParseErrors('stale test case detection', parsed.failures);
  const tests = parsed.tests;
  const localIds = new Set(tests.map((t) => t.azureId).filter(Boolean) as number[]);

  const client = await AzureClient.create(config);
  const plans = config.testPlans?.length ? config.testPlans : [config.testPlan];
  const stale: StaleTestCase[] = [];

  for (const plan of plans) {
    const planConfig = config.testPlans?.length
      ? configForPlanEntry(config, plan as TestPlanEntry)
      : config;
    try {
      const remoteTcs = await getTestCasesInSuite(client, planConfig);
      for (const tc of remoteTcs) {
        if (!localIds.has(tc.id)) {
          stale.push({ id: tc.id, title: tc.title, tags: tc.tags });
        }
      }
    } catch { /* best-effort per-plan */ }
  }

  return stale;
}

// ─── Spec coverage report ─────────────────────────────────────────────────────

export interface CoverageReport {
  /** Total local specs discovered */
  totalLocalSpecs: number;
  /** Local specs that have an azureId (linked to a TC) */
  linkedSpecs: number;
  /** Local specs with NO azureId (never pushed) */
  unlinkedSpecs: number;
  /** Unique story IDs referenced via @story: (or configured link prefix) tags */
  storiesReferenced: number[];
  /** Story IDs that have at least one linked TC via a local spec */
  storiesCovered: number[];
  /** Story IDs with no linked TC in local specs */
  storiesUncovered: number[];
  /** Spec link rate as a percentage (0–100) */
  specLinkRate: number;
  /** Story coverage rate as a percentage (0–100), or -1 if no story refs found */
  storyCoverageRate: number;
}

/**
 * Compute a coverage report for local specs vs Azure DevOps.
 * Reports two metrics:
 *   1. Spec link rate   — % of local specs that have an @tc:ID (are synced to Azure)
 *   2. Story coverage   — % of referenced User Stories that have at least one linked spec
 */
export async function coverageReport(
  config: SyncConfig,
  configDir: string,
  opts: { tags?: string } = {}
): Promise<CoverageReport> {
  const files = await discoverFiles(config.local.include, config.local.exclude, configDir);
  const parsed = await parseLocalFiles(files, config, opts.tags);
  failOnParseErrors('coverage report', parsed.failures);
  const tests = parsed.tests;

  const linked   = tests.filter((t) => t.azureId !== undefined);
  const unlinked = tests.filter((t) => t.azureId === undefined);

  // Find story link prefix from sync.links config; default to 'story'
  const storyPrefix = config.sync?.links?.find((l) => l.prefix === 'story')?.prefix ?? 'story';
  const storyRe = new RegExp(`^(?:@)?${storyPrefix}:(\\d+)$`, 'i');

  // Collect all story IDs referenced via tags
  const allStoryIds = new Set<number>();
  const storiesWithLinkedSpec = new Set<number>();

  for (const test of tests) {
    for (const tag of test.tags) {
      const m = tag.match(storyRe);
      if (m) {
        const storyId = parseInt(m[1], 10);
        allStoryIds.add(storyId);
        if (test.azureId !== undefined) {
          storiesWithLinkedSpec.add(storyId);
        }
      }
    }
    // Also check linkRefs (parsed by link-aware parsers)
    for (const ref of test.linkRefs ?? []) {
      if (ref.prefix === storyPrefix) {
        allStoryIds.add(ref.id);
        if (test.azureId !== undefined) {
          storiesWithLinkedSpec.add(ref.id);
        }
      }
    }
  }

  const storiesUncovered = [...allStoryIds].filter((id) => !storiesWithLinkedSpec.has(id));
  const specLinkRate = tests.length > 0 ? Math.round((linked.length / tests.length) * 100) : 100;
  const storyCoverageRate = allStoryIds.size > 0
    ? Math.round((storiesWithLinkedSpec.size / allStoryIds.size) * 100)
    : -1;

  return {
    totalLocalSpecs:   tests.length,
    linkedSpecs:       linked.length,
    unlinkedSpecs:     unlinked.length,
    storiesReferenced: [...allStoryIds],
    storiesCovered:    [...storiesWithLinkedSpec],
    storiesUncovered,
    specLinkRate,
    storyCoverageRate,
  };
}
