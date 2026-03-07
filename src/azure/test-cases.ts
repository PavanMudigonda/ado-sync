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
import * as fs from 'fs';
import { glob } from 'glob';
import * as path from 'path';

import {
  AzureStep,
  AzureTestCase,
  CustomizationsConfig,
  FieldUpdates,
  FieldUpdateValue,
  FormatConfig,
  LinkConfig,
  ParsedTest,
  StateConfig,
  SuiteCondition,
  SyncConfig,
} from '../types';
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
  // For C# tests, automatedTestName is the FQMN (Namespace.Class.Method) provided by the parser.
  // For other types it falls back to the file-basename.scenario-title convention.
  const automatedTestName = test.automatedTestName ?? `${fileBase}.${scenarioName}`;
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

// ─── Tag transformation helpers ──────────────────────────────────────────────

/**
 * Apply tag text map transformation (character/substring replacements).
 * e.g. textMap { "_": " " } transforms "my_tag" → "my tag"
 */
function applyTagTextMap(tags: string[], textMap: Record<string, string>): string[] {
  return tags.map((t) => {
    let result = t;
    for (const [from, to] of Object.entries(textMap)) {
      result = result.split(from).join(to);
    }
    return result;
  });
}

/**
 * Filter tags that should be ignored from removal during push.
 * Patterns support trailing wildcard (e.g. "ado-tag*").
 */
function isIgnoredTag(tag: string, ignorePatterns: string[]): boolean {
  for (const pattern of ignorePatterns) {
    if (pattern.endsWith('*')) {
      if (tag.startsWith(pattern.slice(0, -1))) return true;
    } else if (tag === pattern) {
      return true;
    }
  }
  return false;
}

/**
 * Process tags for push: apply tag mapping and filter ignored tags.
 * Returns the transformed tags list ready for Azure DevOps.
 */
export function processTagsForPush(
  tags: string[],
  tagPrefix: string,
  customizations?: CustomizationsConfig
): string[] {
  let processed = tags.filter((t) => !t.startsWith(tagPrefix + ':'));

  // Apply tag text map transformation
  if (customizations?.tagTextMapTransformation?.enabled && customizations.tagTextMapTransformation.textMap) {
    processed = applyTagTextMap(processed, customizations.tagTextMapTransformation.textMap);
  }

  return processed;
}

// ─── State change helpers ────────────────────────────────────────────────────

/**
 * Build the PATCH operation to set the TC state when the scenario has changed.
 * Only applies when state.setValueOnChangeTo is configured.
 * Respects an optional state.condition tag expression.
 */
function buildStateChangePatches(
  test: ParsedTest,
  stateConfig: StateConfig | undefined,
  op: 'add' | 'replace'
): any[] {
  if (!stateConfig?.setValueOnChangeTo) return [];

  // Check condition: if specified, only apply state change when tags match
  if (stateConfig.condition) {
    const tagsWithAt = test.tags.map((t) => (t.startsWith('@') ? t : `@${t}`));
    const node = parseTagExpression(stateConfig.condition);
    if (!node.evaluate(tagsWithAt)) return [];
  }

  return [
    { op, path: '/fields/System.State', value: stateConfig.setValueOnChangeTo },
  ];
}

// ─── Field update helpers ────────────────────────────────────────────────────

/**
 * Expand placeholders in a field update value string.
 * Supported placeholders:
 *   {scenario-name} → test title
 *   {feature-name}  → file basename without extension
 *   {feature-file}  → file basename
 *   {scenario-description} → test description
 *   {1}, {2}, etc. → wildcard captures from condition
 */
function expandFieldPlaceholders(
  value: string,
  test: ParsedTest,
  wildcardCaptures: string[] = []
): string {
  let result = value;
  result = result.replace(/\{scenario-name\}/g, test.title);
  result = result.replace(/\{feature-name\}/g, path.basename(test.filePath, path.extname(test.filePath)));
  result = result.replace(/\{feature-file\}/g, path.basename(test.filePath));
  result = result.replace(/\{scenario-description\}/g, test.description ?? '');

  // Replace numbered captures {1}, {2}, ...
  for (let i = 0; i < wildcardCaptures.length; i++) {
    result = result.replace(new RegExp(`\\{${i + 1}\\}`, 'g'), wildcardCaptures[i]);
  }

  return result;
}

/**
 * Evaluate a tag condition with wildcard support.
 * e.g. condition "@priority:*" with tags ["priority:high"] → captures: ["high"]
 * Returns null if no match, or the array of wildcard captures if matched.
 */
function evaluateWildcardCondition(
  condition: string,
  tags: string[]
): string[] | null {
  const tagsWithAt = tags.map((t) => (t.startsWith('@') ? t : `@${t}`));

  // Check for wildcard patterns in the condition
  if (!condition.includes('*')) {
    // Simple tag expression evaluation
    const node = parseTagExpression(condition);
    return node.evaluate(tagsWithAt) ? [] : null;
  }

  // Extract wildcard tag patterns from condition
  const tagPatterns = condition.match(/@[\w-]+(?::[\w-]*\*[\w-]*)+|@[\w-]*\*[\w-]*/g) ?? [];
  const captures: string[] = [];

  for (const pattern of tagPatterns) {
    const cleanPattern = pattern.startsWith('@') ? pattern.slice(1) : pattern;
    // Convert wildcard pattern to regex: @priority:* → priority:(.+)
    const regexStr = '^' + cleanPattern.replace(/\*/g, '(.+)') + '$';
    const regex = new RegExp(regexStr);

    let matched = false;
    for (const tag of tags) {
      const m = tag.match(regex);
      if (m) {
        captures.push(...m.slice(1));
        matched = true;
        break;
      }
    }
    if (!matched) return null;
  }

  // Also evaluate the non-wildcard part of the expression
  // Replace wildcard tags with a dummy tag name for expression evaluation
  let evalExpr = condition;
  for (const pattern of tagPatterns) {
    evalExpr = evalExpr.replace(pattern, '@__wildcard_matched__');
  }
  // Add the dummy tag so it evaluates the rest of the expression correctly
  const evalTags = [...tagsWithAt, '@__wildcard_matched__'];
  try {
    const node = parseTagExpression(evalExpr);
    if (!node.evaluate(evalTags)) return null;
  } catch {
    // If the expression can't be parsed after replacement, trust the wildcard match
  }

  return captures;
}

/**
 * Build PATCH operations for field updates.
 * Handles simple values, conditional values, wildcard tag matches, and update events.
 */
function buildFieldUpdatePatches(
  test: ParsedTest,
  fieldUpdates: FieldUpdates | undefined,
  isCreate: boolean,
  op: 'add' | 'replace'
): any[] {
  if (!fieldUpdates) return [];

  const patches: any[] = [];

  for (const [field, spec] of Object.entries(fieldUpdates)) {
    // Normalize field reference: if it doesn't contain a dot, assume it's a display name
    const fieldPath = field.includes('.') ? field : field;

    if (typeof spec === 'string') {
      // Simple value — always update
      const value = expandFieldPlaceholders(spec, test);
      patches.push({ op, path: `/fields/${fieldPath}`, value });
      continue;
    }

    const update = spec as FieldUpdateValue;

    // Check update event
    if (update.update === 'onCreate' && !isCreate) continue;
    if (update.update === 'onChange' && isCreate) continue;

    // Handle conditionalValue (switch-style)
    if (update.conditionalValue) {
      let resolved = false;
      for (const [condExpr, condValue] of Object.entries(update.conditionalValue)) {
        if (condExpr === 'otherwise') continue;

        const captures = evaluateWildcardCondition(condExpr, test.tags);
        if (captures !== null) {
          const value = expandFieldPlaceholders(condValue, test, captures);
          patches.push({ op, path: `/fields/${fieldPath}`, value });
          resolved = true;
          break;
        }
      }
      if (!resolved && update.conditionalValue['otherwise'] !== undefined) {
        const value = expandFieldPlaceholders(update.conditionalValue['otherwise'], test);
        patches.push({ op, path: `/fields/${fieldPath}`, value });
      }
      continue;
    }

    // Handle single value with optional condition
    if (update.condition) {
      const captures = evaluateWildcardCondition(update.condition, test.tags);
      if (captures === null) continue;
      if (update.value !== undefined) {
        const value = expandFieldPlaceholders(update.value, test, captures);
        patches.push({ op, path: `/fields/${fieldPath}`, value });
      }
    } else if (update.value !== undefined) {
      const value = expandFieldPlaceholders(update.value, test);
      patches.push({ op, path: `/fields/${fieldPath}`, value });
    }
  }

  return patches;
}

/**
 * Build PATCH operations for field defaults (applied on create only).
 */
function buildFieldDefaultPatches(
  customizations: CustomizationsConfig | undefined
): any[] {
  if (!customizations?.fieldDefaults?.enabled) return [];
  const patches: any[] = [];
  for (const [field, value] of Object.entries(customizations.fieldDefaults.defaultValues)) {
    patches.push({ op: 'add', path: `/fields/${field}`, value });
  }
  return patches;
}

// ─── Format helpers ──────────────────────────────────────────────────────────

/**
 * Apply format configuration to step conversion.
 * Handles useExpectedResult, prefixBackgroundSteps, syncDataTableAsText, emptyActionValue, etc.
 */
function applyFormatToSteps(
  steps: { keyword: string; text: string; expected?: string; isBackground?: boolean; dataTable?: string[][] }[],
  formatConfig: FormatConfig | undefined
): AzureStep[] {
  const useExpected = formatConfig?.useExpectedResult ?? false;
  const emptyAction = formatConfig?.emptyActionValue;
  const emptyExpected = formatConfig?.emptyExpectedResultValue;
  const prefixBg = formatConfig?.prefixBackgroundSteps ?? true;
  const dataTableAsText = formatConfig?.syncDataTableAsText ?? false;

  return steps
    .filter((s) => {
      // When prefixBackgroundSteps is false, exclude background steps entirely
      if (s.isBackground && !prefixBg) return false;
      return true;
    })
    .map((s) => {
      const bgPrefix = s.isBackground ? 'Background: ' : '';
      const rawAction = `${bgPrefix}${s.keyword} ${s.text}`.trim();
      let action = rawAction || emptyAction || '';
      let expected = s.expected ?? '';

      // When useExpectedResult is true, Then/Verify steps go to expected column
      // (background steps are not subject to this transformation)
      if (useExpected && !s.isBackground && (s.keyword === 'Then' || s.keyword === 'Verify')) {
        expected = s.text;
        action = emptyAction || '';
      }

      if (!expected && emptyExpected) {
        expected = emptyExpected;
      }

      // Append data table rows as plain text when syncDataTableAsText is enabled
      if (dataTableAsText && s.dataTable?.length) {
        const tableText = s.dataTable.map((row) => `| ${row.join(' | ')} |`).join('\n');
        action = action ? `${action}\n${tableText}` : tableText;
      }

      return { action, expected };
    });
}

/**
 * Optionally append a "Parameters: @p1@, @p2@, ..." step for parametrized TCs.
 * The step is appended in-place to the steps array.
 *
 * - 'always'               → always append
 * - 'never'                → never append
 * - 'whenUnusedParameters' → append only when at least one header has no @param@ reference in any step (default)
 */
function applyShowParameterListStep(
  steps: AzureStep[],
  outlineParameters: { headers: string[]; rows: string[][] } | undefined,
  formatConfig: FormatConfig | undefined
): void {
  if (!outlineParameters?.headers.length) return;

  const mode = formatConfig?.showParameterListStep ?? 'whenUnusedParameters';
  if (mode === 'never') return;

  const { headers } = outlineParameters;
  const shouldAppend =
    mode === 'always' ||
    headers.some((h) => !steps.some((s) => s.action.includes(`@${h}@`)));

  if (shouldAppend) {
    const paramsList = headers.map((h) => `@${h}@`).join(', ');
    steps.push({ action: `Parameters: ${paramsList}`, expected: '' });
  }
}

/**
 * Apply prefixTitle format config to the test case title.
 */
function formatTitle(title: string, test: ParsedTest, formatConfig: FormatConfig | undefined): string {
  if (formatConfig?.prefixTitle === false) return title;
  // Don't double-prefix if title already has the prefix
  if (/^Scenario(?:\s+Outline)?:\s+/i.test(title)) return title;
  const isOutline = !!test.outlineParameters?.headers.length;
  const prefix = isOutline ? 'Scenario Outline: ' : 'Scenario: ';
  return prefix + title;
}

// ─── Attachment helpers ──────────────────────────────────────────────────────

/**
 * Upload file attachments to a test case work item.
 * Resolves file paths relative to the feature file or the configured baseFolder.
 */
async function syncAttachments(
  client: AzureClient,
  tcId: number,
  test: ParsedTest,
  config: SyncConfig,
  configDir: string
): Promise<void> {
  const attachConfig = config.sync?.attachments;
  if (!attachConfig?.enabled) return;
  if (!test.attachmentRefs?.length) return;

  const wit = await client.getWitApi();
  const baseFolder = attachConfig.baseFolder
    ? path.resolve(configDir, attachConfig.baseFolder)
    : path.dirname(test.filePath);

  // Fetch existing attachments on the TC
  let existingAttachments: Array<{ name: string; url: string }> = [];
  try {
    const wi = await (wit as any).getWorkItem(tcId, undefined, undefined, 4 /* WorkItemExpand.Relations */);
    if (wi?.relations) {
      existingAttachments = (wi.relations as any[])
        .filter((r: any) => r.rel === 'AttachedFile')
        .map((r: any) => ({
          name: r.attributes?.name ?? '',
          url: r.url ?? '',
        }));
    }
  } catch { /* continue without existing attachment info */ }

  const existingNames = new Set(existingAttachments.map((a) => a.name));

  for (const ref of test.attachmentRefs) {
    // Resolve glob patterns for file paths
    const resolvedPaths = await glob(ref.filePath, {
      cwd: baseFolder,
      absolute: true,
    });

    for (const filePath of resolvedPaths) {
      const fileName = path.basename(filePath);
      if (existingNames.has(fileName)) continue; // Already attached

      if (!fs.existsSync(filePath)) {
        console.warn(`  [warn] Attachment file not found: ${filePath}`);
        continue;
      }

      const content = fs.readFileSync(filePath);
      const stream = Buffer.from(content);

      try {
        const attachment = await wit.createAttachment({} as any, stream as any, fileName);
        if (attachment?.url) {
          await wit.updateWorkItem(
            {},
            [{
              op: 'add',
              path: '/relations/-',
              value: {
                rel: 'AttachedFile',
                url: attachment.url,
                attributes: { comment: `ado-sync:${ref.prefix}:${ref.filePath}` },
              },
            }],
            tcId
          );
        }
      } catch (err: any) {
        console.warn(`  [warn] Failed to attach ${fileName} to TC #${tcId}: ${err.message}`);
      }
    }
  }
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
  suiteIdOverride?: number,
  configDir?: string
): Promise<number> {
  const wit = await client.getWitApi();
  const syncCfg = config.sync ?? {};
  const titleField = syncCfg.titleField ?? 'System.Title';
  const formatConfig = syncCfg.format;

  const isParametrized = !!test.outlineParameters?.headers.length;
  const steps: AzureStep[] = applyFormatToSteps(test.steps, formatConfig).map((s) => ({
    action: isParametrized ? gherkinParamsToAzure(s.action) : s.action,
    expected: s.expected,
  }));
  applyShowParameterListStep(steps, test.outlineParameters, formatConfig);

  // Apply format prefixTitle
  const title = formatTitle(test.title, test, formatConfig);

  const patchDoc: any[] = [
    { op: 'add', path: `/fields/${titleField}`, value: title },
    { op: 'add', path: '/fields/Microsoft.VSTS.TCM.Steps', value: buildStepsXml(steps) },
  ];

  if (test.description) {
    patchDoc.push({ op: 'add', path: '/fields/System.Description', value: test.description });
  }

  patchDoc.push(...buildAutomationPatches(test, config, 'add'));

  // State change on create
  patchDoc.push(...buildStateChangePatches(test, syncCfg.state, 'add'));

  // Field defaults (customizations) — only on create
  patchDoc.push(...buildFieldDefaultPatches(config.customizations));

  // Field updates
  patchDoc.push(...buildFieldUpdatePatches(test, syncCfg.fieldUpdates, true, 'add'));

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

  // Process tags: apply tag text map transformation
  const processedTags = processTagsForPush(test.tags, syncCfg.tagPrefix ?? 'tc', config.customizations);
  const filteredTags = processedTags.join('; ');
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

  // Sync attachments
  if (configDir) {
    await syncAttachments(client, wi.id, test, config, configDir);
  }

  return wi.id;
}

export async function updateTestCase(
  client: AzureClient,
  id: number,
  test: ParsedTest,
  config: SyncConfig,
  configDir?: string
): Promise<void> {
  const wit = await client.getWitApi();
  const syncCfg = config.sync ?? {};
  const titleField = syncCfg.titleField ?? 'System.Title';
  const formatConfig = syncCfg.format;

  const isParametrized = !!test.outlineParameters?.headers.length;
  const steps: AzureStep[] = applyFormatToSteps(test.steps, formatConfig).map((s) => ({
    action: isParametrized ? gherkinParamsToAzure(s.action) : s.action,
    expected: s.expected,
  }));
  applyShowParameterListStep(steps, test.outlineParameters, formatConfig);

  // Apply format prefixTitle
  const title = formatTitle(test.title, test, formatConfig);

  // Process tags with transformations
  const processedLocalTags = processTagsForPush(test.tags, syncCfg.tagPrefix ?? 'tc', config.customizations);

  // Fetch existing Azure tags and merge
  const wi = await wit.getWorkItem(id, ['System.Tags']);
  const existingAzureTags = tagsFromString((wi?.fields?.['System.Tags'] as string | undefined) ?? '');

  // Filter ignored tags from removal — they should be preserved in Azure
  const ignorePatterns = config.customizations?.ignoreTestCaseTags?.enabled
    ? config.customizations.ignoreTestCaseTags.tags
    : [];
  const mergedTags = [...new Set([
    ...existingAzureTags.filter((t) => isIgnoredTag(t, ignorePatterns)),
    ...processedLocalTags,
  ])];
  const mergedTagsValue = mergedTags.join('; ');

  const patchDoc: any[] = [
    { op: 'replace', path: `/fields/${titleField}`, value: title },
    { op: 'replace', path: '/fields/Microsoft.VSTS.TCM.Steps', value: buildStepsXml(steps) },
    { op: 'replace', path: '/fields/System.Tags', value: mergedTagsValue },
  ];

  if (test.description !== undefined) {
    patchDoc.push({ op: 'replace', path: '/fields/System.Description', value: test.description });
  }

  patchDoc.push(...buildAutomationPatches(test, config, 'replace'));

  // State change on update
  patchDoc.push(...buildStateChangePatches(test, syncCfg.state, 'replace'));

  // Field updates
  patchDoc.push(...buildFieldUpdatePatches(test, syncCfg.fieldUpdates, false, 'replace'));

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

  // Sync attachments
  if (configDir) {
    await syncAttachments(client, id, test, config, configDir);
  }
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

export async function addTestCaseToSuite(
  client: AzureClient,
  config: SyncConfig,
  testCaseId: number,
  suiteId: number
): Promise<void> {
  const api = await client.getTestPlanApi();
  try {
    await api.addTestCasesToSuite(
      [{ workItem: { id: testCaseId } } as any],
      config.project,
      config.testPlan.id,
      suiteId
    );
  } catch (err: any) {
    // Azure returns an error when the TC is already in the suite — safe to ignore.
    if (/duplicate/i.test(err?.message ?? '')) return;
    throw err;
  }
}

export async function addTestCaseToRootSuite(
  client: AzureClient,
  config: SyncConfig,
  testCaseId: number
): Promise<void> {
  const api = await client.getTestPlanApi();
  const plan = await api.getTestPlanById(config.project, config.testPlan.id);
  const rootSuiteId = plan?.rootSuite?.id;
  if (!rootSuiteId) return;

  try {
    await api.addTestCasesToSuite(
      [{ workItem: { id: testCaseId } } as any],
      config.project,
      config.testPlan.id,
      rootSuiteId
    );
  } catch (err: any) {
    if (/duplicate/i.test(err?.message ?? '')) return;
    throw err;
  }
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
