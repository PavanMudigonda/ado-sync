/**
 * Publish test results to Azure DevOps test runs.
 *
 * Parses TRX, JUnit, and Cucumber JSON result files then creates a test run
 * with results mapped back to Azure DevOps test cases via the sync tag.
 */

import { XMLParser } from 'fast-xml-parser';
import * as fs from 'fs';
import * as path from 'path';

import { AzureClient } from '../azure/client';
import { SyncConfig } from '../types';

// ─── Result file parsing ──────────────────────────────────────────────────────

export interface ParsedResult {
  /** automatedTestName — used to correlate back to a TC */
  testName: string;
  outcome: string;
  durationMs: number;
  errorMessage?: string;
  stackTrace?: string;
  /** Azure TC id if we can map it */
  testCaseId?: number;
}

/** Normalise outcome strings from various formats to Azure DevOps valid values. */
function normaliseOutcome(raw: string, treatInconclusiveAs?: string): string {
  const lower = raw.toLowerCase();
  if (lower === 'passed' || lower === 'pass' || lower === 'success') return 'Passed';
  if (lower === 'failed' || lower === 'fail' || lower === 'failure' || lower === 'error') return 'Failed';
  if (lower === 'skipped' || lower === 'ignored' || lower === 'pending' || lower === 'notexecuted') return 'NotExecuted';
  if (lower === 'inconclusive') return treatInconclusiveAs ?? 'Inconclusive';
  return raw;
}

// ─── TRX parser ───────────────────────────────────────────────────────────────

function parseTrx(content: string, treatInconclusiveAs?: string): ParsedResult[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(content);

  const testRun = doc.TestRun ?? doc.testRun;
  if (!testRun) return [];

  const resultsNode = testRun.Results ?? testRun.results;
  if (!resultsNode) return [];

  let unitResults = resultsNode.UnitTestResult ?? resultsNode.unitTestResult ?? [];
  if (!Array.isArray(unitResults)) unitResults = [unitResults];

  return unitResults.map((r: any): ParsedResult => {
    const duration = r['@_duration'] ?? '00:00:00';
    const parts = duration.split(':');
    const durationMs = parts.length === 3
      ? (parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2])) * 1000
      : 0;

    const output = r.Output ?? r.output;
    const errorInfo = output?.ErrorInfo ?? output?.errorInfo;

    return {
      testName: r['@_testName'] ?? '',
      outcome: normaliseOutcome(r['@_outcome'] ?? 'Unspecified', treatInconclusiveAs),
      durationMs: Math.round(durationMs),
      errorMessage: errorInfo?.Message ?? errorInfo?.message,
      stackTrace: errorInfo?.StackTrace ?? errorInfo?.stackTrace,
    };
  });
}

// ─── JUnit parser ─────────────────────────────────────────────────────────────

function parseJUnit(content: string, treatInconclusiveAs?: string): ParsedResult[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(content);

  const results: ParsedResult[] = [];
  const suites = doc.testsuites?.testsuite ?? doc.testsuite ?? [];
  const suiteList = Array.isArray(suites) ? suites : [suites];

  for (const suite of suiteList) {
    let cases = suite.testcase ?? [];
    if (!Array.isArray(cases)) cases = [cases];

    for (const tc of cases) {
      let outcome = 'Passed';
      let errorMessage: string | undefined;
      let stackTrace: string | undefined;

      if (tc.failure) {
        outcome = 'Failed';
        const fail = typeof tc.failure === 'string' ? tc.failure : tc.failure['#text'] ?? '';
        errorMessage = tc.failure['@_message'] ?? fail;
        stackTrace = typeof tc.failure === 'string' ? tc.failure : tc.failure['#text'];
      } else if (tc.error) {
        outcome = 'Failed';
        errorMessage = tc.error['@_message'] ?? '';
        stackTrace = typeof tc.error === 'string' ? tc.error : tc.error['#text'];
      } else if (tc.skipped !== undefined) {
        outcome = 'NotExecuted';
      }

      results.push({
        testName: `${suite['@_name'] ?? ''}.${tc['@_name'] ?? ''}`.replace(/^\./, ''),
        outcome: normaliseOutcome(outcome, treatInconclusiveAs),
        durationMs: Math.round(parseFloat(tc['@_time'] ?? '0') * 1000),
        errorMessage,
        stackTrace,
      });
    }
  }

  return results;
}

// ─── Cucumber JSON parser ─────────────────────────────────────────────────────

function parseCucumberJson(content: string, treatInconclusiveAs?: string): ParsedResult[] {
  const features = JSON.parse(content);
  const results: ParsedResult[] = [];

  for (const feature of features) {
    for (const element of feature.elements ?? []) {
      if (element.type !== 'scenario') continue;

      let totalDuration = 0;
      let worstOutcome = 'Passed';
      let errorMsg: string | undefined;

      for (const step of element.steps ?? []) {
        const result = step.result ?? {};
        totalDuration += result.duration ?? 0;
        const status = result.status ?? 'undefined';

        if (status === 'failed' && worstOutcome !== 'Failed') {
          worstOutcome = 'Failed';
          errorMsg = result.error_message;
        } else if (status === 'skipped' || status === 'pending' || status === 'undefined') {
          if (worstOutcome === 'Passed') worstOutcome = 'NotExecuted';
        }
      }

      // Extract tc id from tags if present
      let testCaseId: number | undefined;
      for (const tag of element.tags ?? []) {
        const match = tag.name?.match(/@tc:(\d+)/);
        if (match) { testCaseId = parseInt(match[1]); break; }
      }

      results.push({
        testName: `${feature.name}: ${element.name}`,
        outcome: normaliseOutcome(worstOutcome, treatInconclusiveAs),
        durationMs: Math.round(totalDuration / 1e6), // cucumber reports in nanoseconds
        errorMessage: errorMsg,
        testCaseId,
      });
    }
  }

  return results;
}

// ─── Auto-detect format ───────────────────────────────────────────────────────

function detectFormat(filePath: string, content: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.trx') return 'trx';
  if (ext === '.json') return 'cucumberJson';
  // Try XML detection
  if (content.trimStart().startsWith('<')) {
    if (content.includes('<TestRun') || content.includes('<testRun')) return 'trx';
    if (content.includes('<testsuites') || content.includes('<testsuite')) return 'junit';
  }
  return 'junit'; // default
}

// ─── Publish orchestration ────────────────────────────────────────────────────

export interface PublishResult {
  runId: number;
  runUrl: string;
  totalResults: number;
  passed: number;
  failed: number;
  other: number;
}

export async function publishTestResults(
  config: SyncConfig,
  configDir: string,
  opts: {
    dryRun?: boolean;
    /** Override result sources from CLI */
    resultFiles?: string[];
    resultFormat?: string;
    runName?: string;
    buildId?: number;
  } = {}
): Promise<PublishResult> {
  const pubConfig = config.publishTestResults;
  if (!pubConfig && !opts.resultFiles?.length) {
    throw new Error('No publishTestResults configuration and no --testResult files specified.');
  }

  // Gather result files
  const sources: Array<{ filePath: string; format?: string }> = [];

  if (opts.resultFiles?.length) {
    for (const f of opts.resultFiles) {
      sources.push({ filePath: path.resolve(configDir, f), format: opts.resultFormat });
    }
  } else if (pubConfig?.testResult?.sources) {
    for (const src of pubConfig.testResult.sources) {
      sources.push({ filePath: path.resolve(configDir, src.value), format: src.format });
    }
  }

  // Parse all result files
  const allResults: ParsedResult[] = [];
  const treatInconclusiveAs = pubConfig?.treatInconclusiveAs;

  for (const src of sources) {
    if (!fs.existsSync(src.filePath)) {
      throw new Error(`Test result file not found: ${src.filePath}`);
    }
    const content = fs.readFileSync(src.filePath, 'utf8');
    const format = src.format ?? detectFormat(src.filePath, content);

    switch (format) {
      case 'trx':
        allResults.push(...parseTrx(content, treatInconclusiveAs));
        break;
      case 'junit':
        allResults.push(...parseJUnit(content, treatInconclusiveAs));
        break;
      case 'cucumberJson':
        allResults.push(...parseCucumberJson(content, treatInconclusiveAs));
        break;
      default:
        throw new Error(`Unsupported test result format: ${format}`);
    }
  }

  if (!allResults.length) {
    throw new Error('No test results found in the specified files.');
  }

  const passed = allResults.filter((r) => r.outcome === 'Passed').length;
  const failed = allResults.filter((r) => r.outcome === 'Failed').length;
  const other = allResults.length - passed - failed;

  if (opts.dryRun) {
    return { runId: 0, runUrl: '', totalResults: allResults.length, passed, failed, other };
  }

  const client = await AzureClient.create(config);
  const testApi = await client.getTestApi();

  const runSettings = pubConfig?.testRunSettings;
  const runName = opts.runName ?? runSettings?.name ?? `ado-sync ${new Date().toISOString()}`;

  // Create test run
  const runModel: any = {
    name: runName,
    plan: { id: String(config.testPlan.id) },
    automated: runSettings?.runType === 'Manual' ? false : true,
    configurationIds: pubConfig?.testConfiguration?.id ? [pubConfig.testConfiguration.id] : [],
  };

  if (runSettings?.comment) runModel.comment = runSettings.comment;
  if (opts.buildId) runModel.build = { id: String(opts.buildId) };

  const run = await testApi.createTestRun(runModel, config.project);
  const runId = run.id!;

  // Add results
  const testCaseResults = allResults.map((r) => {
    const result: any = {
      automatedTestName: r.testName,
      testCaseTitle: r.testName,
      outcome: r.outcome,
      state: 'Completed',
      durationInMs: r.durationMs,
    };
    if (r.errorMessage) result.errorMessage = r.errorMessage;
    if (r.stackTrace) result.stackTrace = r.stackTrace;
    if (r.testCaseId) result.testCase = { id: String(r.testCaseId) };
    if (pubConfig?.testResultSettings?.comment) result.comment = pubConfig.testResultSettings.comment;
    return result;
  });

  await testApi.addTestResultsToTestRun(testCaseResults, config.project, runId);

  // Complete the run
  await testApi.updateTestRun({ state: 'Completed' } as any, config.project, runId);

  const runUrl = `${config.orgUrl}/${config.project}/_testManagement/runs?runId=${runId}`;

  return { runId, runUrl, totalResults: allResults.length, passed, failed, other };
}
