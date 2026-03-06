/**
 * Publish test results to Azure DevOps test runs.
 *
 * Parses TRX, JUnit, NUnit XML, and Cucumber JSON result files then creates a
 * test run with results mapped back to Azure DevOps test cases.
 *
 * TC ID extraction strategy (in priority order):
 *
 *   1. Direct TC ID from result file:
 *      - TRX (MSTest):   [TestProperty("tc","12345")] → TestDefinitions/UnitTest/Properties/Property
 *      - NUnit XML:      [Property("tc","12345")]     → test-case/properties/property[@name="tc"]
 *      - JUnit XML:      <property name="tc" value="12345"/> inside <testcase><properties>
 *                        (pytest: add record_property hook in conftest.py; jest: custom reporter)
 *      - Cucumber JSON:  @tc:12345 tag on scenario
 *
 *   2. AutomatedTestName matching (fallback):
 *      When no TC ID is found, the result is published with automatedTestName set to the
 *      FQMN (testName). Azure DevOps links it to a TC via AutomatedTestName if markAutomated
 *      was used on push.
 *
 * NUnit TRX (via NUnit3TestAdapter) does NOT include [Property] values in the TRX format.
 * Use `--logger "nunit3;LogFileName=results.xml"` to get the native NUnit XML with properties.
 */

import { XMLParser } from 'fast-xml-parser';
import * as fs from 'fs';
import * as path from 'path';

import { AzureClient } from '../azure/client';
import { SyncConfig } from '../types';

// ─── Result file parsing ──────────────────────────────────────────────────────

export interface ParsedResult {
  /** automatedTestName — used to correlate back to a TC via AutomatedTestName */
  testName: string;
  outcome: string;
  durationMs: number;
  errorMessage?: string;
  stackTrace?: string;
  /** Azure TC id if extracted directly from the result file */
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

// ─── TRX parser (MSTest) ──────────────────────────────────────────────────────
//
// TRX structure relevant to TC ID extraction:
//
//   <TestRun>
//     <TestDefinitions>
//       <UnitTest name="..." id="GUID">
//         <Properties>
//           <Property><Key>tc</Key><Value>12345</Value></Property>
//         </Properties>
//         <TestMethod className="Namespace.ClassName" name="MethodName" />
//       </UnitTest>
//     </TestDefinitions>
//     <Results>
//       <UnitTestResult testId="GUID" testName="..." outcome="Passed" .../>
//     </Results>
//   </TestRun>
//
// UnitTestResult.testId → UnitTest.id → Properties → tc value

function parseTrx(content: string, tagPrefix: string, treatInconclusiveAs?: string): ParsedResult[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['UnitTest', 'UnitTestResult', 'Property'].includes(name),
  });
  const doc = parser.parse(content);

  const testRun = doc.TestRun ?? doc.testRun;
  if (!testRun) return [];

  // Build map: testId (GUID) → Azure TC id, from [TestProperty("tc","...")] values
  const testIdToTcId = new Map<string, number>();
  const definitions = testRun.TestDefinitions ?? testRun.testDefinitions;
  if (definitions) {
    let unitTests = definitions.UnitTest ?? definitions.unitTest ?? [];
    if (!Array.isArray(unitTests)) unitTests = [unitTests];

    for (const ut of unitTests) {
      const testId: string = ut['@_id'] ?? '';
      if (!testId) continue;

      const propsNode = ut.Properties ?? ut.properties;
      if (!propsNode) continue;

      let props = propsNode.Property ?? propsNode.property ?? [];
      if (!Array.isArray(props)) props = [props];

      for (const prop of props) {
        const key = String(prop.Key ?? prop.key ?? '');
        const val = String(prop.Value ?? prop.value ?? '');
        if (key === tagPrefix) {
          const id = parseInt(val, 10);
          if (!isNaN(id)) testIdToTcId.set(testId, id);
          break;
        }
      }
    }
  }

  // Parse UnitTestResult entries
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

    // Look up TC id by testId → TestDefinitions → Properties
    const testId: string = r['@_testId'] ?? '';
    const testCaseId = testId ? testIdToTcId.get(testId) : undefined;

    return {
      testName: r['@_testName'] ?? '',
      outcome: normaliseOutcome(r['@_outcome'] ?? 'Unspecified', treatInconclusiveAs),
      durationMs: Math.round(durationMs),
      errorMessage: errorInfo?.Message ?? errorInfo?.message,
      stackTrace: errorInfo?.StackTrace ?? errorInfo?.stackTrace,
      testCaseId,
    };
  });
}

// ─── NUnit XML parser ─────────────────────────────────────────────────────────
//
// NUnit's native XML format (produced by --logger "nunit3;LogFileName=results.xml")
// includes [Property] values in each <test-case>, unlike the TRX format via NUnit3TestAdapter.
//
//   <test-run>
//     <test-suite type="TestFixture" fullname="Ns.Fixture">
//       <test-case fullname="Ns.Fixture.MethodName" result="Passed" duration="0.123">
//         <properties>
//           <property name="tc" value="12345" />
//         </properties>
//       </test-case>
//       <test-case fullname="Ns.Fixture.FailTest" result="Failed" duration="0.001">
//         <failure>
//           <message>Expected 1 but was 2</message>
//           <stack-trace>...</stack-trace>
//         </failure>
//       </test-case>
//     </test-suite>
//   </test-run>

function parseNUnitXml(content: string, tagPrefix: string, treatInconclusiveAs?: string): ParsedResult[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['test-suite', 'test-case', 'property'].includes(name),
  });
  const doc = parser.parse(content);

  const results: ParsedResult[] = [];

  function walkNode(node: any): void {
    // Collect test-cases at this level
    const cases: any[] = node['test-case'] ?? [];
    for (const tc of cases) {
      const fullName: string = tc['@_fullname'] ?? tc['@_name'] ?? '';
      const result: string  = tc['@_result'] ?? 'Inconclusive';
      const duration = parseFloat(tc['@_duration'] ?? '0');

      // Extract TC id from <properties>/<property name="tc" value="..."/>
      let testCaseId: number | undefined;
      const props: any[] = tc.properties?.property ?? [];
      for (const prop of props) {
        if (String(prop['@_name'] ?? '') === tagPrefix) {
          const id = parseInt(String(prop['@_value'] ?? ''), 10);
          if (!isNaN(id)) { testCaseId = id; break; }
        }
      }

      // Failure / error details
      let errorMessage: string | undefined;
      let stackTrace: string | undefined;
      const failure = tc.failure;
      if (failure) {
        errorMessage = String(failure.message ?? '');
        stackTrace   = String(failure['stack-trace'] ?? '');
      }

      results.push({
        testName: fullName,
        outcome: normaliseOutcome(result, treatInconclusiveAs),
        durationMs: Math.round(duration * 1000),
        errorMessage: errorMessage || undefined,
        stackTrace: stackTrace || undefined,
        testCaseId,
      });
    }

    // Recurse into nested test-suites
    const suites: any[] = node['test-suite'] ?? [];
    for (const suite of suites) walkNode(suite);
  }

  const testRunNode = doc['test-run'];
  if (testRunNode) walkNode(testRunNode);

  return results;
}

// ─── JUnit parser ─────────────────────────────────────────────────────────────
//
// Supports JUnit XML from:
//   - Maven Surefire / Failsafe (Java JUnit 4/5, TestNG)
//   - pytest --junitxml  (Python)
//   - jest-junit         (Jest / Jasmine / WebdriverIO)
//
// TC ID extraction:
//   - From <testcase><properties><property name="tc" value="N"/></properties></testcase>
//     (pytest: add record_property in conftest.py; jest: custom reporter)
//
// AutomatedTestName mapping:
//   - Uses testcase[@classname].testcase[@name] when classname is present.
//     This matches the automatedTestName format used by the Java and Python parsers
//     (e.g. "com.example.MyClass.myMethod" or "tests.module.TestClass.test_foo").
//   - Falls back to suite[@name].testcase[@name] when classname is absent.

function parseJUnit(content: string, tagPrefix: string, treatInconclusiveAs?: string): ParsedResult[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['testsuite', 'testcase', 'property'].includes(name),
  });
  const doc = parser.parse(content);

  const results: ParsedResult[] = [];
  const suites: any[] = doc.testsuites?.testsuite ?? (doc.testsuite ? [doc.testsuite] : []);

  for (const suite of suites) {
    let cases: any[] = suite.testcase ?? [];
    if (!Array.isArray(cases)) cases = [cases];

    for (const tc of cases) {
      let outcome = 'Passed';
      let errorMessage: string | undefined;
      let stackTrace: string | undefined;

      if (tc.failure) {
        outcome = 'Failed';
        const fail = typeof tc.failure === 'string' ? tc.failure : (tc.failure['#text'] ?? '');
        errorMessage = tc.failure['@_message'] ?? fail;
        stackTrace   = typeof tc.failure === 'string' ? tc.failure : tc.failure['#text'];
      } else if (tc.error) {
        outcome = 'Failed';
        errorMessage = tc.error['@_message'] ?? '';
        stackTrace   = typeof tc.error === 'string' ? tc.error : tc.error['#text'];
      } else if (tc.skipped !== undefined) {
        outcome = 'NotExecuted';
      }

      // Build automatedTestName: prefer classname.name (matches Java/Python parsers),
      // fall back to suiteName.name.
      const className  = tc['@_classname'] ?? '';
      const testCase   = tc['@_name'] ?? '';
      const suiteName  = suite['@_name'] ?? '';
      const testName   = className
        ? `${className}.${testCase}`
        : `${suiteName}.${testCase}`.replace(/^\./, '');

      // Extract TC ID from <properties><property name="tc" value="N"/></properties>
      // (e.g. added by a pytest conftest.py record_property hook or jest custom reporter)
      let testCaseId: number | undefined;
      const props: any[] = tc.properties?.property ?? [];
      for (const prop of props) {
        if (String(prop['@_name'] ?? '') === tagPrefix) {
          const id = parseInt(String(prop['@_value'] ?? ''), 10);
          if (!isNaN(id)) { testCaseId = id; break; }
        }
      }

      results.push({
        testName,
        outcome: normaliseOutcome(outcome, treatInconclusiveAs),
        durationMs: Math.round(parseFloat(tc['@_time'] ?? '0') * 1000),
        errorMessage,
        stackTrace,
        testCaseId,
      });
    }
  }

  return results;
}

// ─── Cucumber JSON parser ─────────────────────────────────────────────────────

function parseCucumberJson(content: string, tagPrefix: string, treatInconclusiveAs?: string): ParsedResult[] {
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

      // Extract TC id from @tc:NNN tag on the scenario
      let testCaseId: number | undefined;
      const tcPrefix = `@${tagPrefix}:`;
      for (const tag of element.tags ?? []) {
        if (tag.name?.startsWith(tcPrefix)) {
          const id = parseInt(tag.name.slice(tcPrefix.length), 10);
          if (!isNaN(id)) { testCaseId = id; break; }
        }
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
  if (content.trimStart().startsWith('<')) {
    if (content.includes('<TestRun') || content.includes('<testRun')) return 'trx';
    if (content.includes('<test-run'))  return 'nunitXml';
    if (content.includes('<testsuites') || content.includes('<testsuite')) return 'junit';
  }
  return 'junit';
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

  const tagPrefix = config.sync?.tagPrefix ?? 'tc';

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
        allResults.push(...parseTrx(content, tagPrefix, treatInconclusiveAs));
        break;
      case 'nunitXml':
        allResults.push(...parseNUnitXml(content, tagPrefix, treatInconclusiveAs));
        break;
      case 'junit':
        allResults.push(...parseJUnit(content, tagPrefix, treatInconclusiveAs));
        break;
      case 'cucumberJson':
        allResults.push(...parseCucumberJson(content, tagPrefix, treatInconclusiveAs));
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
  const other  = allResults.length - passed - failed;

  if (opts.dryRun) {
    return { runId: 0, runUrl: '', totalResults: allResults.length, passed, failed, other };
  }

  const client = await AzureClient.create(config);
  const testApi = await client.getTestApi();

  const runSettings = pubConfig?.testRunSettings;
  const runName = opts.runName ?? runSettings?.name ?? `ado-sync ${new Date().toISOString()}`;

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

  const testCaseResults = allResults.map((r) => {
    const result: any = {
      automatedTestName: r.testName,
      testCaseTitle: r.testName,
      outcome: r.outcome,
      state: 'Completed',
      durationInMs: r.durationMs,
    };
    if (r.errorMessage) result.errorMessage = r.errorMessage;
    if (r.stackTrace)   result.stackTrace   = r.stackTrace;
    // When a TC id was extracted from the result file, link directly by id.
    // This is more reliable than AutomatedTestName matching and works even when
    // the FQMN has changed since the TC was last pushed.
    if (r.testCaseId)   result.testCase = { id: String(r.testCaseId) };
    if (pubConfig?.testResultSettings?.comment) result.comment = pubConfig.testResultSettings.comment;
    return result;
  });

  await testApi.addTestResultsToTestRun(testCaseResults, config.project, runId);
  await testApi.updateTestRun({ state: 'Completed' } as any, config.project, runId);

  const runUrl = `${config.orgUrl}/${config.project}/_testManagement/runs?runId=${runId}`;
  return { runId, runUrl, totalResults: allResults.length, passed, failed, other };
}
