import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { AzureClient } from '../azure/client';
import { updateTestCase } from '../azure/test-cases';
import { detectAiEnvironment } from '../ai/summarizer';
import { getPreferredMarkerTagPrefix } from '../id-markers';
import { parseGherkinFile } from '../parsers/gherkin';
import { parseJavaScriptFile } from '../parsers/javascript';
import { buildPushDiff, failOnParseErrors, pull, push } from '../sync/engine';
import { loadGenerateContextContent } from '../sync/generate';
import { publishTestResults } from '../sync/publish-results';
import { writebackDocComment } from '../sync/writeback';
import { AzureTestCase, ParsedStep, ParsedTest, SyncConfig } from '../types';

function makeConfig(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    orgUrl: 'https://dev.azure.com/example',
    project: 'ExampleProject',
    auth: { type: 'pat', token: 'token' },
    testPlan: { id: 1 },
    local: { type: 'javascript', include: '**/*.test.ts' },
    sync: { tagPrefix: 'tc' },
    ...overrides,
  };
}

function makeParsedTest(overrides: Partial<ParsedTest> = {}): ParsedTest {
  return {
    filePath: '/tmp/example.test.ts',
    title: 'login works',
    steps: [{ keyword: 'Then', text: 'the dashboard is shown', expected: 'dashboard is visible' }],
    tags: [],
    line: 1,
    ...overrides,
  };
}

function withTemporaryEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withCleanAiDetectionEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  withTemporaryEnv({
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    GITHUB_TOKEN: undefined,
    CLAUDE_CODE: undefined,
    CLAUDE_CONTEXT: undefined,
    CODEX: undefined,
    OPENAI_CODEX: undefined,
    CODEX_CLI: undefined,
    VISUAL_STUDIO_AGENT_MODE: undefined,
    VISUAL_STUDIO_COPILOT_AGENT_MODE: undefined,
    VS_COPILOT_AGENT_MODE: undefined,
    COPILOT_AGENT_MODE: undefined,
    CURSOR_SESSION_ID: undefined,
    CURSOR_TRACE_ID: undefined,
    WINDSURF_SESSION_ID: undefined,
    CLINE_TASK_ID: undefined,
    CLINE_SESSION_ID: undefined,
    ANTIGRAVITY_SESSION_ID: undefined,
    AIDER: undefined,
    AIDER_SESSION: undefined,
    CONTINUE_SESSION_ID: undefined,
    AUGMENT_SESSION_ID: undefined,
    ROO_CODE_SESSION_ID: undefined,
    TRAE_SESSION_ID: undefined,
    AMAZON_Q_SESSION_ID: undefined,
    AWS_Q_SESSION_ID: undefined,
    AMP_SESSION_ID: undefined,
    TERM_PROGRAM: undefined,
    TERMINAL_EMULATOR: undefined,
    IDEA_INITIAL_DIRECTORY: undefined,
    __INTELLIJ_COMMAND_HISTFILE__: undefined,
    PATH: '/usr/bin:/bin',
    ...vars,
  }, fn);
}

test('buildPushDiff flags expected-result-only step changes', () => {
  const config = makeConfig();
  const local = makeParsedTest();
  const remote: AzureTestCase = {
    id: 42,
    title: 'login works',
    description: '',
    tags: [],
    steps: [{ action: 'Then the dashboard is shown', expected: 'different expected result' }],
  };

  const diff = buildPushDiff(local, remote, config);

  assert.deepEqual(diff.changedFields, ['steps', 'description']);
  assert.equal(diff.diffDetail[0]?.field, 'steps');
  assert.match(diff.diffDetail[0]?.local ?? '', /dashboard is visible/);
  assert.match(diff.diffDetail[0]?.remote ?? '', /different expected result/);
});

test('failOnParseErrors aborts with file details', () => {
  assert.throws(
    () => failOnParseErrors('push', [{ filePath: '/tmp/bad.feature', message: 'unexpected token' }]),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return msg.includes('Aborting push') &&
        msg.includes('/tmp/bad.feature') &&
        msg.includes('unexpected token');
    }
  );
});

test('parseGherkinFile preserves doc-string block structure in description HTML', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-gherkin-docstring-'));
  const filePath = path.join(tempDir, 'sample.feature');
  fs.writeFileSync(filePath, [
    'Feature: Login',
    '',
    '  Scenario: shows api payload',
    '    Given a payload',
    '      """',
    '      {',
    '        "status": "ok"',
    '      }',
    '      """',
    '',
  ].join('\n'));

  try {
    const parsed = parseGherkinFile(filePath, 'tc');
    const description = parsed[0]?.description ?? '';

    assert.equal((description.match(/"""/g) ?? []).length, 2);
    assert.match(description, /<span style="color:#6A737D">\{<\/span><br>/);
    assert.match(description, /<span style="color:#6A737D">  &quot;status&quot;: &quot;ok&quot;<\/span><br>/);
    assert.match(description, /<span style="color:#6A737D">\}<\/span><br>/);
    assert.ok(!description.includes('""" {'));
    assert.ok(!description.includes('""" &quot;status&quot;'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('updateTestCase removes stale outline parameter fields when scenario is no longer parametrized', async () => {
  let updatePatch: any[] | undefined;
  const wit = {
    getWorkItem: async () => ({
      fields: {
        'System.Tags': 'smoke',
        'Microsoft.VSTS.TCM.Parameters': '<parameters />',
        'Microsoft.VSTS.TCM.LocalDataSource': '<NewDataSet />',
      },
    }),
    updateWorkItem: async (_doc: any, patch: any[]) => {
      updatePatch = patch;
      return {};
    },
  };
  const client = {
    getWitApi: async () => wit,
  } as any;

  await updateTestCase(client, 99, makeParsedTest(), makeConfig());

  assert.ok(updatePatch, 'expected updateWorkItem to be called');
  assert.ok(updatePatch!.some((p) => p.op === 'remove' && p.path === '/fields/Microsoft.VSTS.TCM.Parameters'));
  assert.ok(updatePatch!.some((p) => p.op === 'remove' && p.path === '/fields/Microsoft.VSTS.TCM.LocalDataSource'));
});

test('writebackDocComment preserves user-authored JSDoc and parser ignores ado-sync marker', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-test-'));
  const filePath = path.join(tempDir, 'sample.test.ts');
  fs.writeFileSync(filePath, [
    '/**',
    ' * Existing user documentation',
    ' */',
    "test('user keeps docs', async () => {});",
    '',
  ].join('\n'));

  const parsedBefore = parseJavaScriptFile(filePath, 'tc');
  assert.equal(parsedBefore[0]?.title, 'Existing user documentation');

  const steps: ParsedStep[] = [
    { keyword: 'Step', text: 'open the app' },
    { keyword: 'Then', text: 'see the dashboard' },
  ];

  writebackDocComment(
    { ...makeParsedTest({ filePath, line: 4, title: 'user keeps docs', steps }), description: 'AI summary' },
    'user keeps docs',
    'AI summary',
    steps
  );

  const updated = fs.readFileSync(filePath, 'utf8');
  assert.match(updated, /Existing user documentation/);
  assert.equal((updated.match(/ado-sync:ai-summary/g) ?? []).length, 1);

  const parsedAfter = parseJavaScriptFile(filePath, 'tc');
  assert.equal(parsedAfter[0]?.title, 'user keeps docs');
  assert.equal(parsedAfter[0]?.description, 'AI summary');
});

test('publishTestResults resolves test configuration names before creating the run', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-publish-'));
  const resultFile = path.join(tempDir, 'results.xml');
  fs.writeFileSync(resultFile, [
    '<testsuites>',
    '  <testsuite name="suite">',
    '    <testcase classname="Sample" name="works" time="0.01">',
    '      <properties><property name="tc" value="123" /></properties>',
    '    </testcase>',
    '  </testsuite>',
    '</testsuites>',
  ].join('\n'));

  const config = makeConfig({
    publishTestResults: {
      testResult: { sources: [{ value: 'results.xml', format: 'junit' }] },
      testConfiguration: { name: 'Windows 10' },
      testRunSettings: { name: 'Named config run' },
    },
  });

  let createRunModel: any;
  const originalCreate = AzureClient.create;
  (AzureClient as any).create = async () => ({
    getTestApi: async () => ({
      createTestRun: async (model: any) => {
        createRunModel = model;
        return { id: 77, webAccessUrl: 'https://example.test/runs/77' };
      },
      addTestResultsToTestRun: async (_results: any[]) => [{ id: 1 }],
      createTestResultAttachment: async () => undefined,
      createTestRunAttachment: async () => undefined,
      updateTestRun: async () => undefined,
    }),
    getTestPlanApi: async () => ({
      getTestConfigurations: async () => [{ id: 9, name: 'Windows 10' }],
    }),
  });

  try {
    const summary = await publishTestResults(config, tempDir);
    assert.equal(summary.runId, 77);
    assert.deepEqual(createRunModel.configurationIds, [9]);
  } finally {
    (AzureClient as any).create = originalCreate;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('publishTestResults binds planned runs to configured suites and points', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-suite-'));
  const resultFile = path.join(tempDir, 'results.xml');
  fs.writeFileSync(resultFile, [
    '<testsuites>',
    '  <testsuite name="suite">',
    '    <testcase classname="Sample" name="planned works" time="0.02">',
    '      <properties><property name="tc" value="123" /></properties>',
    '    </testcase>',
    '  </testsuite>',
    '</testsuites>',
  ].join('\n'));

  const config = makeConfig({
    publishTestResults: {
      testResult: { sources: [{ value: 'results.xml', format: 'junit' }] },
      testConfiguration: { id: 9 },
      testSuite: { name: 'BDD', testPlan: 'Smoke Plan' },
    },
  });

  let createRunModel: any;
  let addedResultsPayload: any[] = [];
  const originalCreate = AzureClient.create;
  (AzureClient as any).create = async () => ({
    getTestApi: async () => ({
      createTestRun: async (model: any) => {
        createRunModel = model;
        return { id: 88, webAccessUrl: 'https://example.test/runs/88' };
      },
      addTestResultsToTestRun: async (results: any[]) => {
        addedResultsPayload = results;
        return [{ id: 11 }];
      },
      createTestResultAttachment: async () => undefined,
      createTestRunAttachment: async () => undefined,
      updateTestRun: async () => undefined,
    }),
    getTestPlanApi: async () => ({
      getTestPlans: async () => [{ id: 12, name: 'Smoke Plan' }],
      getTestSuitesForPlan: async () => [{ id: 34, name: 'BDD' }],
      getPointsList: async () => [{ id: 55, configuration: { id: 9, name: 'Windows 10' }, testCaseReference: { id: 123 } }],
    }),
    getWitApi: async () => ({
      getWorkItem: async () => ({ rev: 7 }),
    }),
  });

  try {
    const summary = await publishTestResults(config, tempDir);
    assert.equal(summary.runId, 88);
    assert.equal(createRunModel.plan.id, '12');
    assert.deepEqual(createRunModel.pointIds, [55]);
    assert.equal(addedResultsPayload[0].testPoint.id, '55');
    assert.equal(addedResultsPayload[0].testPlan.id, '12');
    assert.equal(addedResultsPayload[0].testCaseRevision, 7);
    assert.equal(addedResultsPayload[0].configuration.id, '9');
  } finally {
    (AzureClient as any).create = originalCreate;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadGenerateContextContent collects bounded targeted context from files and folders', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-generate-context-'));
  const srcDir = path.join(tempDir, 'src');
  const testsDir = path.join(tempDir, 'tests');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(testsDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'feature.ts'), 'export const buttonLabel = "Submit order";\n');
  fs.writeFileSync(path.join(testsDir, 'feature.spec.ts'), 'test("submits order", async () => {});\n');

  try {
    const content = loadGenerateContextContent(['src', 'tests/**/*.spec.ts'], tempDir, '[test:ai-generate]');
    assert.ok(content);
    assert.match(content ?? '', /--- file: src\/feature.ts ---/);
    assert.match(content ?? '', /Submit order/);
    assert.match(content ?? '', /--- file: tests\/feature.spec.ts ---/);
    assert.match(content ?? '', /submits order/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadGenerateContextContent caps file count and skips ignored folders', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-generate-cap-'));
  const srcDir = path.join(tempDir, 'src');
  const ignoredDir = path.join(tempDir, 'node_modules/pkg');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(ignoredDir, { recursive: true });
  for (let index = 0; index < 15; index++) {
    fs.writeFileSync(path.join(srcDir, `file-${index}.ts`), `export const value${index} = ${index};\n`);
  }
  fs.writeFileSync(path.join(ignoredDir, 'ignored.js'), 'module.exports = true;\n');

  try {
    const content = loadGenerateContextContent(['src/**/*', 'node_modules/**/*'], tempDir, '[test:ai-generate]');
    assert.ok(content);
    const sections = (content?.match(/--- file:/g) ?? []).length;
    assert.equal(sections, 12);
    assert.doesNotMatch(content ?? '', /ignored.js/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('push skips removed-case detection on tag-filtered runs', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-push-tags-'));
  const filePath = path.join(tempDir, 'spec.md');
  fs.writeFileSync(filePath, [
    '### Login works',
    '@smoke',
    '',
    'Steps:',
    '1. Open the app',
    '',
  ].join('\n'));

  const config = makeConfig({
    local: { type: 'markdown', include: '*.md' },
  });

  let suiteFetchCount = 0;
  const originalCreate = AzureClient.create;
  (AzureClient as any).create = async () => ({
    getTestPlanApi: async () => ({
      getTestCaseList: async () => {
        suiteFetchCount++;
        return [{ workItem: { id: 77 } }];
      },
      getTestPlanById: async () => ({ rootSuite: { id: 10 } }),
    }),
    getWitApi: async () => ({
      getWorkItems: async () => [{ id: 77, fields: { 'System.Title': 'Unrelated remote case', 'System.Tags': '' } }],
    }),
  });

  try {
    const results = await push(config, tempDir, { dryRun: true, tags: '@smoke' });
    assert.equal(suiteFetchCount, 0);
    assert.ok(results.some((r) => r.action === 'created'));
    assert.ok(!results.some((r) => r.action === 'removed'));
  } finally {
    (AzureClient as any).create = originalCreate;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('pull-create errors for unsupported local types instead of creating markdown files', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-pull-create-'));
  const filePath = path.join(tempDir, 'sample.test.ts');
  fs.writeFileSync(filePath, "test('existing test', () => {});\n");

  const config = makeConfig({
    local: { type: 'javascript', include: '*.test.ts' },
    sync: {
      tagPrefix: 'tc',
      pull: { enableCreatingNewLocalTestCases: true },
    },
  });

  let suiteFetchCount = 0;
  const originalCreate = AzureClient.create;
  (AzureClient as any).create = async () => ({
    getTestApi: async () => ({}),
    getTestPlanApi: async () => ({
      getTestCaseList: async () => {
        suiteFetchCount++;
        return [];
      },
      getTestPlanById: async () => ({ rootSuite: { id: 10 } }),
    }),
    getWitApi: async () => ({ getWorkItems: async () => [] }),
  });

  try {
    const results = await pull(config, tempDir);
    assert.equal(suiteFetchCount, 0);
    assert.ok(results.some((r) => r.action === 'error' && /Pull-create is not supported/.test(r.detail ?? '')));
    assert.equal(fs.readdirSync(tempDir).filter((name) => name.endsWith('.md') || name.endsWith('.feature')).length, 0);
  } finally {
    (AzureClient as any).create = originalCreate;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('configurationKey marker prefixes parse namespaced and legacy JavaScript IDs', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-config-key-'));
  const filePath = path.join(tempDir, 'sample.test.ts');
  const config = makeConfig({ configurationKey: 'Smoke Suite' });
  const markerPrefix = getPreferredMarkerTagPrefix(config);

  try {
    fs.writeFileSync(filePath, [`// @${markerPrefix}:123`, "test('namespaced id', () => {});", ''].join('\n'));
    const namespaced = parseJavaScriptFile(filePath, [markerPrefix, 'tc']);
    assert.equal(namespaced[0]?.azureId, 123);

    fs.writeFileSync(filePath, ['// @tc:456', "test('legacy id', () => {});", ''].join('\n'));
    const legacy = parseJavaScriptFile(filePath, [markerPrefix, 'tc']);
    assert.equal(legacy[0]?.azureId, 456);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('detectAiEnvironment returns heuristic when Visual Studio Agent mode env is set', () => {
  withCleanAiDetectionEnv({
    VISUAL_STUDIO_AGENT_MODE: '1',
  }, () => {
    const detected = detectAiEnvironment();
    assert.equal(detected?.provider, 'heuristic');
  });
});

test('detectAiEnvironment returns heuristic when Codex env signal is set', () => {
  withCleanAiDetectionEnv({
    CODEX_CLI: '1',
  }, () => {
    const detected = detectAiEnvironment();
    assert.equal(detected?.provider, 'heuristic');
  });
});
