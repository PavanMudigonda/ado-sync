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
 *
 * For Scenario Outlines, parameter data is stored in:
 *   Microsoft.VSTS.TCM.LocalDataSource  (NewDataSet XML)
 */

import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import * as path from 'path';

import { AzureStep, AzureTestCase, LinkConfig, ParsedTest, SyncConfig } from '../types';
import { AzureClient } from './client';

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

/**
 * Build the NewDataSet XML for Microsoft.VSTS.TCM.LocalDataSource.
 * Used for Scenario Outline / parametrized test cases.
 */
function buildParameterDataXml(headers: string[], rows: string[][]): string {
  if (!headers.length || !rows.length) return '';

  const rowsXml = rows
    .map((row) => {
      const cells = headers
        .map((h, i) => `<${escapeXmlName(h)}>${escapeHtml(row[i] ?? '')}</${escapeXmlName(h)}>`)
        .join('');
      return `<Table1>${cells}</Table1>`;
    })
    .join('');

  return `<NewDataSet>${rowsXml}</NewDataSet>`;
}

/** Make a column name safe for XML element names (spaces → underscores). */
function escapeXmlName(name: string): string {
  return name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-.]/g, '');
}

// ─── Tag helpers ─────────────────────────────────────────────────────────────

function tagsFromString(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[;,]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

// ─── Work item relation helpers ───────────────────────────────────────────────

function workItemUrl(orgUrl: string, id: number): string {
  return `${orgUrl.replace(/\/$/, '')}/_apis/wit/workItems/${id}`;
}

/**
 * Fetch existing work item relations from a TC.
 * Returns relations that match any of the configured link relationship types.
 */
async function fetchManagedRelations(
  client: AzureClient,
  tcId: number,
  linkConfigs: LinkConfig[]
): Promise<Array<{ rel: string; url: string; wiId: number }>> {
  const wit = await client.getWitApi();
  let wi: any;
  try {
    wi = await (wit as any).getWorkItem(tcId, undefined, undefined, 4 /* WorkItemExpand.Relations */);
  } catch {
    return [];
  }
  if (!wi?.relations) return [];

  const configuredRels = new Set(linkConfigs.map((c) => c.relationship ?? 'System.LinkTypes.Related'));

  const managed: Array<{ rel: string; url: string; wiId: number }> = [];
  for (const rel of wi.relations as any[]) {
    if (!configuredRels.has(rel.rel)) continue;
    const urlParts = (rel.url as string).split('/');
    const wiId = parseInt(urlParts[urlParts.length - 1], 10);
    if (!isNaN(wiId)) managed.push({ rel: rel.rel, url: rel.url, wiId });
  }
  return managed;
}

/**
 * Build add patches for new link relations.
 * On update, stale relations (present in Azure but absent from local tags) are
 * removed via a separate updateWorkItem call before this patch is applied.
 */
async function applyLinkRelations(
  client: AzureClient,
  tcId: number,
  test: ParsedTest,
  config: SyncConfig,
  isCreate: boolean
): Promise<any[]> {
  const linkConfigs = config.sync?.links;
  if (!linkConfigs?.length) return [];

  const desired = test.linkRefs ?? [];
  const patches: any[] = [];

  if (isCreate) {
    for (const ref of desired) {
      const cfg = linkConfigs.find((c) => c.prefix === ref.prefix);
      patches.push({
        op: 'add',
        path: '/relations/-',
        value: {
          rel: cfg?.relationship ?? 'System.LinkTypes.Related',
          url: workItemUrl(config.orgUrl, ref.id),
          attributes: { comment: `ado-sync:${ref.prefix}` },
        },
      });
    }
    return patches;
  }

  // Update: remove stale, add new
  const existing = await fetchManagedRelations(client, tcId, linkConfigs);
  const desiredIds = new Set(desired.map((r) => r.id));
  const existingIds = new Set(existing.map((r) => r.wiId));

  // Remove stale relations: need separate API call with the relation index
  const staleUrls = existing.filter((r) => !desiredIds.has(r.wiId)).map((r) => r.url);
  if (staleUrls.length) {
    const wit = await client.getWitApi();
    // Fetch full WI to get relation indices
    let fullWi: any;
    try {
      fullWi = await (wit as any).getWorkItem(tcId, undefined, undefined, 4);
    } catch { /* skip removal on error */ }
    if (fullWi?.relations) {
      const staleUrlSet = new Set(staleUrls);
      const removePatches = (fullWi.relations as any[])
        .map((r: any, idx: number) => ({ url: r.url as string, idx }))
        .filter(({ url }) => staleUrlSet.has(url))
        .sort((a, b) => b.idx - a.idx) // remove from highest index first
        .map(({ idx }) => ({ op: 'remove', path: `/relations/${idx}` }));
      if (removePatches.length) {
        await wit.updateWorkItem({}, removePatches, tcId);
      }
    }
  }

  // Add new relations
  for (const ref of desired) {
    if (!existingIds.has(ref.id)) {
      const cfg = linkConfigs.find((c) => c.prefix === ref.prefix);
      patches.push({
        op: 'add',
        path: '/relations/-',
        value: {
          rel: cfg?.relationship ?? 'System.LinkTypes.Related',
          url: workItemUrl(config.orgUrl, ref.id),
          attributes: { comment: `ado-sync:${ref.prefix}` },
        },
      });
    }
  }

  return patches;
}

// ─── Suite hierarchy helpers ──────────────────────────────────────────────────

async function resolveRootSuiteId(client: AzureClient, config: SyncConfig): Promise<number> {
  if (config.testPlan.suiteId) return config.testPlan.suiteId;
  const api = await client.getTestPlanApi();
  const plan = await api.getTestPlanById(config.project, config.testPlan.id);
  return plan?.rootSuite?.id ?? 0;
}

async function getOrCreateChildSuite(
  client: AzureClient,
  config: SyncConfig,
  parentSuiteId: number,
  suiteName: string
): Promise<number> {
  const api = await client.getTestPlanApi();
  const suites = await api.getTestSuitesForPlan(config.project, config.testPlan.id);
  const existing = (suites ?? []).find(
    (s: any) => s.parentSuite?.id === parentSuiteId && s.name === suiteName
  );
  if (existing?.id) return existing.id as number;

  const created = await api.createTestSuite(
    {
      suiteType: 'StaticTestSuite' as any,
      name: suiteName,
      parentSuite: { id: parentSuiteId },
    } as any,
    config.project,
    config.testPlan.id
  );
  return (created as any)?.id ?? parentSuiteId;
}

/**
 * Get or create a nested suite matching the folder path of the given file.
 * Uses suiteCache (Map<relPath, suiteId>) to avoid redundant API calls.
 */
export async function getOrCreateSuiteForFile(
  client: AzureClient,
  config: SyncConfig,
  filePath: string,
  configDir: string,
  suiteCache: Map<string, number>
): Promise<number> {
  const rootSuiteId = await resolveRootSuiteId(client, config);

  const relFile = path.relative(configDir, filePath);
  const segments = relFile.split(path.sep).slice(0, -1);
  const cleanSegments = segments.map((s) => s.replace(/^@/, '')).filter(Boolean);

  if (!cleanSegments.length) return rootSuiteId;

  let parentId = rootSuiteId;
  let cacheKey = '';
  for (const seg of cleanSegments) {
    cacheKey = cacheKey ? `${cacheKey}/${seg}` : seg;
    if (suiteCache.has(cacheKey)) {
      parentId = suiteCache.get(cacheKey)!;
    } else {
      parentId = await getOrCreateChildSuite(client, config, parentId, seg);
      suiteCache.set(cacheKey, parentId);
    }
  }
  return parentId;
}

// ─── API layer ───────────────────────────────────────────────────────────────

export async function getTestCase(
  client: AzureClient,
  id: number,
  titleField = 'System.Title'
): Promise<AzureTestCase | null> {
  const wit = await client.getWitApi();
  const fields = [
    titleField,
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
    title: f[titleField] ?? '',
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
  config: SyncConfig,
  suiteIdOverride?: number
): Promise<number> {
  const wit = await client.getWitApi();
  const syncCfg = config.sync ?? {};
  const titleField = syncCfg.titleField ?? 'System.Title';

  const steps: AzureStep[] = test.steps.map((s) => ({
    action: `${s.keyword} ${s.text}`.trim(),
    expected: s.expected ?? '',
  }));

  const patchDoc: any[] = [
    { op: 'add', path: `/fields/${titleField}`, value: test.title },
    { op: 'add', path: '/fields/Microsoft.VSTS.TCM.Steps', value: buildStepsXml(steps) },
  ];

  if (test.description) {
    patchDoc.push({ op: 'add', path: '/fields/System.Description', value: test.description });
  }

  if (test.outlineParameters) {
    const paramXml = buildParameterDataXml(
      test.outlineParameters.headers,
      test.outlineParameters.rows
    );
    if (paramXml) {
      patchDoc.push({ op: 'add', path: '/fields/Microsoft.VSTS.TCM.LocalDataSource', value: paramXml });
    }
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

  const relationPatches = await applyLinkRelations(client, 0, test, config, true);
  patchDoc.push(...relationPatches);

  const wi = await wit.createWorkItem({}, patchDoc, config.project, 'Test Case');
  if (!wi?.id) throw new Error(`Failed to create test case for: ${test.title}`);

  const resolvedSuiteId = suiteIdOverride ?? config.testPlan.suiteId;
  if (resolvedSuiteId) {
    await addTestCaseToSuite(client, config, wi.id, resolvedSuiteId);
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
  const syncCfg = config.sync ?? {};
  const titleField = syncCfg.titleField ?? 'System.Title';

  const steps: AzureStep[] = test.steps.map((s) => ({
    action: `${s.keyword} ${s.text}`.trim(),
    expected: s.expected ?? '',
  }));

  const filteredTags = test.tags
    .filter((t) => !t.startsWith(syncCfg.tagPrefix + ':'))
    .join('; ');

  const patchDoc: any[] = [
    { op: 'replace', path: `/fields/${titleField}`, value: test.title },
    { op: 'replace', path: '/fields/Microsoft.VSTS.TCM.Steps', value: buildStepsXml(steps) },
    { op: 'replace', path: '/fields/System.Tags', value: filteredTags },
  ];

  if (test.description !== undefined) {
    patchDoc.push({ op: 'replace', path: '/fields/System.Description', value: test.description });
  }

  if (test.outlineParameters) {
    const paramXml = buildParameterDataXml(
      test.outlineParameters.headers,
      test.outlineParameters.rows
    );
    if (paramXml) {
      patchDoc.push({ op: 'replace', path: '/fields/Microsoft.VSTS.TCM.LocalDataSource', value: paramXml });
    }
  }

  // Relations: remove stale first (inside applyLinkRelations), then add patches
  const relationPatches = await applyLinkRelations(client, id, test, config, false);
  patchDoc.push(...relationPatches);

  await wit.updateWorkItem({}, patchDoc, id);
}

export async function updateLocalFromAzure(
  client: AzureClient,
  id: number,
  titleField?: string
): Promise<AzureTestCase | null> {
  return getTestCase(client, id, titleField);
}

/**
 * Tag an orphaned Azure TC with 'ado-sync:removed' so teams can review and
 * manually delete it. Does nothing if the tag is already present.
 */
export async function tagTestCaseAsRemoved(
  client: AzureClient,
  id: number,
  removedTag = 'ado-sync:removed'
): Promise<void> {
  const wit = await client.getWitApi();
  const wi = await wit.getWorkItem(id, ['System.Tags']);
  const existing = (wi?.fields?.['System.Tags'] as string | undefined) ?? '';
  const currentTags = tagsFromString(existing);
  if (currentTags.includes(removedTag)) return;
  const newTags = [...currentTags, removedTag].join('; ');
  await wit.updateWorkItem({}, [
    { op: 'replace', path: '/fields/System.Tags', value: newTags },
  ], id);
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
  const titleField = config.sync?.titleField ?? 'System.Title';

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
    titleField,
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
      title: f[titleField] ?? '',
      description: f['System.Description'] ?? '',
      steps: parseStepsXml(f['Microsoft.VSTS.TCM.Steps'] ?? ''),
      tags: tagsFromString(f['System.Tags']),
      changedDate: f['System.ChangedDate'],
      areaPath: f['System.AreaPath'],
      iterationPath: f['System.IterationPath'],
    };
  });
}
