import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { detectAiEnvironment } from '../ai/summarizer';
import { AzureClient } from '../azure/client';
import { getOrCreateSuiteForFile, getTestCasesInSuite, updateTestCase } from '../azure/test-cases';
import { getAcGateDiagnosticItems, getCoverageDiagnosticItems, getStaleDiagnosticItems, getTrendDiagnosticItems, getValidateDiagnosticItems } from '../cli-diagnostics';
import { loadConfig } from '../config';
import { getSyncTargetOwnershipTag } from '../id-markers';
import { getPreferredMarkerTagPrefix } from '../id-markers';
import { parseGherkinFile } from '../parsers/gherkin';
import { parseJavaScriptFile } from '../parsers/javascript';
import { buildPushDiff, failOnParseErrors, pull, push, status, validatePushModeOptions } from '../sync/engine';
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

test('validatePushModeOptions rejects incompatible mode combinations', () => {
  assert.throws(
    () => validatePushModeOptions({ createOnly: true, linkOnly: true, updateOnly: false }),
    /Only one push mode can be used at a time/
  );
  assert.throws(
    () => validatePushModeOptions({ createOnly: false, linkOnly: true, updateOnly: true }),
    /Only one push mode can be used at a time/
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

test('updateTestCase adds deterministic ownership tag for tagged sync targets', async () => {
  let updatePatch: any[] | undefined;
  const config = makeConfig({
    configurationKey: 'Smoke Suite',
    syncTarget: { mode: 'tagged' },
  });
  const ownershipTag = getSyncTargetOwnershipTag(config);
  const wit = {
    getWorkItem: async () => ({
      fields: {
        'System.Tags': 'smoke',
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

  await updateTestCase(client, 99, makeParsedTest(), config);

  assert.ok(updatePatch, 'expected updateWorkItem to be called');
  const tagsPatch = updatePatch!.find((patch) => patch.path === '/fields/System.Tags');
  assert.ok(tagsPatch, 'expected System.Tags to be updated');
  assert.match(tagsPatch.value, new RegExp(ownershipTag ?? ''));
});

test('loadConfig accepts declarative hierarchy definitions', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-hierarchy-config-'));
  const configPath = path.join(tempDir, 'ado-sync.json');
  fs.writeFileSync(configPath, JSON.stringify({
    orgUrl: 'https://dev.azure.com/example',
    project: 'ExampleProject',
    auth: { type: 'pat', token: 'token' },
    testPlan: {
      id: 1,
      suiteId: 10,
      hierarchy: { mode: 'byFolder', rootSuite: 'Generated Specs' },
    },
    local: { type: 'gherkin', include: 'specs/**/*.feature' },
  }, null, 2));

  try {
    const loaded = loadConfig(configPath);
    assert.deepEqual(loaded.testPlan.hierarchy, { mode: 'byFolder', rootSuite: 'Generated Specs' });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadConfig accepts tag-driven hierarchy definitions', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-hierarchy-by-tag-config-'));
  const configPath = path.join(tempDir, 'ado-sync.json');
  fs.writeFileSync(configPath, JSON.stringify({
    orgUrl: 'https://dev.azure.com/example',
    project: 'ExampleProject',
    auth: { type: 'pat', token: 'token' },
    testPlan: {
      id: 1,
      suiteId: 10,
      hierarchy: { mode: 'byTag', tagPrefix: 'suite', rootSuite: 'Generated Specs' },
    },
    local: { type: 'markdown', include: 'specs/**/*.md' },
  }, null, 2));

  try {
    const loaded = loadConfig(configPath);
    assert.deepEqual(loaded.testPlan.hierarchy, { mode: 'byTag', tagPrefix: 'suite', rootSuite: 'Generated Specs' });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadConfig accepts level-rule hierarchy definitions and diagnostic output', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-hierarchy-by-levels-config-'));
  const configPath = path.join(tempDir, 'ado-sync.json');
  fs.writeFileSync(configPath, JSON.stringify({
    orgUrl: 'https://dev.azure.com/example',
    project: 'ExampleProject',
    auth: { type: 'pat', token: 'token' },
    testPlan: {
      id: 1,
      suiteId: 10,
      hierarchy: {
        mode: 'byLevels',
        rootSuite: 'Generated Specs',
        levels: [
          { source: 'folder', index: 0 },
          { source: 'tag', tagPrefix: 'suite' },
        ],
      },
    },
    local: { type: 'markdown', include: 'specs/**/*.md' },
    toolSettings: { outputLevel: 'diagnostic' },
  }, null, 2));

  try {
    const loaded = loadConfig(configPath);
    assert.deepEqual(loaded.testPlan.hierarchy, {
      mode: 'byLevels',
      rootSuite: 'Generated Specs',
      levels: [
        { source: 'folder', index: 0 },
        { source: 'tag', tagPrefix: 'suite' },
      ],
    });
    assert.equal(loaded.toolSettings?.outputLevel, 'diagnostic');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('getValidateDiagnosticItems summarizes effective validate context', () => {
  assert.deepEqual(
    getValidateDiagnosticItems({
      authType: 'pat',
      localType: 'gherkin',
      syncTargetMode: 'query',
      planIds: [7, 9],
      overrideCount: 2,
    }),
    [
      { label: 'Auth type', value: 'pat' },
      { label: 'Local type', value: 'gherkin' },
      { label: 'Sync target', value: 'query' },
      { label: 'Plan IDs', value: '7, 9' },
      { label: 'Overrides', value: '2' },
    ],
  );
});

test('getStaleDiagnosticItems summarizes stale detection context', () => {
  assert.deepEqual(
    getStaleDiagnosticItems({
      syncTargetMode: 'tagged',
      planIds: [5],
      markerPrefix: 'tc',
      ownershipTag: 'ado-sync:smoke-suite',
      tagExpression: '@smoke',
      staleCount: 3,
      retireState: 'Closed',
      dryRun: true,
      overrideCount: 1,
    }),
    [
      { label: 'Sync target', value: 'tagged' },
      { label: 'Plan ID', value: '5' },
      { label: 'Marker prefix', value: 'tc' },
      { label: 'Ownership tag', value: 'ado-sync:smoke-suite' },
      { label: 'Tag filter', value: '@smoke' },
      { label: 'Stale candidates', value: '3' },
      { label: 'Retire state', value: 'Closed' },
      { label: 'Dry run', value: 'yes' },
      { label: 'Overrides', value: '1' },
    ],
  );
});

test('getCoverageDiagnosticItems summarizes coverage context', () => {
  assert.deepEqual(
    getCoverageDiagnosticItems({
      localType: 'markdown',
      syncTargetMode: 'suite',
      tagExpression: '@smoke',
      totalLocalSpecs: 12,
      linkedSpecs: 9,
      unlinkedSpecs: 3,
      storiesReferenced: 5,
      storiesCovered: 4,
      storyPrefix: 'story',
      failBelow: 80,
      overrideCount: 1,
    }),
    [
      { label: 'Local type', value: 'markdown' },
      { label: 'Sync target', value: 'suite' },
      { label: 'Tag filter', value: '@smoke' },
      { label: 'Total specs', value: '12' },
      { label: 'Linked specs', value: '9' },
      { label: 'Unlinked specs', value: '3' },
      { label: 'Story prefix', value: 'story' },
      { label: 'Stories referenced', value: '5' },
      { label: 'Stories covered', value: '4' },
      { label: 'Fail-below gate', value: '80%' },
      { label: 'Overrides', value: '1' },
    ],
  );
});

test('getTrendDiagnosticItems summarizes trend context', () => {
  assert.deepEqual(
    getTrendDiagnosticItems({
      days: 14,
      maxRuns: 25,
      topN: 7,
      runNameFilter: 'nightly',
      webhookType: 'teams',
      failOnFlaky: true,
      failBelow: 85,
      runsAnalyzed: 12,
      totalResults: 240,
      flakyCount: 3,
      failingCount: 7,
      overrideCount: 2,
    }),
    [
      { label: 'Days', value: '14' },
      { label: 'Max runs', value: '25' },
      { label: 'Top-N', value: '7' },
      { label: 'Run-name filter', value: 'nightly' },
      { label: 'Webhook', value: 'teams' },
      { label: 'Fail on flaky', value: 'yes' },
      { label: 'Fail-below gate', value: '85%' },
      { label: 'Runs analyzed', value: '12' },
      { label: 'Results analyzed', value: '240' },
      { label: 'Flaky tests', value: '3' },
      { label: 'Top failing tests', value: '7' },
      { label: 'Overrides', value: '2' },
    ],
  );
});

test('getAcGateDiagnosticItems summarizes ac-gate context', () => {
  assert.deepEqual(
    getAcGateDiagnosticItems({
      selectorMode: 'area-path',
      selectorValue: 'Project\\QA',
      failMode: 'no-ac-only',
      totalStories: 9,
      passed: 6,
      failed: 3,
      noAc: 2,
      noTc: 1,
      overrideCount: 1,
    }),
    [
      { label: 'Selector mode', value: 'area-path' },
      { label: 'Selector value', value: 'Project\\QA' },
      { label: 'States', value: 'n/a' },
      { label: 'Fail mode', value: 'no-ac-only' },
      { label: 'Stories selected', value: '9' },
      { label: 'Passed', value: '6' },
      { label: 'Failed', value: '3' },
      { label: 'Missing AC', value: '2' },
      { label: 'Missing TCs', value: '1' },
      { label: 'Overrides', value: '1' },
    ],
  );
});

test('getOrCreateSuiteForFile anchors generated hierarchy under a named root suite', async () => {
  const createdSuites: Array<{ name: string; parentSuiteId: number }> = [];
  let nextSuiteId = 100;
  const client = {
    getTestPlanApi: async () => ({
      getTestSuitesForPlan: async () => [],
      createTestSuite: async (suite: any) => {
        createdSuites.push({ name: suite.name, parentSuiteId: suite.parentSuite.id });
        return { id: nextSuiteId++ };
      },
    }),
  } as any;

  const config = makeConfig({
    testPlan: {
      id: 1,
      suiteId: 10,
      hierarchy: { mode: 'byFile', rootSuite: 'Generated Specs' },
    },
  });

  const suiteId = await getOrCreateSuiteForFile(
    client,
    config,
    '/repo/specs/auth/login.feature',
    '/repo',
    new Map()
  );

  assert.equal(suiteId, 103);
  assert.deepEqual(createdSuites, [
    { name: 'Generated Specs', parentSuiteId: 10 },
    { name: 'specs', parentSuiteId: 100 },
    { name: 'auth', parentSuiteId: 101 },
    { name: 'login', parentSuiteId: 102 },
  ]);
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
    assert.equal(summary.diagnostics?.configurationId, 9);
    assert.equal(summary.diagnostics?.sources[0]?.format, 'junit');
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
    assert.deepEqual(summary.diagnostics?.plannedRun, { planId: 12, suiteId: 34, pointCount: 1 });
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

test('push limits processing to requested source files and skips removed-case detection', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-push-source-file-'));
  const selectedFilePath = path.join(tempDir, 'selected.md');
  const skippedFilePath = path.join(tempDir, 'skipped.md');
  fs.writeFileSync(selectedFilePath, ['### Selected case', '', 'Steps:', '1. Open the app', ''].join('\n'));
  fs.writeFileSync(skippedFilePath, ['### Skipped case', '', 'Steps:', '1. Do not sync me', ''].join('\n'));

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
    const results = await push(config, tempDir, { dryRun: true, sourceFiles: [selectedFilePath] });
    assert.equal(suiteFetchCount, 0);
    assert.ok(results.some((result) => result.action === 'created' && result.filePath === selectedFilePath));
    assert.ok(!results.some((result) => result.filePath === skippedFilePath));
    assert.ok(!results.some((result) => result.action === 'removed'));
  } finally {
    (AzureClient as any).create = originalCreate;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('push create-only creates unlinked cases and skips linked updates and removed detection', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-push-create-only-'));
  const filePath = path.join(tempDir, 'spec.md');
  fs.writeFileSync(filePath, [
    '### Existing case',
    '@tc:55',
    '',
    'Steps:',
    '1. Existing step',
    '',
    '---',
    '',
    '### New case',
    '',
    'Steps:',
    '1. New step',
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
      getTestPlanById: async () => ({ id: 1, rootSuite: { id: 10 } }),
    }),
    getWitApi: async () => ({
      getWorkItems: async () => [{ id: 77, fields: { 'System.Title': 'Unrelated remote case', 'System.Tags': '' } }],
    }),
  });

  try {
    const results = await push(config, tempDir, { dryRun: true, createOnly: true });
    assert.equal(suiteFetchCount, 0);
    assert.ok(results.some((result) => result.action === 'created' && result.title === 'New case'));
    assert.ok(results.some((result) => result.action === 'skipped' && result.azureId === 55 && /create-only/.test(result.detail ?? '')));
    assert.ok(!results.some((result) => result.action === 'removed'));
    assert.ok(!results.some((result) => result.action === 'updated'));
  } finally {
    (AzureClient as any).create = originalCreate;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('push link-only links unlinked cases by unique exact title match without creating or updating', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-push-link-only-'));
  const filePath = path.join(tempDir, 'spec.md');
  fs.writeFileSync(filePath, [
    '### Already linked',
    '@tc:55',
    '',
    'Steps:',
    '1. Existing step',
    '',
    '---',
    '',
    '### Match me',
    '',
    'Steps:',
    '1. Same title as remote',
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
        return [{ workItem: { id: 88 } }, { workItem: { id: 99 } }];
      },
      getTestPlanById: async () => ({ id: 1, rootSuite: { id: 10 } }),
    }),
    getWitApi: async () => ({
      getWorkItems: async () => [
        { id: 88, fields: { 'System.Title': 'Match me', 'System.Tags': '' } },
        { id: 99, fields: { 'System.Title': 'Unrelated remote case', 'System.Tags': '' } },
      ],
    }),
  });

  try {
    const results = await push(config, tempDir, { dryRun: true, linkOnly: true });
    assert.equal(suiteFetchCount, 1);
    assert.ok(results.some((result) => result.action === 'linked' && result.azureId === 88 && result.title === 'Match me'));
    assert.ok(results.some((result) => result.action === 'skipped' && result.azureId === 55 && /link-only/.test(result.detail ?? '')));
    assert.ok(!results.some((result) => result.action === 'created'));
    assert.ok(!results.some((result) => result.action === 'updated'));
    assert.ok(!results.some((result) => result.action === 'removed'));
  } finally {
    (AzureClient as any).create = originalCreate;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('push link-only skips ambiguous exact title matches', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-push-link-ambiguous-'));
  const filePath = path.join(tempDir, 'spec.md');
  fs.writeFileSync(filePath, ['### Duplicate title', '', 'Steps:', '1. Step', ''].join('\n'));

  const config = makeConfig({
    local: { type: 'markdown', include: '*.md' },
  });

  const originalCreate = AzureClient.create;
  (AzureClient as any).create = async () => ({
    getTestPlanApi: async () => ({
      getTestCaseList: async () => [{ workItem: { id: 90 } }, { workItem: { id: 91 } }],
      getTestPlanById: async () => ({ id: 1, rootSuite: { id: 10 } }),
    }),
    getWitApi: async () => ({
      getWorkItems: async () => [
        { id: 90, fields: { 'System.Title': 'Duplicate title', 'System.Tags': '' } },
        { id: 91, fields: { 'System.Title': 'Duplicate title', 'System.Tags': '' } },
      ],
    }),
  });

  try {
    const results = await push(config, tempDir, { dryRun: true, linkOnly: true });
    assert.ok(results.some((result) => result.action === 'skipped' && /multiple title matches/.test(result.detail ?? '')));
    assert.ok(!results.some((result) => result.action === 'linked'));
    assert.ok(!results.some((result) => result.action === 'created'));
  } finally {
    (AzureClient as any).create = originalCreate;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('push update-only updates linked cases and skips unlinked cases and removed detection', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-push-update-only-'));
  const filePath = path.join(tempDir, 'spec.md');
  fs.writeFileSync(filePath, [
    '### Existing case',
    '@tc:55',
    '',
    'Steps:',
    '1. Updated local step',
    '',
    '---',
    '',
    '### New case',
    '',
    'Steps:',
    '1. New step',
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
      getTestPlanById: async () => ({ id: 1, rootSuite: { id: 10 } }),
      addTestCasesToSuite: async () => undefined,
    }),
    getWitApi: async () => ({
      getWorkItems: async () => [{
        id: 77,
        fields: {
          'System.Title': 'Unrelated remote case',
          'System.Tags': '',
        },
      }],
      getWorkItem: async (id: number) => ({
        id,
        fields: {
          'System.Title': 'Existing case',
          'System.Description': '',
          'Microsoft.VSTS.TCM.Steps': '<steps id="0" last="2"><step id="2" type="ValidateStep"><parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;Step Existing local step&lt;/P&gt;&lt;/DIV&gt;</parameterizedString><parameterizedString isformatted="true"></parameterizedString><description/></step></steps>',
          'System.Tags': '',
          'System.ChangedDate': '2026-05-01T00:00:00Z',
        },
      }),
      updateWorkItem: async () => ({}),
    }),
  });

  try {
    const results = await push(config, tempDir, { dryRun: true, updateOnly: true });
    assert.equal(suiteFetchCount, 0);
    assert.ok(results.some((result) => result.action === 'updated' && result.azureId === 55));
    assert.ok(results.some((result) => result.action === 'skipped' && result.title === 'New case' && /update-only/.test(result.detail ?? '')));
    assert.ok(!results.some((result) => result.action === 'created'));
    assert.ok(!results.some((result) => result.action === 'removed'));
  } finally {
    (AzureClient as any).create = originalCreate;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('push moves linked hierarchy-managed cases to the new generated suite when file path changes', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-push-hierarchy-move-'));
  const oldRelativePath = 'specs/old/login.md';
  const newRelativePath = 'specs/new/login.md';
  const filePath = path.join(tempDir, newRelativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, ['### Existing case', '@tc:55', '', 'Steps:', '1. Existing step', ''].join('\n'));
  fs.writeFileSync(path.join(tempDir, '.ado-sync-state.json'), JSON.stringify({
    55: {
      title: 'Existing case',
      stepsHash: 'cached-steps',
      descriptionHash: 'cached-description',
      remoteDescriptionHash: 'cached-remote-description',
      changedDate: '2026-05-01T00:00:00Z',
      filePath: path.join(tempDir, oldRelativePath),
    },
  }, null, 2));

  const config = makeConfig({
    local: { type: 'markdown', include: 'specs/**/*.md' },
    testPlan: {
      id: 1,
      suiteId: 10,
      hierarchy: { mode: 'byFolder' },
    },
  });

  const addedToSuites: number[] = [];
  const removedFromSuites: number[] = [];
  const suites = [
    { id: 101, name: 'specs', parentSuite: { id: 10 } },
    { id: 102, name: 'old', parentSuite: { id: 101 } },
  ];
  let nextSuiteId = 103;

  const originalCreate = AzureClient.create;
  (AzureClient as any).create = async () => ({
    getTestPlanApi: async () => ({
      getTestCaseList: async () => [],
      getTestPlanById: async () => ({ id: 1, rootSuite: { id: 10 } }),
      getTestSuitesForPlan: async () => suites,
      createTestSuite: async (suite: any) => {
        const created = { id: nextSuiteId++, name: suite.name, parentSuite: { id: suite.parentSuite.id } };
        suites.push(created);
        return created;
      },
      addTestCasesToSuite: async (_entries: any, _project: string, _planId: number, suiteId: number) => {
        addedToSuites.push(suiteId);
      },
      removeTestCasesFromSuite: async (_project: string, _planId: number, suiteId: number, _testCaseIds: string) => {
        removedFromSuites.push(suiteId);
      },
    }),
    getWitApi: async () => ({
      getWorkItem: async (id: number) => ({
        id,
        fields: {
          'System.Title': 'Existing case',
          'System.Description': '',
          'Microsoft.VSTS.TCM.Steps': '<steps id="0" last="2"><step id="2" type="ValidateStep"><parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;Step Existing step&lt;/P&gt;&lt;/DIV&gt;</parameterizedString><parameterizedString isformatted="true"></parameterizedString><description/></step></steps>',
          'System.Tags': '',
          'System.ChangedDate': '2026-05-01T00:00:00Z',
        },
      }),
      updateWorkItem: async () => ({})
    }),
  });

  try {
    const results = await push(config, tempDir, { dryRun: false });
    assert.ok(results.some((result) => result.action === 'updated' && result.azureId === 55 && result.changedFields?.includes('suite') && result.targetSuitePath === 'specs / new' && result.previousSuitePath === 'specs / old'));
    assert.deepEqual(addedToSuites, [103]);
    assert.deepEqual(removedFromSuites, [102]);
  } finally {
    (AzureClient as any).create = originalCreate;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('push moves linked hierarchy-managed cases when the tag-driven suite path changes', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-push-hierarchy-by-tag-move-'));
  const filePath = path.join(tempDir, 'specs', 'login.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, ['### Existing case', '@tc:55 @suite:new/path', '', 'Steps:', '1. Existing step', ''].join('\n'));
  fs.writeFileSync(path.join(tempDir, '.ado-sync-state.json'), JSON.stringify({
    55: {
      title: 'Existing case',
      stepsHash: 'cached-steps',
      descriptionHash: 'cached-description',
      remoteDescriptionHash: 'cached-remote-description',
      changedDate: '2026-05-01T00:00:00Z',
      filePath,
      suitePathKey: 'old/path',
    },
  }, null, 2));

  const config = makeConfig({
    local: { type: 'markdown', include: 'specs/**/*.md' },
    testPlan: {
      id: 1,
      suiteId: 10,
      hierarchy: { mode: 'byTag', tagPrefix: 'suite' },
    },
  });

  const addedToSuites: number[] = [];
  const removedFromSuites: number[] = [];
  const suites = [
    { id: 101, name: 'old', parentSuite: { id: 10 } },
    { id: 102, name: 'path', parentSuite: { id: 101 } },
  ];
  let nextSuiteId = 103;

  const originalCreate = AzureClient.create;
  (AzureClient as any).create = async () => ({
    getTestPlanApi: async () => ({
      getTestCaseList: async () => [],
      getTestPlanById: async () => ({ id: 1, rootSuite: { id: 10 } }),
      getTestSuitesForPlan: async () => suites,
      createTestSuite: async (suite: any) => {
        const created = { id: nextSuiteId++, name: suite.name, parentSuite: { id: suite.parentSuite.id } };
        suites.push(created);
        return created;
      },
      addTestCasesToSuite: async (_entries: any, _project: string, _planId: number, suiteId: number) => {
        addedToSuites.push(suiteId);
      },
      removeTestCasesFromSuite: async (_project: string, _planId: number, suiteId: number) => {
        removedFromSuites.push(suiteId);
      },
    }),
    getWitApi: async () => ({
      getWorkItem: async (id: number) => ({
        id,
        fields: {
          'System.Title': 'Existing case',
          'System.Description': '',
          'Microsoft.VSTS.TCM.Steps': '<steps id="0" last="2"><step id="2" type="ValidateStep"><parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;Step Existing step&lt;/P&gt;&lt;/DIV&gt;</parameterizedString><parameterizedString isformatted="true"></parameterizedString><description/></step></steps>',
          'System.Tags': '',
          'System.ChangedDate': '2026-05-01T00:00:00Z',
        },
      }),
      updateWorkItem: async () => ({}),
    }),
  });

  try {
    const results = await push(config, tempDir, { dryRun: false });
    assert.ok(results.some((result) => result.action === 'updated' && result.azureId === 55 && result.changedFields?.includes('suite') && result.targetSuitePath === 'new / path' && result.previousSuitePath === 'old / path'));
    assert.deepEqual(addedToSuites, [104]);
    assert.deepEqual(removedFromSuites, [102]);
  } finally {
    (AzureClient as any).create = originalCreate;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('status previews generated suite targets for hierarchy-managed creates', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-status-hierarchy-target-'));
  const filePath = path.join(tempDir, 'specs', 'auth', 'login.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, ['### Login case', '', 'Steps:', '1. Open app', ''].join('\n'));

  const config = makeConfig({
    local: { type: 'markdown', include: 'specs/**/*.md' },
    testPlan: {
      id: 1,
      suiteId: 10,
      hierarchy: { mode: 'byFolder', rootSuite: 'Generated Specs' },
    },
  });

  const originalCreate = AzureClient.create;
  (AzureClient as any).create = async () => ({
    getTestPlanApi: async () => ({
      getTestCaseList: async () => [],
      getTestPlanById: async () => ({ id: 1, rootSuite: { id: 10 } }),
    }),
    getWitApi: async () => ({
      getWorkItems: async () => [],
    }),
  });

  try {
    const results = await status(config, tempDir);
    assert.ok(results.some((result) => result.action === 'created' && result.targetSuitePath === 'Generated Specs / specs / auth'));
  } finally {
    (AzureClient as any).create = originalCreate;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('status previews tag-driven hierarchy targets for creates', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-status-hierarchy-by-tag-target-'));
  const filePath = path.join(tempDir, 'specs', 'auth', 'login.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, ['### Login case', '<!-- tags: @suite:mobile/auth -->', '', 'Steps:', '1. Open app', ''].join('\n'));

  const config = makeConfig({
    local: { type: 'markdown', include: 'specs/**/*.md' },
    testPlan: {
      id: 1,
      suiteId: 10,
      hierarchy: { mode: 'byTag', tagPrefix: 'suite', rootSuite: 'Generated Specs' },
    },
  });

  const originalCreate = AzureClient.create;
  (AzureClient as any).create = async () => ({
    getTestPlanApi: async () => ({
      getTestCaseList: async () => [],
      getTestPlanById: async () => ({ id: 1, rootSuite: { id: 10 } }),
    }),
    getWitApi: async () => ({
      getWorkItems: async () => [],
    }),
  });

  try {
    const results = await status(config, tempDir);
    assert.ok(results.some((result) => result.action === 'created' && result.targetSuitePath === 'Generated Specs / mobile / auth'));
  } finally {
    (AzureClient as any).create = originalCreate;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('status previews level-rule hierarchy targets for creates', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-status-hierarchy-by-levels-target-'));
  const filePath = path.join(tempDir, 'specs', 'auth', 'login.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, ['### Login case', '<!-- tags: @suite:mobile -->', '', 'Steps:', '1. Open app', ''].join('\n'));

  const config = makeConfig({
    local: { type: 'markdown', include: 'specs/**/*.md' },
    testPlan: {
      id: 1,
      suiteId: 10,
      hierarchy: {
        mode: 'byLevels',
        rootSuite: 'Generated Specs',
        levels: [
          { source: 'folder', index: 1 },
          { source: 'tag', tagPrefix: 'suite' },
        ],
      },
    },
  });

  const originalCreate = AzureClient.create;
  (AzureClient as any).create = async () => ({
    getTestPlanApi: async () => ({
      getTestCaseList: async () => [],
      getTestPlanById: async () => ({ id: 1, rootSuite: { id: 10 } }),
    }),
    getWitApi: async () => ({
      getWorkItems: async () => [],
    }),
  });

  try {
    const results = await status(config, tempDir);
    assert.ok(results.some((result) => result.action === 'created' && result.targetSuitePath === 'Generated Specs / auth / mobile'));
  } finally {
    (AzureClient as any).create = originalCreate;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('push can prune empty generated suites after a hierarchy-managed move', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-push-hierarchy-prune-'));
  const oldRelativePath = 'specs/old/login.md';
  const newRelativePath = 'specs/new/login.md';
  const filePath = path.join(tempDir, newRelativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, ['### Existing case', '@tc:55', '', 'Steps:', '1. Existing step', ''].join('\n'));
  fs.writeFileSync(path.join(tempDir, '.ado-sync-state.json'), JSON.stringify({
    55: {
      title: 'Existing case',
      stepsHash: 'cached-steps',
      descriptionHash: 'cached-description',
      remoteDescriptionHash: 'cached-remote-description',
      changedDate: '2026-05-01T00:00:00Z',
      filePath: path.join(tempDir, oldRelativePath),
    },
  }, null, 2));

  const config = makeConfig({
    local: { type: 'markdown', include: 'specs/**/*.md' },
    testPlan: {
      id: 1,
      suiteId: 10,
      hierarchy: { mode: 'byFolder', cleanupEmptySuites: true },
    },
  });

  const deletedSuites: number[] = [];
  const suites = [
    { id: 101, name: 'specs', parentSuite: { id: 10 } },
    { id: 102, name: 'old', parentSuite: { id: 101 } },
  ];
  let nextSuiteId = 103;

  const originalCreate = AzureClient.create;
  (AzureClient as any).create = async () => ({
    getTestPlanApi: async () => ({
      getTestCaseList: async (_project: string, _planId: number, suiteId: number) => {
        if (suiteId === 10) return [{ testCase: { id: 77 } }];
        if (suiteId === 102 || suiteId === 101) return [];
        return [];
      },
      getTestPlanById: async () => ({ id: 1, rootSuite: { id: 10 } }),
      getTestSuitesForPlan: async () => suites,
      createTestSuite: async (suite: any) => {
        const created = { id: nextSuiteId++, name: suite.name, parentSuite: { id: suite.parentSuite.id } };
        suites.push(created);
        return created;
      },
      addTestCasesToSuite: async () => undefined,
      removeTestCasesFromSuite: async () => undefined,
      deleteTestSuite: async (_project: string, _planId: number, suiteId: number) => {
        deletedSuites.push(suiteId);
        const index = suites.findIndex((suite) => suite.id === suiteId);
        if (index >= 0) suites.splice(index, 1);
      },
    }),
    getWitApi: async () => ({
      getWorkItem: async (id: number) => ({
        id,
        fields: {
          'System.Title': 'Existing case',
          'System.Description': '',
          'Microsoft.VSTS.TCM.Steps': '<steps id="0" last="2"><step id="2" type="ValidateStep"><parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;Step Existing step&lt;/P&gt;&lt;/DIV&gt;</parameterizedString><parameterizedString isformatted="true"></parameterizedString><description/></step></steps>',
          'System.Tags': '',
          'System.ChangedDate': '2026-05-01T00:00:00Z',
        },
      }),
      updateWorkItem: async () => ({})
    }),
  });

  try {
    await push(config, tempDir, { dryRun: false });
    assert.deepEqual(deletedSuites, [102]);
  } finally {
    (AzureClient as any).create = originalCreate;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('push can prune empty stale generated suites for removed local specs on full-scope runs', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-push-hierarchy-stale-prune-'));
  const filePath = path.join(tempDir, 'specs', 'active', 'login.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, ['### Active case', '@tc:55', '', 'Steps:', '1. Existing step', ''].join('\n'));
  fs.writeFileSync(path.join(tempDir, '.ado-sync-state.json'), JSON.stringify({
    55: {
      title: 'Active case',
      stepsHash: 'cached-steps',
      descriptionHash: 'cached-description',
      remoteDescriptionHash: 'cached-remote-description',
      changedDate: '2026-05-01T00:00:00Z',
      filePath,
    },
    77: {
      title: 'Removed local case',
      stepsHash: 'stale-steps',
      descriptionHash: 'stale-description',
      remoteDescriptionHash: 'stale-remote-description',
      changedDate: '2026-05-01T00:00:00Z',
      filePath: path.join(tempDir, 'specs', 'legacy', 'old.md'),
      suitePathKey: 'specs/legacy',
    },
  }, null, 2));

  const config = makeConfig({
    local: { type: 'markdown', include: 'specs/**/*.md' },
    testPlan: {
      id: 1,
      suiteId: 10,
      hierarchy: { mode: 'byFolder', cleanupEmptySuites: true },
    },
  });

  const deletedSuites: number[] = [];
  const suites = [
    { id: 101, name: 'specs', parentSuite: { id: 10 } },
    { id: 102, name: 'legacy', parentSuite: { id: 101 } },
    { id: 103, name: 'active', parentSuite: { id: 101 } },
  ];

  const originalCreate = AzureClient.create;
  (AzureClient as any).create = async () => ({
    getTestPlanApi: async () => ({
      getTestCaseList: async (_project: string, _planId: number, suiteId: number) => {
        if (suiteId === 10) return [{ workItem: { id: 77 } }];
        if (suiteId === 103) return [{ workItem: { id: 55 } }];
        if (suiteId === 102 || suiteId === 101) return [];
        return [];
      },
      getTestPlanById: async () => ({ id: 1, rootSuite: { id: 10 } }),
      getTestSuitesForPlan: async () => suites,
      addTestCasesToSuite: async () => undefined,
      removeTestCasesFromSuite: async () => undefined,
      deleteTestSuite: async (_project: string, _planId: number, suiteId: number) => {
        deletedSuites.push(suiteId);
        const index = suites.findIndex((suite) => suite.id === suiteId);
        if (index >= 0) suites.splice(index, 1);
      },
    }),
    getWitApi: async () => ({
      getWorkItem: async (id: number) => ({
        id,
        fields: {
          'System.Title': id === 55 ? 'Active case' : 'Removed local case',
          'System.Description': '',
          'Microsoft.VSTS.TCM.Steps': '<steps id="0" last="2"><step id="2" type="ValidateStep"><parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;Step Existing step&lt;/P&gt;&lt;/DIV&gt;</parameterizedString><parameterizedString isformatted="true"></parameterizedString><description/></step></steps>',
          'System.Tags': '',
          'System.ChangedDate': '2026-05-01T00:00:00Z',
        },
      }),
      getWorkItems: async () => [{
        id: 77,
        fields: {
          'System.WorkItemType': 'Test Case',
          'System.Title': 'Removed local case',
          'System.Description': '',
          'Microsoft.VSTS.TCM.Steps': '<steps id="0" last="2"><step id="2" type="ValidateStep"><parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;Step Existing step&lt;/P&gt;&lt;/DIV&gt;</parameterizedString><parameterizedString isformatted="true"></parameterizedString><description/></step></steps>',
          'System.Tags': '',
          'System.ChangedDate': '2026-05-01T00:00:00Z',
        },
      }],
      updateWorkItem: async () => ({}),
    }),
  });

  try {
    await push(config, tempDir, { dryRun: false });
    assert.deepEqual(deletedSuites, [102]);
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

test('pull-create is blocked on source-file-filtered runs', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-pull-source-file-'));
  const filePath = path.join(tempDir, 'sample.feature');
  fs.writeFileSync(filePath, ['Feature: Sample', '', '  Scenario: existing test', '    Given a step', ''].join('\n'));

  const config = makeConfig({
    local: { type: 'gherkin', include: '*.feature' },
    sync: {
      tagPrefix: 'tc',
      pull: { enableCreatingNewLocalTestCases: true },
    },
  });

  const originalCreate = AzureClient.create;
  (AzureClient as any).create = async () => ({
    getTestApi: async () => ({}),
    getTestPlanApi: async () => ({
      getTestCaseList: async () => [],
      getTestPlanById: async () => ({ rootSuite: { id: 10 } }),
    }),
    getWitApi: async () => ({ getWorkItems: async () => [] }),
  });

  try {
    const results = await pull(config, tempDir, { sourceFiles: [filePath] });
    assert.ok(results.some((result) => result.action === 'error' && /--source-file/.test(result.detail ?? '')));
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

test('getTestCasesInSuite filters remote inventory to tagged ownership scope', async () => {
  const config = makeConfig({
    configurationKey: 'Smoke Suite',
    syncTarget: { mode: 'tagged' },
  });
  const ownershipTag = getSyncTargetOwnershipTag(config);
  const client = {
    getTestPlanApi: async () => ({
      getTestCaseList: async () => [
        { workItem: { id: 101 } },
        { workItem: { id: 102 } },
      ],
      getTestPlanById: async () => ({ rootSuite: { id: 10 } }),
    }),
    getWitApi: async () => ({
      getWorkItems: async () => [
        { id: 101, fields: { 'System.Title': 'Owned case', 'System.Tags': ownershipTag } },
        { id: 102, fields: { 'System.Title': 'Other case', 'System.Tags': 'other-owner' } },
      ],
    }),
  } as any;

  const testCases = await getTestCasesInSuite(client, config);

  assert.deepEqual(testCases.map((testCase) => testCase.id), [101]);
});

test('getTestCasesInSuite resolves query-based sync targets via WIQL', async () => {
  const config = makeConfig({
    syncTarget: {
      mode: 'query',
      wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'Test Case'",
    },
  });
  let suiteFetchCount = 0;
  const client = {
    getTestPlanApi: async () => ({
      getTestCaseList: async () => {
        suiteFetchCount++;
        return [];
      },
    }),
    getWitApi: async () => ({
      queryByWiql: async () => ({ workItems: [{ id: 77 }] }),
      getWorkItems: async () => [{
        id: 77,
        fields: {
          'System.WorkItemType': 'Test Case',
          'System.Title': 'Query-owned case',
          'System.Tags': '',
        },
      }],
    }),
  } as any;

  const testCases = await getTestCasesInSuite(client, config);

  assert.equal(suiteFetchCount, 0);
  assert.deepEqual(testCases.map((testCase) => testCase.id), [77]);
});

test('status supports query-based sync targets with testPlans', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-sync-status-query-testplans-'));
  const smokePath = path.join(tempDir, 'specs', 'smoke', 'login.md');
  const regressionPath = path.join(tempDir, 'specs', 'regression', 'checkout.md');
  fs.mkdirSync(path.dirname(smokePath), { recursive: true });
  fs.mkdirSync(path.dirname(regressionPath), { recursive: true });
  fs.writeFileSync(smokePath, ['### Login case', '', 'Steps:', '1. Open app', ''].join('\n'));
  fs.writeFileSync(regressionPath, ['### Checkout case', '', 'Steps:', '1. Add item', ''].join('\n'));

  const config = makeConfig({
    local: { type: 'markdown', include: 'specs/**/*.md' },
    syncTarget: {
      mode: 'query',
      wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'Test Case'",
    },
    testPlans: [
      { id: 11, include: 'specs/smoke/**/*.md' },
      { id: 22, include: 'specs/regression/**/*.md' },
    ],
  });

  let suiteFetchCount = 0;
  let queryCount = 0;
  const originalCreate = AzureClient.create;
  (AzureClient as any).create = async () => ({
    getTestPlanApi: async () => ({
      getTestCaseList: async () => {
        suiteFetchCount++;
        return [];
      },
      getTestPlanById: async (_project: string, planId: number) => ({ id: planId, rootSuite: { id: planId * 10 } }),
    }),
    getWitApi: async () => ({
      queryByWiql: async () => {
        queryCount++;
        return { workItems: [] };
      },
      getWorkItems: async () => [],
    }),
  });

  try {
    const results = await status(config, tempDir);
    assert.equal(queryCount, 2);
    assert.equal(suiteFetchCount, 0);
    assert.equal(results.filter((result) => result.action === 'created').length, 2);
  } finally {
    (AzureClient as any).create = originalCreate;
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
