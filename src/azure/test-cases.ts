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

import parseTagExpression from '@cucumber/tag-expressions';
import * as crypto from 'crypto';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import * as path from 'path';

import { AzureStep, AzureTestCase, LinkConfig, ParsedTest, SuiteCondition, SyncConfig } from '../types';
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
  return `<DIV><P>${escapeHtml(text)}</P></DIV>`;
}

function buildStepsXml(steps: AzureStep[]): string {
  if (steps.length === 0) return '<steps id="0" last="1"/>';

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    suppressBooleanAttributes: false, // keep ="true" on isformatted attribute
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
 *
 * Azure DevOps Test Plans requires the full ADO.NET DataSet XML format —
 * i.e. an embedded xs:schema section followed by the data rows. Without
 * the schema, the parameter grid shows column names but leaves values empty.
 */
function buildParameterDataXml(headers: string[], rows: string[][]): string {
  if (!headers.length || !rows.length) return '';

  const safeNames = headers.map(escapeXmlName);

  // Column schema elements
  const colElements = safeNames
    .map((n) => `<xs:element name="${n}" type="xs:string" minOccurs="0" />`)
    .join('');

  // Full ADO.NET DataSet schema.  xmlns="" on xs:schema is required — it resets
  // the default namespace so Azure's DataSet parser can match the column element
  // names in the schema to those in the data rows.
  const schema =
    `<xs:schema id="NewDataSet" xmlns="" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:msdata="urn:schemas-microsoft-com:xml-msdata">` +
    `<xs:element name="NewDataSet" msdata:IsDataSet="true" msdata:UseCurrentLocale="true">` +
    `<xs:complexType><xs:choice minOccurs="0" maxOccurs="unbounded">` +
    `<xs:element name="Table1"><xs:complexType><xs:sequence>` +
    colElements +
    `</xs:sequence></xs:complexType></xs:element>` +
    `</xs:choice></xs:complexType></xs:element></xs:schema>`;

  // Data rows — one <Table1> per example row, compact (no whitespace nodes)
  const dataRows = rows
    .map((row) => {
      const cells = safeNames
        .map((n, i) => `<${n}>${escapeHtml(row[i] ?? '')}</${n}>`)
        .join('');
      return `<Table1>${cells}</Table1>`;
    })
    .join('');

  return `<NewDataSet>${schema}${dataRows}</NewDataSet>`;
}

/**
 * Build the parameter names XML for Microsoft.VSTS.TCM.Parameters.
 * Azure DevOps requires this field in addition to LocalDataSource so it knows
 * which parameter names exist in the test case.
 */
function buildParameterNamesXml(headers: string[]): string {
  if (!headers.length) return '';
  const params = headers
    .map((h) => `<param name="${escapeXmlName(h)}" bind="default" />`)
    .join('');
  return `<parameters>${params}</parameters>`;
}

/**
 * Convert Gherkin angle-bracket parameter syntax to Azure's @param@ syntax.
 * e.g.  "I enter username \"<username>\""  →  "I enter username \"@username@\""
 */
function gherkinParamsToAzure(text: string): string {
  return text.replace(/<([^>]+)>/g, '@$1@');
}

/** Make a column name safe for XML element names (spaces → underscores). */
function escapeXmlName(name: string): string {
  return name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-.]/g, '');
}

// ─── Automation helpers ───────────────────────────────────────────────────────

/**
 * Produce a deterministic UUID (v4 shape, SHA-256 seeded) from a string.
 * Using a deterministic ID means re-running push never creates duplicate
 * automation associations in Azure DevOps.
 */
function deterministicGuid(seed: string): string {
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}

function sanitizeTestName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Build the set of PATCH operations that mark a test case as Automated.
 * Only included when sync.markAutomated is true.
 */
function buildAutomationPatches(test: ParsedTest, config: SyncConfig, op: 'add' | 'replace'): any[] {
  if (!config.sync?.markAutomated) return [];

  const ext = path.extname(test.filePath);
  const fileBase = sanitizeTestName(path.basename(test.filePath, ext));
  const scenarioName = sanitizeTestName(test.title);
  const automatedTestName = `${fileBase}.${scenarioName}`;
  const automatedTestStorage = path.basename(test.filePath);
  const automatedTestId = deterministicGuid(`${test.filePath}::${test.title}`);

  return [
    { op, path: '/fields/Microsoft.VSTS.TCM.AutomationStatus',    value: 'Automated' },
    { op, path: '/fields/Microsoft.VSTS.TCM.AutomatedTestName',   value: automatedTestName },
    { op, path: '/fields/Microsoft.VSTS.TCM.AutomatedTestStorage', value: automatedTestStorage },
    { op, path: '/fields/Microsoft.VSTS.TCM.AutomatedTestId',     value: automatedTestId },
    { op, path: '/fields/Microsoft.VSTS.TCM.AutomatedTestType',   value: 'Unit Test' },
  ];
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

  const isParametrized = !!test.outlineParameters?.headers.length;
  const steps: AzureStep[] = test.steps.map((s) => {
    const rawAction = `${s.keyword} ${s.text}`.trim();
    return {
      action: isParametrized ? gherkinParamsToAzure(rawAction) : rawAction,
      expected: s.expected ?? '',
    };
  });

  const patchDoc: any[] = [
    { op: 'add', path: `/fields/${titleField}`, value: test.title },
    { op: 'add', path: '/fields/Microsoft.VSTS.TCM.Steps', value: buildStepsXml(steps) },
  ];

  if (test.description) {
    patchDoc.push({ op: 'add', path: '/fields/System.Description', value: test.description });
  }

  patchDoc.push(...buildAutomationPatches(test, config, 'add'));

  if (test.outlineParameters) {
    const { headers, rows } = test.outlineParameters;
    const namesXml = buildParameterNamesXml(headers);
    if (namesXml) {
      patchDoc.push({ op: 'add', path: '/fields/Microsoft.VSTS.TCM.Parameters', value: namesXml });
    }
    const dataXml = buildParameterDataXml(headers, rows);
    if (dataXml) {
      patchDoc.push({ op: 'add', path: '/fields/Microsoft.VSTS.TCM.LocalDataSource', value: dataXml });
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

  const isParametrized = !!test.outlineParameters?.headers.length;
  const steps: AzureStep[] = test.steps.map((s) => {
    const rawAction = `${s.keyword} ${s.text}`.trim();
    return {
      action: isParametrized ? gherkinParamsToAzure(rawAction) : rawAction,
      expected: s.expected ?? '',
    };
  });

  const localTags = test.tags.filter((t) => !t.startsWith(syncCfg.tagPrefix + ':'));

  // Fetch existing Azure tags and merge: preserve any Azure-only tags, add new local tags
  const wi = await wit.getWorkItem(id, ['System.Tags']);
  const existingAzureTags = tagsFromString((wi?.fields?.['System.Tags'] as string | undefined) ?? '');
  const mergedTags = [...new Set([...existingAzureTags, ...localTags])];
  const mergedTagsValue = mergedTags.join('; ');

  const patchDoc: any[] = [
    { op: 'replace', path: `/fields/${titleField}`, value: test.title },
    { op: 'replace', path: '/fields/Microsoft.VSTS.TCM.Steps', value: buildStepsXml(steps) },
    { op: 'replace', path: '/fields/System.Tags', value: mergedTagsValue },
  ];

  if (test.description !== undefined) {
    patchDoc.push({ op: 'replace', path: '/fields/System.Description', value: test.description });
  }

  patchDoc.push(...buildAutomationPatches(test, config, 'replace'));

  if (test.outlineParameters) {
    const { headers, rows } = test.outlineParameters;
    const namesXml = buildParameterNamesXml(headers);
    if (namesXml) {
      patchDoc.push({ op: 'replace', path: '/fields/Microsoft.VSTS.TCM.Parameters', value: namesXml });
    }
    const dataXml = buildParameterDataXml(headers, rows);
    if (dataXml) {
      patchDoc.push({ op: 'replace', path: '/fields/Microsoft.VSTS.TCM.LocalDataSource', value: dataXml });
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

/**
 * Add a test case to every suite whose condition matches the given test.
 * Suites are created under the plan root if they don't already exist.
 * Uses conditionSuiteCache to avoid redundant API calls across TCs.
 * Adding a TC that is already in a suite is a no-op on the Azure side.
 */
export async function addTestCaseToConditionSuites(
  client: AzureClient,
  config: SyncConfig,
  testCaseId: number,
  test: ParsedTest,
  conditionSuiteCache: Map<string, number>
): Promise<void> {
  const conditions: SuiteCondition[] = config.sync?.suiteConditions ?? [];
  if (!conditions.length) return;

  const tagsWithAt = test.tags.map((t) => (t.startsWith('@') ? t : `@${t}`));

  for (const condition of conditions) {
    // Tag filter — skip if expression doesn't match
    if (condition.tags) {
      const node = parseTagExpression(condition.tags);
      if (!node.evaluate(tagsWithAt)) continue;
    }

    // Resolve or create the named suite (cached per suite name)
    const cacheKey = `condition:${config.testPlan.id}:${condition.suite}`;
    let suiteId: number;
    if (conditionSuiteCache.has(cacheKey)) {
      suiteId = conditionSuiteCache.get(cacheKey)!;
    } else {
      const rootSuiteId = await resolveRootSuiteId(client, config);
      suiteId = await getOrCreateChildSuite(client, config, rootSuiteId, condition.suite);
      conditionSuiteCache.set(cacheKey, suiteId);
    }

    await addTestCaseToSuite(client, config, testCaseId, suiteId);
  }
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
