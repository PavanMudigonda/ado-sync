/**
 * CRUD operations for Azure DevOps Test Cases (Work Items of type "Test Case").
 *
 * Azure stores test steps as XML in the field:
 *   Microsoft.VSTS.TCM.Steps
 *
 * Step XML shape:
 *   <steps id="0" last="N">
 *     <step id="2" type="ValidateStep">
 *       <parameterizedString isformatted="true">&lt;DIV&gt;Action text&lt;/DIV&gt;</parameterizedString>
 *       <parameterizedString isformatted="true">&lt;DIV&gt;Expected text&lt;/DIV&gt;</parameterizedString>
 *       <description/>
 *     </step>
 *   </steps>
 */

import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { AzureClient } from './client';
import { AzureStep, AzureTestCase, ParsedTest, SyncConfig } from '../types';

// ─── XML helpers ─────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapDiv(text: string): string {
  return `<DIV><P><B>${escapeHtml(text)}</B></P></DIV>`;
}

function buildStepsXml(steps: AzureStep[]): string {
  if (steps.length === 0) return '<steps id="0" last="1"/>';

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    format: false,
  });

  const stepNodes = steps.map((s, i) => ({
    '@_id': String(i + 2),
    '@_type': 'ValidateStep',
    parameterizedString: [
      { '@_isformatted': 'true', '#text': wrapDiv(s.action) },
      { '@_isformatted': 'true', '#text': wrapDiv(s.expected || '') },
    ],
    description: '',
  }));

  const xml = builder.build({
    steps: {
      '@_id': '0',
      '@_last': String(steps.length + 1),
      step: stepNodes,
    },
  });

  return xml;
}

function parseStepsXml(xml: string): AzureStep[] {
  if (!xml) return [];

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => name === 'step' || name === 'parameterizedString',
  });

  let parsed: any;
  try {
    parsed = parser.parse(xml);
  } catch {
    return [];
  }

  const rawSteps = parsed?.steps?.step ?? [];
  return rawSteps.map((s: any) => {
    const strings: any[] = s.parameterizedString ?? [];
    const stripTags = (v: any): string =>
      String(v ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return {
      action: stripTags(strings[0]?.['#text'] ?? strings[0] ?? ''),
      expected: stripTags(strings[1]?.['#text'] ?? strings[1] ?? ''),
    } as AzureStep;
  });
}

// ─── Tag helpers ─────────────────────────────────────────────────────────────

function tagsToString(tags: string[]): string {
  return tags.join('; ');
}

function tagsFromString(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[;,]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

// ─── API layer ───────────────────────────────────────────────────────────────

export async function getTestCase(
  client: AzureClient,
  id: number
): Promise<AzureTestCase | null> {
  const wit = await client.getWitApi();
  const fields = [
    'System.Title',
    'System.Description',
    'Microsoft.VSTS.TCM.Steps',
    'System.Tags',
    'System.ChangedDate',
    'System.AreaPath',
    'System.IterationPath',
  ];

  let wi: any;
  try {
    wi = await wit.getWorkItem(id, fields);
  } catch {
    return null;
  }

  if (!wi) return null;

  const f = wi.fields ?? {};
  return {
    id,
    title: f['System.Title'] ?? '',
    description: f['System.Description'] ?? '',
    steps: parseStepsXml(f['Microsoft.VSTS.TCM.Steps'] ?? ''),
    tags: tagsFromString(f['System.Tags']),
    changedDate: f['System.ChangedDate'],
    areaPath: f['System.AreaPath'],
    iterationPath: f['System.IterationPath'],
  };
}

export async function createTestCase(
  client: AzureClient,
  test: ParsedTest,
  config: SyncConfig
): Promise<number> {
  const wit = await client.getWitApi();

  const steps: AzureStep[] = test.steps.map((s) => ({
    action: `${s.keyword} ${s.text}`.trim(),
    expected: s.expected ?? '',
  }));

  const syncCfg = config.sync ?? {};

  const patchDoc: any[] = [
    { op: 'add', path: '/fields/System.Title', value: test.title },
    { op: 'add', path: '/fields/Microsoft.VSTS.TCM.Steps', value: buildStepsXml(steps) },
  ];

  if (test.description) {
    patchDoc.push({ op: 'add', path: '/fields/System.Description', value: test.description });
  }

  const filteredTags = test.tags
    .filter((t) => !t.startsWith(syncCfg.tagPrefix + ':'))
    .join('; ');
  if (filteredTags) {
    patchDoc.push({ op: 'add', path: '/fields/System.Tags', value: filteredTags });
  }

  if (syncCfg.areaPath) {
    patchDoc.push({ op: 'add', path: '/fields/System.AreaPath', value: syncCfg.areaPath });
  }
  if (syncCfg.iterationPath) {
    patchDoc.push({ op: 'add', path: '/fields/System.IterationPath', value: syncCfg.iterationPath });
  }

  const wi = await wit.createWorkItem(
    {},
    patchDoc,
    config.project,
    'Test Case'
  );

  if (!wi?.id) throw new Error(`Failed to create test case for: ${test.title}`);

  // Add to test suite
  const suiteId = config.testPlan.suiteId;
  if (suiteId) {
    await addTestCaseToSuite(client, config, wi.id, suiteId);
  } else {
    await addTestCaseToRootSuite(client, config, wi.id);
  }

  return wi.id;
}

export async function updateTestCase(
  client: AzureClient,
  id: number,
  test: ParsedTest,
  config: SyncConfig
): Promise<void> {
  const wit = await client.getWitApi();

  const steps: AzureStep[] = test.steps.map((s) => ({
    action: `${s.keyword} ${s.text}`.trim(),
    expected: s.expected ?? '',
  }));

  const syncCfg = config.sync ?? {};

  const filteredTags = test.tags
    .filter((t) => !t.startsWith(syncCfg.tagPrefix + ':'))
    .join('; ');

  const patchDoc: any[] = [
    { op: 'replace', path: '/fields/System.Title', value: test.title },
    { op: 'replace', path: '/fields/Microsoft.VSTS.TCM.Steps', value: buildStepsXml(steps) },
    { op: 'replace', path: '/fields/System.Tags', value: filteredTags },
  ];

  if (test.description) {
    patchDoc.push({ op: 'replace', path: '/fields/System.Description', value: test.description });
  }

  await wit.updateWorkItem({}, patchDoc, id);
}

export async function updateLocalFromAzure(
  client: AzureClient,
  id: number
): Promise<AzureTestCase | null> {
  return getTestCase(client, id);
}

async function addTestCaseToSuite(
  client: AzureClient,
  config: SyncConfig,
  testCaseId: number,
  suiteId: number
): Promise<void> {
  const api = await client.getTestPlanApi();
  await api.addTestCasesToSuite(
    [{ workItem: { id: testCaseId } } as any],
    config.project,
    config.testPlan.id,
    suiteId
  );
}

async function addTestCaseToRootSuite(
  client: AzureClient,
  config: SyncConfig,
  testCaseId: number
): Promise<void> {
  // Fetch the plan to get its root suite id
  const api = await client.getTestPlanApi();
  const plan = await api.getTestPlanById(config.project, config.testPlan.id);
  const rootSuiteId = plan?.rootSuite?.id;
  if (!rootSuiteId) return;

  await api.addTestCasesToSuite(
    [{ workItem: { id: testCaseId } } as any],
    config.project,
    config.testPlan.id,
    rootSuiteId
  );
}

export async function getTestCasesInSuite(
  client: AzureClient,
  config: SyncConfig,
  suiteId?: number
): Promise<AzureTestCase[]> {
  const api = await client.getTestPlanApi();
  const wit = await client.getWitApi();

  // Resolve suiteId
  let resolvedSuiteId = suiteId ?? config.testPlan.suiteId;
  if (!resolvedSuiteId) {
    const plan = await api.getTestPlanById(config.project, config.testPlan.id);
    resolvedSuiteId = plan?.rootSuite?.id;
  }
  if (!resolvedSuiteId) return [];

  const suiteTestCases = await api.getTestCaseList(
    config.project,
    config.testPlan.id,
    resolvedSuiteId
  );

  if (!suiteTestCases?.length) return [];

  const fields = [
    'System.Title',
    'System.Description',
    'Microsoft.VSTS.TCM.Steps',
    'System.Tags',
    'System.ChangedDate',
    'System.AreaPath',
    'System.IterationPath',
  ];

  const ids = suiteTestCases.map((tc: any) => tc.workItem?.id).filter(Boolean) as number[];
  if (!ids.length) return [];

  const workItems = await wit.getWorkItems(ids, fields);

  return (workItems ?? []).map((wi: any): AzureTestCase => {
    const f = wi.fields ?? {};
    return {
      id: wi.id,
      title: f['System.Title'] ?? '',
      description: f['System.Description'] ?? '',
      steps: parseStepsXml(f['Microsoft.VSTS.TCM.Steps'] ?? ''),
      tags: tagsFromString(f['System.Tags']),
      changedDate: f['System.ChangedDate'],
      areaPath: f['System.AreaPath'],
      iterationPath: f['System.IterationPath'],
    };
  });
}
