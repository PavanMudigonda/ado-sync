import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { updateTestCase } from '../azure/test-cases';
import { parseJavaScriptFile } from '../parsers/javascript';
import { buildPushDiff, failOnParseErrors } from '../sync/engine';
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
