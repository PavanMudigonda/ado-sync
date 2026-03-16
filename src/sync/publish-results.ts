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
import { glob } from 'glob';
import * as path from 'path';

import { AzureClient } from '../azure/client';
import { SyncConfig } from '../types';

// ─── Result file parsing ──────────────────────────────────────────────────────

/**
 * Azure DevOps AttachmentType enum values (from TestInterfaces.AttachmentType).
 * Only GeneralAttachment and ConsoleLog are universally supported for test result
 * attachments. We use these two: screenshots/videos → GeneralAttachment, logs → ConsoleLog.
 */
export type AttachmentType = 'GeneralAttachment' | 'ConsoleLog';

export interface TestAttachment {
  fileName: string;
  data: Buffer;
  attachmentType: AttachmentType;
}

export interface ParsedResult {
  /** automatedTestName — used to correlate back to a TC via AutomatedTestName */
  testName: string;
  outcome: string;
  durationMs: number;
  errorMessage?: string;
  stackTrace?: string;
  /** Azure TC id if extracted directly from the result file */
  testCaseId?: number;
  /** Screenshots, videos, logs and other files to attach to this result in Azure DevOps */
  attachments?: TestAttachment[];
}

// ─── Attachment helpers ───────────────────────────────────────────────────────

/** Map a file extension to the Azure DevOps attachment type. */
function extToAttachmentType(ext: string): AttachmentType {
  const e = ext.toLowerCase();
  // Log/text files → ConsoleLog; everything else (images, video, zip…) → GeneralAttachment
  if (['.log', '.txt'].includes(e)) return 'ConsoleLog';
  return 'GeneralAttachment';
}

/** Mime type → attachment type for Cucumber JSON embeddings. */
function mimeToAttachmentType(mime: string): AttachmentType {
  if (mime.startsWith('text/')) return 'ConsoleLog';
  return 'GeneralAttachment';
}

/** Extension for a given mime type (best-effort). */
function mimeToExt(mime: string): string {
  if (mime.includes('png'))  return '.png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('gif'))  return '.gif';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('mp4'))  return '.mp4';
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('text')) return '.txt';
  if (mime.includes('html')) return '.html';
  return '.bin';
}

/** Safely read a file from disk; returns undefined if the file is missing or unreadable. */
function safeReadFile(filePath: string): Buffer | undefined {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return undefined;
  }
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

function parseTrx(content: string, tagPrefix: string, treatInconclusiveAs?: string, resultFileDir = ''): ParsedResult[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['UnitTest', 'UnitTestResult', 'Property', 'ResultFile'].includes(name),
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

    // Extract stdout as a ConsoleLog attachment
    const attachments: TestAttachment[] = [];
    const stdOut = String(output?.StdOut ?? output?.stdOut ?? '').trim();
    if (stdOut) {
      attachments.push({ fileName: 'stdout.log', data: Buffer.from(stdOut, 'utf8'), attachmentType: 'ConsoleLog' });
    }
    // Extract <ResultFiles> — files produced by the test (e.g. screenshots via TestContext.AddResultFile)
    // In TRX, ResultFiles is a child of Output, not a direct child of UnitTestResult.
    const resultFilesNode = output?.ResultFiles ?? output?.resultFiles ?? r.ResultFiles ?? r.resultFiles;
    const resultFiles: any[] = resultFilesNode?.ResultFile ?? resultFilesNode?.resultFile ?? [];
    for (const rf of (Array.isArray(resultFiles) ? resultFiles : [resultFiles])) {
      const filePath = rf['@_path'] ?? '';
      if (!filePath) continue;
      const absPath = resultFileDir ? path.resolve(resultFileDir, filePath) : filePath;
      const data = safeReadFile(absPath);
      if (data) attachments.push({ fileName: path.basename(filePath), data, attachmentType: extToAttachmentType(path.extname(filePath)) });
    }

    return {
      testName: r['@_testName'] ?? '',
      outcome: normaliseOutcome(r['@_outcome'] ?? 'Unspecified', treatInconclusiveAs),
      durationMs: Math.round(durationMs),
      errorMessage: errorInfo?.Message ?? errorInfo?.message,
      stackTrace: errorInfo?.StackTrace ?? errorInfo?.stackTrace,
      testCaseId,
      attachments: attachments.length ? attachments : undefined,
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

function parseNUnitXml(content: string, tagPrefix: string, treatInconclusiveAs?: string, resultFileDir = ''): ParsedResult[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['test-suite', 'test-case', 'property', 'attachment'].includes(name),
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

      // Extract console output as a log attachment
      const nunitAttachments: TestAttachment[] = [];
      const outputText = String(tc.output ?? '').trim();
      if (outputText) {
        nunitAttachments.push({ fileName: 'output.log', data: Buffer.from(outputText, 'utf8'), attachmentType: 'ConsoleLog' });
      }
      // Extract <attachments> — files attached via NUnit's TestContext.AddAttachment()
      const fileAtts: any[] = tc.attachments?.attachment ?? [];
      for (const att of fileAtts) {
        const filePath = String(att.filePath ?? att['filePath'] ?? '').trim();
        if (!filePath) continue;
        const absPath = resultFileDir ? path.resolve(resultFileDir, filePath) : filePath;
        const data = safeReadFile(absPath);
        if (data) nunitAttachments.push({ fileName: path.basename(filePath), data, attachmentType: extToAttachmentType(path.extname(filePath)) });
      }

      results.push({
        testName: fullName,
        outcome: normaliseOutcome(result, treatInconclusiveAs),
        durationMs: Math.round(duration * 1000),
        errorMessage: errorMessage || undefined,
        stackTrace: stackTrace || undefined,
        testCaseId,
        attachments: nunitAttachments.length ? nunitAttachments : undefined,
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

function parseJUnit(content: string, tagPrefix: string, treatInconclusiveAs?: string, resultFileDir = ''): ParsedResult[] {
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

      // Extract <system-out> and <system-err> as log attachments.
      // Playwright JUnit XML uses [[ATTACHMENT|path]] markers inside <system-out>
      // to reference screenshot/video/trace files saved on disk.
      const junitAttachments: TestAttachment[] = [];
      const sysOut = String(tc['system-out'] ?? '').trim();
      if (sysOut) {
        // Extract Playwright [[ATTACHMENT|path]] references first
        const playwrightRe = /\[\[ATTACHMENT\|([^\]]+)\]\]/g;
        let m: RegExpExecArray | null;
        let logText = sysOut;
        while ((m = playwrightRe.exec(sysOut)) !== null) {
          const filePath = m[1].trim();
          const absPath = resultFileDir ? path.resolve(resultFileDir, filePath) : filePath;
          const data = safeReadFile(absPath);
          if (data) junitAttachments.push({ fileName: path.basename(filePath), data, attachmentType: extToAttachmentType(path.extname(filePath)) });
          logText = logText.replace(m[0], '').trim();
        }
        if (logText) junitAttachments.push({ fileName: 'system-out.log', data: Buffer.from(logText, 'utf8'), attachmentType: 'ConsoleLog' });
      }
      const sysErr = String(tc['system-err'] ?? '').trim();
      if (sysErr) junitAttachments.push({ fileName: 'system-err.log', data: Buffer.from(sysErr, 'utf8'), attachmentType: 'ConsoleLog' });

      results.push({
        testName,
        outcome: normaliseOutcome(outcome, treatInconclusiveAs),
        durationMs: Math.round(parseFloat(tc['@_time'] ?? '0') * 1000),
        errorMessage,
        stackTrace,
        testCaseId,
        attachments: junitAttachments.length ? junitAttachments : undefined,
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

      // Extract embeddings (base64 screenshots/video embedded by Selenium hooks)
      const cucumberAttachments: TestAttachment[] = [];
      let screenshotIdx = 0;
      for (const step of element.steps ?? []) {
        for (const emb of step.embeddings ?? []) {
          const mime: string = emb.mime_type ?? emb.mediaType ?? 'application/octet-stream';
          const ext = mimeToExt(mime);
          const data = Buffer.from(emb.data ?? '', 'base64');
          cucumberAttachments.push({ fileName: `screenshot_${++screenshotIdx}${ext}`, data, attachmentType: mimeToAttachmentType(mime) });
        }
      }

      results.push({
        testName: `${feature.name}: ${element.name}`,
        outcome: normaliseOutcome(worstOutcome, treatInconclusiveAs),
        durationMs: Math.round(totalDuration / 1e6), // cucumber reports in nanoseconds
        errorMessage: errorMsg,
        testCaseId,
        attachments: cucumberAttachments.length ? cucumberAttachments : undefined,
      });
    }
  }

  return results;
}

// ─── Playwright JSON parser ───────────────────────────────────────────────────
//
// Playwright's built-in JSON reporter (--reporter=json) format:
//
//   {
//     "suites": [{
//       "specs": [{
//         "title": "my test",
//         "tests": [{
//           "status": "failed",
//           "results": [{
//             "status": "failed",
//             "duration": 1234,
//             "error": { "message": "...", "stack": "..." },
//             "attachments": [
//               { "name": "screenshot", "contentType": "image/png", "path": "/abs/path/screenshot.png" },
//               { "name": "video",      "contentType": "video/webm", "path": "/abs/path/video.webm" },
//               { "name": "trace",      "contentType": "application/zip", "path": "/abs/path/trace.zip" }
//             ]
//           }]
//         }]
//       }]
//     }]
//   }

function parsePlaywrightJson(content: string, tagPrefix: string, treatInconclusiveAs?: string, resultFileDir = ''): ParsedResult[] {
  const report = JSON.parse(content);
  const results: ParsedResult[] = [];

  function walkSuites(suites: any[], titlePath: string[]): void {
    for (const suite of suites ?? []) {
      const currentPath = suite.title ? [...titlePath, suite.title] : titlePath;

      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          // Playwright flaky tests may have multiple results; take last (final) attempt
          const resultEntries: any[] = test.results ?? [];
          const lastResult = resultEntries[resultEntries.length - 1];
          if (!lastResult) continue;

          const rawStatus: string = lastResult.status ?? test.status ?? 'failed';
          let outcome: string;
          if (rawStatus === 'passed') outcome = 'Passed';
          else if (rawStatus === 'skipped' || rawStatus === 'pending') outcome = 'NotExecuted';
          else outcome = 'Failed';
          outcome = normaliseOutcome(outcome, treatInconclusiveAs);

          // Build test name from suite title path + spec title
          const testName = [...currentPath, spec.title].join(' > ');

          // Extract TC id — check native annotations first, then @tc:NNN in spec title
          let testCaseId: number | undefined;

          // 1. Native annotation: { type: 'tc', description: '12345' } on any test attempt
          for (const res of resultEntries) {
            for (const ann of res.annotations ?? test.annotations ?? []) {
              if (String(ann.type) === tagPrefix) {
                const id = parseInt(String(ann.description ?? ''), 10);
                if (!isNaN(id)) { testCaseId = id; break; }
              }
            }
            if (testCaseId !== undefined) break;
          }
          // Also check top-level test.annotations (Playwright ≥ 1.42 hoists them here)
          if (testCaseId === undefined) {
            for (const ann of test.annotations ?? []) {
              if (String(ann.type) === tagPrefix) {
                const id = parseInt(String(ann.description ?? ''), 10);
                if (!isNaN(id)) { testCaseId = id; break; }
              }
            }
          }

          // 2. Fallback: @tc:NNN in spec title
          if (testCaseId === undefined) {
            const tcRe = new RegExp(`@${tagPrefix}:(\\d+)`);
            const titleMatch = spec.title?.match(tcRe);
            if (titleMatch) testCaseId = parseInt(titleMatch[1], 10);
          }

          // Extract attachments (screenshots, videos, traces) from all retried results
          const pwAttachments: TestAttachment[] = [];
          let attIdx = 0;
          for (const res of resultEntries) {
            for (const att of res.attachments ?? []) {
              const filePath: string = att.path ?? '';
              const contentType: string = att.contentType ?? '';
              const attName: string = att.name ?? `attachment_${++attIdx}`;
              const ext = filePath ? path.extname(filePath) : mimeToExt(contentType);
              const absPath = filePath
                ? (resultFileDir ? path.resolve(resultFileDir, filePath) : filePath)
                : undefined;
              const data = absPath ? safeReadFile(absPath) : (att.body ? Buffer.from(att.body, 'base64') : undefined);
              if (data) {
                pwAttachments.push({ fileName: `${attName}${ext || ''}`, data, attachmentType: mimeToAttachmentType(contentType) || extToAttachmentType(ext) });
              }
            }
          }

          results.push({
            testName,
            outcome,
            durationMs: lastResult.duration ?? 0,
            errorMessage: lastResult.error?.message,
            stackTrace: lastResult.error?.stack,
            testCaseId,
            attachments: pwAttachments.length ? pwAttachments : undefined,
          });
        }
      }

      // Recurse into nested suites
      walkSuites(suite.suites ?? [], currentPath);
    }
  }

  walkSuites(report.suites ?? [], []);
  return results;
}

// ─── Robot Framework XML parser ───────────────────────────────────────────────
//
// Robot Framework output.xml structure:
//
//   <robot>
//     <suite name="Suite Name">
//       <suite name="Sub Suite">
//         <test name="Test Name">
//           <tags><tag>smoke</tag><tag>tc:12345</tag></tags>
//           <kw name="Keyword">
//             <msg level="FAIL">Error message</msg>
//             <status status="FAIL" starttime="..." endtime="..."/>
//           </kw>
//           <status status="PASS" starttime="20250313 15:30:45.123" endtime="20250313 15:30:46.234"/>
//         </test>
//       </suite>
//     </suite>
//   </robot>

function parseRobotTimestamp(ts: string): number {
  // Format: "YYYYMMDD HH:MM:SS.mmm"
  if (!ts) return 0;
  const m = ts.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d+)$/);
  if (!m) return 0;
  return new Date(
    parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]),
    parseInt(m[4]), parseInt(m[5]), parseInt(m[6]), parseInt(m[7].padEnd(3, '0').slice(0, 3))
  ).getTime();
}

function parseRobotFramework(content: string, tagPrefix: string, treatInconclusiveAs?: string): ParsedResult[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['suite', 'test', 'tag', 'kw', 'msg'].includes(name),
  });
  const doc = parser.parse(content);
  const results: ParsedResult[] = [];

  function extractFailMessage(kws: any[]): string | undefined {
    for (const kw of kws ?? []) {
      const msgs: any[] = kw.msg ?? [];
      for (const msg of msgs) {
        if ((msg['@_level'] ?? '').toUpperCase() === 'FAIL') {
          return String(msg['#text'] ?? msg ?? '').trim() || undefined;
        }
      }
      // Recurse into nested keywords
      const nested = kw.kw ?? [];
      const inner = extractFailMessage(Array.isArray(nested) ? nested : [nested]);
      if (inner) return inner;
    }
    return undefined;
  }

  function walkSuites(suiteNode: any, suitePath: string[]): void {
    // Nested suites
    for (const child of suiteNode.suite ?? []) {
      const childName: string = child['@_name'] ?? '';
      walkSuites(child, [...suitePath, childName]);
    }

    // Tests in this suite
    for (const test of suiteNode.test ?? []) {
      const testName: string = test['@_name'] ?? '';
      const statusNode = test.status ?? {};
      const statusVal: string = statusNode['@_status'] ?? 'FAIL';
      const startTime: string = statusNode['@_starttime'] ?? statusNode['@_start'] ?? '';
      const endTime: string   = statusNode['@_endtime']   ?? statusNode['@_end']   ?? '';

      const durationMs = startTime && endTime
        ? Math.max(0, parseRobotTimestamp(endTime) - parseRobotTimestamp(startTime))
        : 0;

      let outcome = 'Failed';
      if (statusVal.toUpperCase() === 'PASS') outcome = 'Passed';
      else if (statusVal.toUpperCase() === 'SKIP') outcome = 'NotExecuted';
      outcome = normaliseOutcome(outcome, treatInconclusiveAs);

      // Extract TC ID from <tags><tag>tc:12345</tag></tags>
      let testCaseId: number | undefined;
      const tcRe = new RegExp(`^${tagPrefix}:(\\d+)$`, 'i');
      for (const tag of test.tags?.tag ?? []) {
        const tagStr = String(tag['#text'] ?? tag ?? '').trim();
        const m = tagStr.match(tcRe);
        if (m) { testCaseId = parseInt(m[1], 10); break; }
      }

      // Extract failure message from keywords
      let errorMessage: string | undefined;
      if (outcome === 'Failed') {
        errorMessage = extractFailMessage(test.kw ?? []);
      }

      const fullName = [...suitePath, testName].join('.');

      results.push({
        testName: fullName,
        outcome,
        durationMs,
        errorMessage,
        testCaseId,
      });
    }
  }

  const robotNode = doc.robot ?? doc.Robot;
  if (robotNode) {
    for (const suite of robotNode.suite ?? []) {
      walkSuites(suite, [suite['@_name'] ?? '']);
    }
  }

  return results;
}

// ─── Go test JSON parser ──────────────────────────────────────────────────────
//
// go test -json produces line-delimited JSON (one object per line):
//
//   {"Time":"...","Action":"run","Package":"github.com/x/y","Test":"TestFoo"}
//   {"Time":"...","Action":"output","Package":"...","Test":"TestFoo","Output":"=== RUN   TestFoo\n"}
//   {"Time":"...","Action":"pass","Package":"...","Test":"TestFoo","Elapsed":0.101}
//   {"Time":"...","Action":"fail","Package":"...","Test":"TestFoo","Elapsed":0.05}

function parseGoTestJson(content: string, tagPrefix: string, treatInconclusiveAs?: string): ParsedResult[] {
  interface GoTestEntry {
    action: string;
    elapsed: number;
    outputs: string[];
  }

  const tests = new Map<string, GoTestEntry>();

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: any;
    try { obj = JSON.parse(trimmed); } catch { continue; }

    const action: string  = obj.Action  ?? '';
    const pkg: string     = obj.Package ?? '';
    const testName: string = obj.Test   ?? '';
    if (!testName) continue; // package-level events

    const key = `${pkg}.${testName}`;

    if (!tests.has(key)) {
      tests.set(key, { action: '', elapsed: 0, outputs: [] });
    }
    const entry = tests.get(key)!;

    if (action === 'output' && obj.Output) {
      entry.outputs.push(String(obj.Output));
    }
    if (['pass', 'fail', 'skip'].includes(action)) {
      entry.action  = action;
      entry.elapsed = obj.Elapsed ?? 0;
    }
  }

  const results: ParsedResult[] = [];
  const idRe = new RegExp(`@${tagPrefix}:(\\d+)`);

  for (const [key, entry] of tests) {
    if (!entry.action) continue; // in-progress or benchmark

    let outcome = 'Failed';
    if (entry.action === 'pass') outcome = 'Passed';
    else if (entry.action === 'skip') outcome = 'NotExecuted';
    outcome = normaliseOutcome(outcome, treatInconclusiveAs);

    // Collect meaningful output lines (strip === RUN / --- PASS / --- FAIL markers)
    const outputLines = entry.outputs.filter((o) =>
      !/^(?:=== RUN|=== PAUSE|=== CONT|--- (?:PASS|FAIL|SKIP):)/.test(o)
    );
    const outputText = outputLines.join('').trim();

    // Extract TC ID from output if the test logged it
    let testCaseId: number | undefined;
    const idMatch = outputText.match(idRe);
    if (idMatch) testCaseId = parseInt(idMatch[1], 10);

    // Error message: first non-empty output line after panic / Error markers
    let errorMessage: string | undefined;
    if (outcome === 'Failed' && outputText) {
      errorMessage = outputText.slice(0, 500);
    }

    // testName: "pkg.TestName" (replace / subtest separators with .)
    const testName = key.replace(/\//g, '.');

    results.push({
      testName,
      outcome,
      durationMs: Math.round(entry.elapsed * 1000),
      errorMessage: errorMessage || undefined,
      testCaseId,
    });
  }

  return results;
}

// ─── Mochawesome JSON parser ──────────────────────────────────────────────────
//
// Mochawesome format (produced by mocha + mochawesome reporter, also used by Cypress):
//
//   {
//     "stats": { ... },
//     "results": [
//       {
//         "suites": [ { "tests": [...], "suites": [...] } ],
//         "tests": [...]
//       }
//     ]
//   }

function parseMochawesome(content: string, tagPrefix: string, treatInconclusiveAs?: string): ParsedResult[] {
  const report = JSON.parse(content);
  const results: ParsedResult[] = [];
  const idRe = new RegExp(`@${tagPrefix}:(\\d+)`);

  function collectTests(suiteOrResult: any): void {
    // Direct tests array
    for (const test of suiteOrResult.tests ?? []) {
      const fullTitle: string  = test.fullTitle ?? test.title ?? '';
      const state: string      = test.state ?? (test.pass ? 'passed' : test.fail ? 'failed' : 'pending');
      const durationMs: number = test.duration ?? 0;

      let outcome = 'Failed';
      if (state === 'passed' || test.pass) outcome = 'Passed';
      else if (state === 'pending' || test.pending || test.skipped) outcome = 'NotExecuted';
      outcome = normaliseOutcome(outcome, treatInconclusiveAs);

      // TC ID from fullTitle (@tc:12345) or context JSON
      let testCaseId: number | undefined;
      const titleMatch = fullTitle.match(idRe);
      if (titleMatch) testCaseId = parseInt(titleMatch[1], 10);

      // Also try context field (may contain JSON with tc property)
      if (testCaseId === undefined && test.context) {
        try {
          const ctx = typeof test.context === 'string' ? JSON.parse(test.context) : test.context;
          const ctxArr = Array.isArray(ctx) ? ctx : [ctx];
          for (const c of ctxArr) {
            if (c?.title === tagPrefix && c?.value) {
              const id = parseInt(String(c.value), 10);
              if (!isNaN(id)) { testCaseId = id; break; }
            }
          }
        } catch { /* ignore */ }
      }

      const err = test.err ?? {};
      const errorMessage: string | undefined = err.message || undefined;
      const stackTrace: string | undefined   = err.estack  || err.stack || undefined;

      results.push({
        testName: fullTitle,
        outcome,
        durationMs,
        errorMessage,
        stackTrace,
        testCaseId,
      });
    }

    // Recurse into nested suites
    for (const suite of suiteOrResult.suites ?? []) {
      collectTests(suite);
    }
  }

  for (const result of report.results ?? []) {
    collectTests(result);
  }

  return results;
}

// ─── RSpec JSON parser ────────────────────────────────────────────────────────
//
// RSpec --format json output:
//
//   {
//     "version": 3,
//     "examples": [
//       {
//         "id": "./spec/example_spec.rb[1:1]",
//         "description": "should pass",
//         "full_description": "Example should pass",
//         "status": "passed",
//         "run_time": 0.001234,
//         "exception": { "class": "...", "message": "...", "backtrace": [...] }
//       }
//     ],
//     "summary": { "duration": 0.005, ... }
//   }

function parseRspecJson(content: string, tagPrefix: string, treatInconclusiveAs?: string): ParsedResult[] {
  const report = JSON.parse(content);
  const results: ParsedResult[] = [];
  const idRe = new RegExp(`@${tagPrefix}:(\\d+)`);

  for (const example of report.examples ?? []) {
    const fullDescription: string = example.full_description ?? example.description ?? '';
    const status: string          = example.status ?? 'failed';
    const runTime: number         = example.run_time ?? 0;

    let outcome = 'Failed';
    if (status === 'passed') outcome = 'Passed';
    else if (status === 'pending') outcome = 'NotExecuted';
    outcome = normaliseOutcome(outcome, treatInconclusiveAs);

    // TC ID from @tc:12345 in full_description
    let testCaseId: number | undefined;
    const idMatch = fullDescription.match(idRe);
    if (idMatch) testCaseId = parseInt(idMatch[1], 10);

    const exc = example.exception;
    const errorMessage: string | undefined = exc?.message || undefined;
    const stackTrace: string | undefined   = exc?.backtrace?.join('\n') || undefined;

    results.push({
      testName: fullDescription,
      outcome,
      durationMs: Math.round(runTime * 1000),
      errorMessage,
      stackTrace,
      testCaseId,
    });
  }

  return results;
}

// ─── Rust test JSON parser ────────────────────────────────────────────────────
//
// cargo test -- --format=json produces line-delimited JSON:
//
//   { "type": "suite", "event": "started", "test_count": 2 }
//   { "type": "test", "event": "started", "name": "it_works" }
//   { "type": "test", "name": "it_works", "event": "ok", "exec_time": { "secs": 0, "nanos": 123456789 } }
//   { "type": "test", "name": "it_fails", "event": "failed", "exec_time": {...}, "stdout": "..." }

function parseRustTestJson(content: string, tagPrefix: string, treatInconclusiveAs?: string): ParsedResult[] {
  const results: ParsedResult[] = [];
  const idRe = new RegExp(`@${tagPrefix}:(\\d+)`);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: any;
    try { obj = JSON.parse(trimmed); } catch { continue; }

    if (obj.type !== 'test') continue;
    const event: string = obj.event ?? '';
    if (!['ok', 'failed', 'ignored'].includes(event)) continue;

    const name: string = obj.name ?? '';
    const execTime = obj.exec_time ?? {};
    const durationMs = Math.round((execTime.secs ?? 0) * 1000 + (execTime.nanos ?? 0) / 1e6);

    let outcome = 'Failed';
    if (event === 'ok') outcome = 'Passed';
    else if (event === 'ignored') outcome = 'NotExecuted';
    outcome = normaliseOutcome(outcome, treatInconclusiveAs);

    const stdout: string = obj.stdout ?? '';

    // Extract TC ID from stdout if test logged it
    let testCaseId: number | undefined;
    const idMatch = stdout.match(idRe);
    if (idMatch) testCaseId = parseInt(idMatch[1], 10);

    let errorMessage: string | undefined;
    if (outcome === 'Failed' && stdout) {
      errorMessage = stdout.trim().slice(0, 500) || undefined;
    }

    results.push({
      testName: name,
      outcome,
      durationMs,
      errorMessage: errorMessage || undefined,
      testCaseId,
    });
  }

  return results;
}

// ─── Auto-detect format ───────────────────────────────────────────────────────

function detectFormat(filePath: string, content: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.trx') return 'trx';

  // Detect line-delimited JSON formats first (before generic .json check)
  if (ext === '.json' || ext === '.jsonl' || ext === '') {
    const firstLine = content.trimStart().split('\n')[0].trim();
    if (firstLine.startsWith('{')) {
      try {
        const first = JSON.parse(firstLine);
        // Go test JSON: has Action and Package fields
        if (typeof first.Action === 'string' && typeof first.Package === 'string') return 'goTest';
        // Rust test JSON: has type:"suite" and event:"started"
        if (first.type === 'suite' && typeof first.event === 'string') return 'rustTest';
      } catch { /* fall through */ }
    }
  }

  if (ext === '.json') {
    try {
      const parsed = JSON.parse(content);
      // Playwright JSON has a top-level "suites" array (not an array itself)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.suites)) return 'playwrightJson';
      // Mochawesome JSON has a top-level "results" array with suites inside
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.results) &&
          parsed.results.length > 0 && (Array.isArray(parsed.results[0].suites) || Array.isArray(parsed.results[0].tests))) return 'mochawesome';
      // RSpec JSON has top-level "examples" array and "summary" object
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.examples) && parsed.summary) return 'rspecJson';
    } catch { /* fall through */ }
    return 'cucumberJson';
  }

  if (content.trimStart().startsWith('<')) {
    if (content.includes('<TestRun') || content.includes('<testRun')) return 'trx';
    if (content.includes('<test-run'))  return 'nunitXml';
    if (content.includes('<testsuites') || content.includes('<testsuite')) return 'junit';
    if (content.includes('<robot ') || content.includes('<robot\n') || content.trimStart().startsWith('<robot')) return 'robotFramework';
  }
  return 'junit';
}

// ─── Attachment folder scan ───────────────────────────────────────────────────
//
// Scan a directory for screenshot/video/log files and match them to test results
// by checking whether the test method name appears in the filename.
// Unmatched files are attached at the run level.

async function scanAttachmentFolder(
  folder: string,
  include: string | string[],
  allResults: ParsedResult[],
  matchByTestName: boolean,
): Promise<{ resultAttachments: Map<number, TestAttachment[]>; runAttachments: TestAttachment[] }> {
  const patterns = Array.isArray(include) ? include : [include];
  const files: string[] = [];
  for (const pattern of patterns) {
    const matched = await glob(pattern, { cwd: folder, absolute: true });
    files.push(...matched);
  }

  const resultAttachments = new Map<number, TestAttachment[]>();
  const runAttachments: TestAttachment[] = [];

  for (const filePath of files) {
    const data = safeReadFile(filePath);
    if (!data) continue;
    const att: TestAttachment = {
      fileName: path.basename(filePath),
      data,
      attachmentType: extToAttachmentType(path.extname(filePath)),
    };

    if (matchByTestName) {
      const fileBase = path.basename(filePath, path.extname(filePath)).toLowerCase().replace(/[^a-z0-9]/g, '');
      let matched = false;
      for (let i = 0; i < allResults.length; i++) {
        // Build candidate segments from the test name using all common separators (. > :)
        // then check both directions: file-contains-segment OR segment-contains-file.
        const raw = allResults[i].testName.toLowerCase();
        const segments = new Set<string>();
        for (const sep of ['.', '>', ':']) {
          const parts = raw.split(sep);
          const last = parts[parts.length - 1].replace(/[^a-z0-9]/g, '');
          if (last.length >= 4) segments.add(last);
        }
        segments.add(raw.replace(/[^a-z0-9]/g, ''));
        const hit = fileBase.length >= 4 && [...segments].some(seg =>
          seg.length >= 4 && (fileBase.includes(seg) || seg.includes(fileBase)),
        );
        if (hit) {
          const arr = resultAttachments.get(i) ?? [];
          arr.push(att);
          resultAttachments.set(i, arr);
          matched = true;
          break;
        }
      }
      if (!matched) runAttachments.push(att);
    } else {
      runAttachments.push(att);
    }
  }

  return { resultAttachments, runAttachments };
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
    /** Extra folder to scan for screenshots/videos/logs to attach to test results. */
    attachmentsFolder?: string;
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
    const fileDir = path.dirname(src.filePath);

    switch (format) {
      case 'trx':
        allResults.push(...parseTrx(content, tagPrefix, treatInconclusiveAs, fileDir));
        break;
      case 'nunitXml':
        allResults.push(...parseNUnitXml(content, tagPrefix, treatInconclusiveAs, fileDir));
        break;
      case 'junit':
        allResults.push(...parseJUnit(content, tagPrefix, treatInconclusiveAs, fileDir));
        break;
      case 'cucumberJson':
        allResults.push(...parseCucumberJson(content, tagPrefix, treatInconclusiveAs));
        break;
      case 'playwrightJson':
        allResults.push(...parsePlaywrightJson(content, tagPrefix, treatInconclusiveAs, fileDir));
        break;
      case 'robotFramework':
        allResults.push(...parseRobotFramework(content, tagPrefix, treatInconclusiveAs));
        break;
      case 'goTest':
        allResults.push(...parseGoTestJson(content, tagPrefix, treatInconclusiveAs));
        break;
      case 'mochawesome':
        allResults.push(...parseMochawesome(content, tagPrefix, treatInconclusiveAs));
        break;
      case 'rspecJson':
        allResults.push(...parseRspecJson(content, tagPrefix, treatInconclusiveAs));
        break;
      case 'rustTest':
        allResults.push(...parseRustTestJson(content, tagPrefix, treatInconclusiveAs));
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

  // Do NOT pass `plan` here — attaching to a test plan makes ADO treat the run
  // as "planned", which requires testPointId + testCaseRevision on every result.
  // Automated CI runs post results independently; test cases are linked by id alone.
  const runModel: any = {
    name: runName,
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

  // addTestResultsToTestRun has a hard limit of 1000 results per call — batch accordingly
  const BATCH_SIZE = 1000;
  const addedResults: any[] = [];
  for (let i = 0; i < testCaseResults.length; i += BATCH_SIZE) {
    const batch = testCaseResults.slice(i, i + BATCH_SIZE);
    const batchAdded = await testApi.addTestResultsToTestRun(batch, config.project, runId);
    if (batchAdded) addedResults.push(...batchAdded);
  }

  // ── Upload attachments ────────────────────────────────────────────────────
  const publishAttachmentsForPassing = pubConfig?.publishAttachmentsForPassingTests ?? 'none';

  // Scan an optional folder for additional screenshots/videos/logs
  let folderResultAtts = new Map<number, TestAttachment[]>();
  let folderRunAtts: TestAttachment[] = [];

  const attCfg  = pubConfig?.attachments;
  const attFolder = opts.attachmentsFolder
    ? path.resolve(configDir, opts.attachmentsFolder)
    : attCfg?.folder ? path.resolve(configDir, attCfg.folder) : undefined;

  if (attFolder && fs.existsSync(attFolder)) {
    const include     = attCfg?.include ?? '**/*.{png,jpg,jpeg,gif,webp,mp4,webm,avi,mov,log,txt,html,zip}';
    const matchByName = attCfg?.matchByTestName ?? true;
    const { resultAttachments, runAttachments } = await scanAttachmentFolder(attFolder, include, allResults, matchByName);
    folderResultAtts = resultAttachments;
    folderRunAtts    = runAttachments;
  }

  // Upload per-result attachments (embedded + folder-matched)
  for (let i = 0; i < allResults.length; i++) {
    const resultEntry = allResults[i];
    const addedResult = addedResults?.[i];
    if (!addedResult?.id) continue;

    const isPassing     = resultEntry.outcome === 'Passed';
    const includeForResult = isPassing ? publishAttachmentsForPassing !== 'none' : true;
    const filesOnly        = isPassing && publishAttachmentsForPassing === 'files';

    const toUpload: TestAttachment[] = [];
    for (const att of resultEntry.attachments ?? []) {
      // 'files' mode: skip pure log attachments for passing tests
      if (filesOnly && att.attachmentType === 'ConsoleLog') continue;
      if (includeForResult) toUpload.push(att);
    }
    toUpload.push(...(folderResultAtts.get(i) ?? []));

    for (const att of toUpload) {
      await testApi.createTestResultAttachment(
        { attachmentType: att.attachmentType, fileName: att.fileName, stream: att.data.toString('base64') },
        config.project, runId, addedResult.id
      );
    }
  }

  // Upload run-level attachments (unmatched folder files)
  for (const att of folderRunAtts) {
    await testApi.createTestRunAttachment(
      { attachmentType: att.attachmentType, fileName: att.fileName, stream: att.data.toString('base64') },
      config.project, runId
    );
  }

  await testApi.updateTestRun({ state: 'Completed' } as any, config.project, runId);

  const runUrl = `${config.orgUrl}/${config.project}/_testManagement/runs?runId=${runId}`;
  return { runId, runUrl, totalResults: allResults.length, passed, failed, other };
}
