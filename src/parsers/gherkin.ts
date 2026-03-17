/**
 * Gherkin / Cucumber .feature file parser.
 *
 * Uses the modern @cucumber/gherkin generateMessages() API (same approach as
 * playwright-bdd). This produces both the GherkinDocument (AST) and Pickles
 * (compiled, example-substituted scenarios) in a single pass.
 *
 * For regular Scenarios:   uses Pickles (background-merged, already correct).
 * For Scenario Outlines:   uses the AST directly to produce ONE ParsedTest
 *                          with template steps and an outlineParameters table,
 *                          so Azure gets a single parametrized TC instead of
 *                          one TC per example row.
 *
 * ID tag convention:  @tc:12345  (prefix configurable via sync.tagPrefix)
 *
 * Path-based auto-tagging:
 *   Directory segments prefixed with @ are added as tags automatically.
 *   e.g.  specs/@smoke/@regression/login.feature  →  tags: ['smoke', 'regression']
 *
 * Description:
 *   Every ParsedTest gets a `description` field rendered as syntax-coloured HTML
 *   for the Azure Test Case Summary tab. Colours mirror the VS Code Gherkin theme:
 *     • Feature / Scenario / Background / Examples keywords — blue
 *     • Given / When / Then / And / But step keywords       — green
 *     • Tags (@smoke, @regression, …)                      — purple
 *     • Feature description text                            — grey
 */

import { generateMessages } from '@cucumber/gherkin';
import {
  GherkinDocument,
  IdGenerator,
  Pickle,
  PickleStep,
  Scenario,
  SourceMediaType,
  Step,
  TableRow,
} from '@cucumber/messages';
import * as fs from 'fs';

import { LinkConfig, ParsedStep, ParsedTest } from '../types';
import { extractAttachmentRefs, extractLinkRefs, extractPathTags, getAttachmentPrefixes } from './shared';

// Re-export for backward-compatibility
export { extractPathTags };

// ─── Step type → keyword mapping ─────────────────────────────────────────────

const STEP_TYPE_KEYWORD: Record<string, string> = {
  Context: 'Given',
  Action:  'When',
  Outcome: 'Then',
  Unknown: 'Step',
};

// ─── Syntax-coloured description builder ─────────────────────────────────────

// Colour palette (works on white Azure DevOps background)
const C_KEYWORD = '#0070C1'; // blue   — Feature / Scenario / Background / Examples
const C_TAG     = '#6F42C1'; // purple — @tags
const C_GREY    = '#6A737D'; // grey   — feature description, table borders

// Per-keyword step colours
const STEP_KW_COLOR: Record<string, string> = {
  Given:  '#0078D4', // blue
  When:   '#E8830A', // orange
  Then:   '#22863A', // green
  And:    '#9B59B6', // violet
  But:    '#D73A49', // red
  '*':    '#6A737D', // grey
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function kw(text: string, color: string): string {
  return `<span style="color:${color};font-weight:bold">${esc(text)}</span>`;
}

function tag(text: string): string {
  return `<span style="color:${C_TAG}">${esc(text)}</span>`;
}

/** Return the display colour for a Gherkin step keyword. */
function stepKwColor(keyword: string): string {
  const bare = keyword.trim();
  return STEP_KW_COLOR[bare] ?? STEP_KW_COLOR['*'];
}

/** Render one AST Step (plus any attached data table or doc string) as HTML lines. */
function stepToHtmlLines(step: Step, indent: string): string[] {
  const lines: string[] = [];
  const stepKeyword = step.keyword.trimEnd(); // e.g. "Given", "When", "And"
  const stepText    = step.text.trim();
  lines.push(`${indent}${kw(stepKeyword, stepKwColor(stepKeyword))} ${esc(stepText)}`);

  if (step.dataTable) {
    for (const row of step.dataTable.rows) {
      const cells = row.cells.map((c) => esc(c.value));
      lines.push(
        `${indent}&nbsp;&nbsp;<span style="color:${C_GREY}">| ${cells.join(' | ')} |</span>`
      );
    }
  }

  if (step.docString) {
    lines.push(`${indent}&nbsp;&nbsp;<span style="color:${C_GREY}">\`\`\`</span>`);
    for (const line of step.docString.content.split('\n')) {
      lines.push(`${indent}&nbsp;&nbsp;${esc(line)}`);
    }
    lines.push(`${indent}&nbsp;&nbsp;<span style="color:${C_GREY}">\`\`\`</span>`);
  }

  return lines;
}

/**
 * Build a syntax-coloured HTML description for the Azure Test Case Summary tab.
 * Includes Feature header, Background steps, Scenario block (with tags), and
 * Examples tables with test data for Scenario Outlines.
 */
function buildGherkinDescription(
  feature: NonNullable<GherkinDocument['feature']>,
  bgSteps: Step[],
  scenario: Scenario,
  tagPrefix: string,
): string {
  const indent = '&nbsp;&nbsp;&nbsp;&nbsp;';
  const parts: string[] = [];

  // ── Feature ──────────────────────────────────────────────────────────────
  parts.push(`${kw('Feature:', C_KEYWORD)} ${esc(feature.name)}`);
  if (feature.description?.trim()) {
    for (const line of feature.description.trim().split('\n')) {
      parts.push(`<span style="color:${C_GREY}">${esc(line.trim())}</span>`);
    }
  }

  // ── Background ───────────────────────────────────────────────────────────
  if (bgSteps.length) {
    parts.push('');
    parts.push(kw('Background:', C_KEYWORD));
    for (const step of bgSteps) parts.push(...stepToHtmlLines(step, indent));
  }

  // ── Scenario tags (exclude the tc: ID tag) ────────────────────────────────
  const scenarioTags = scenario.tags
    .map((t) => stripAt(t.name))
    .filter((t) => !t.startsWith(tagPrefix + ':'));

  parts.push('');
  if (scenarioTags.length) {
    parts.push(scenarioTags.map((t) => tag(`@${t}`)).join(' '));
  }

  const scenarioKeyword = scenario.keyword.trim(); // 'Scenario' or 'Scenario Outline'
  parts.push(`${kw(scenarioKeyword + ':', C_KEYWORD)} ${esc(scenario.name)}`);

  // ── Steps ─────────────────────────────────────────────────────────────────
  for (const step of scenario.steps as Step[]) parts.push(...stepToHtmlLines(step, indent));

  // ── Examples tables (Scenario Outline only) ───────────────────────────────
  for (const ex of scenario.examples ?? []) {
    parts.push('');
    const exTitle = ex.name ? `Examples: ${ex.name}` : 'Examples:';
    parts.push(`&nbsp;&nbsp;${kw(exTitle, C_KEYWORD)}`);
    if (ex.tableHeader) {
      const headers = ex.tableHeader.cells.map((c) => esc(c.value));
      parts.push(
        `&nbsp;&nbsp;<span style="color:${C_GREY}">| ${headers.join(' | ')} |</span>`
      );
    }
    for (const row of (ex.tableBody ?? []) as TableRow[]) {
      const cells = row.cells.map((c) => esc(c.value));
      parts.push(
        `&nbsp;&nbsp;<span style="color:${C_GREY}">| </span>${cells.join(`<span style="color:${C_GREY}"> | </span>`)}<span style="color:${C_GREY}"> |</span>`
      );
    }
  }

  return parts.join('<br>\n');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip leading @ from a Gherkin tag name. */
function stripAt(name: string): string {
  return name.startsWith('@') ? name.slice(1) : name;
}

/** Extract Azure Test Case ID from a list of tag names. e.g. ['tc:123', 'smoke'] → 123 */
export function extractAzureId(tags: string[], tagPrefix: string): number | undefined {
  const prefix = tagPrefix + ':';
  for (const tag of tags) {
    if (tag.startsWith(prefix)) {
      const n = parseInt(tag.slice(prefix.length), 10);
      if (!isNaN(n)) return n;
    }
  }
  return undefined;
}

/**
 * Given a GherkinDocument and a pickle, find the source line of the
 * scenario that produced this pickle (using astNodeIds).
 */
function findScenarioLine(doc: GherkinDocument, pickle: Pickle): number {
  const scenarioId = pickle.astNodeIds[0];
  for (const child of doc.feature?.children ?? []) {
    if (child.scenario?.id === scenarioId) {
      return child.scenario.location?.line ?? 1;
    }
    if (child.rule) {
      for (const ruleChild of child.rule.children ?? []) {
        if (ruleChild.scenario?.id === scenarioId) {
          return ruleChild.scenario.location?.line ?? 1;
        }
      }
    }
  }
  return 1;
}

/** Find the AST Scenario node that produced a given pickle. */
function findScenarioNode(doc: GherkinDocument, pickle: Pickle): Scenario | undefined {
  const scenarioId = pickle.astNodeIds[0];
  for (const child of doc.feature?.children ?? []) {
    if (child.scenario?.id === scenarioId) return child.scenario;
    if (child.rule) {
      for (const rc of child.rule.children ?? []) {
        if (rc.scenario?.id === scenarioId) return rc.scenario;
      }
    }
  }
  return undefined;
}

/** Return the Background step nodes from a GherkinDocument, if any. */
function extractBackgroundSteps(doc: GherkinDocument): Step[] {
  for (const child of doc.feature?.children ?? []) {
    if (child.background) return child.background.steps as Step[];
  }
  return [];
}

function pickleStepToParsedStep(step: PickleStep): ParsedStep {
  return {
    keyword: STEP_TYPE_KEYWORD[step.type ?? 'Unknown'] ?? 'Step',
    text: step.text.trim(),
    dataTable: step.argument?.dataTable
      ? step.argument.dataTable.rows.map((r) => r.cells.map((c) => c.value))
      : undefined,
  };
}

/**
 * Build a ParsedTest from a ScenarioOutline AST node.
 * Produces one TC with template step text (keeping <param> angle brackets)
 * and an outlineParameters table for Azure's parametrized TC format.
 */
function scenarioOutlineToParsedTest(
  scenario: Scenario,
  filePath: string,
  pathTags: string[],
  tagPrefix: string,
  linkConfigs: LinkConfig[] | undefined,
  feature: NonNullable<GherkinDocument['feature']>,
  bgSteps: Step[],
  attachmentPrefixes: string[],
): ParsedTest {
  const scenarioTags = scenario.tags.map((t) => stripAt(t.name));
  const allTags = [...new Set([...pathTags, ...scenarioTags])];

  // Background steps prepended with isBackground marker so format config can control them
  const bgParsedSteps: ParsedStep[] = bgSteps.map((s) => ({
    keyword: (s.keyword ?? '').trim(),
    text: s.text.trim(),
    isBackground: true,
    dataTable: s.dataTable ? s.dataTable.rows.map((r) => r.cells.map((c) => c.value)) : undefined,
  }));

  // Template steps keep <param> angle-bracket syntax as-is
  const scenarioSteps: ParsedStep[] = (scenario.steps as Step[]).map((s) => ({
    keyword: (s.keyword ?? '').trim(),
    text: s.text.trim(),
    dataTable: s.dataTable ? s.dataTable.rows.map((r) => r.cells.map((c) => c.value)) : undefined,
  }));
  const steps: ParsedStep[] = [...bgParsedSteps, ...scenarioSteps];

  // Merge all Examples tables (may be multiple blocks)
  let headers: string[] = [];
  const rows: string[][] = [];

  for (const examples of scenario.examples ?? []) {
    if (!examples.tableHeader) continue;
    const exHeaders = examples.tableHeader.cells.map((c) => c.value);
    if (!headers.length) headers = exHeaders;
    for (const bodyRow of examples.tableBody as TableRow[]) {
      rows.push(bodyRow.cells.map((c) => c.value));
    }
  }

  return {
    filePath,
    title: scenario.name.trim(),
    description: buildGherkinDescription(feature, bgSteps, scenario, tagPrefix),
    steps,
    tags: allTags,
    azureId: extractAzureId(allTags, tagPrefix),
    line: scenario.location?.line ?? 1,
    outlineParameters: headers.length ? { headers, rows } : undefined,
    linkRefs: extractLinkRefs(allTags, linkConfigs),
    attachmentRefs: extractAttachmentRefs(allTags, attachmentPrefixes),
  };
}

// ─── Public parser ────────────────────────────────────────────────────────────

export function parseGherkinFile(
  filePath: string,
  tagPrefix: string,
  linkConfigs?: LinkConfig[],
  attachmentsConfig?: { enabled: boolean; tagPrefixes?: string[] }
): ParsedTest[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const newId = IdGenerator.uuid();

  let messages: ReturnType<typeof generateMessages>;
  try {
    messages = generateMessages(
      source,
      filePath,
      SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN,
      {
        newId,
        includeGherkinDocument: true,
        includePickles: true,
        includeSource: false,
      }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${filePath}: ${msg}`);
  }

  // Surface any parse errors from the envelope stream
  const parseErrors = messages.filter((m) => m.parseError);
  if (parseErrors.length > 0) {
    const msg = parseErrors.map((m) => m.parseError?.message).join('; ');
    throw new Error(`Gherkin parse error in ${filePath}: ${msg}`);
  }

  const docEnvelope = messages.find((m) => m.gherkinDocument);
  if (!docEnvelope?.gherkinDocument?.feature) return [];

  const doc = docEnvelope.gherkinDocument;
  const feature = doc.feature!;
  const pickles: Pickle[] = messages
    .filter((m) => m.pickle)
    .map((m) => m.pickle!);

  // Tags from directory path segments (e.g. specs/@smoke/ → 'smoke')
  const pathTags = extractPathTags(filePath);
  const attachmentPrefixes = getAttachmentPrefixes(attachmentsConfig);

  // Background steps (shared across all scenarios in this file)
  const bgSteps = extractBackgroundSteps(doc);

  const results: ParsedTest[] = [];

  // Collect all Scenario nodes from the AST (including inside Rules)
  const allScenarios: Scenario[] = [];
  for (const child of doc.feature?.children ?? []) {
    if (child.scenario) allScenarios.push(child.scenario);
    if (child.rule) {
      for (const rc of child.rule.children ?? []) {
        if (rc.scenario) allScenarios.push(rc.scenario);
      }
    }
  }

  // Identify outline scenarios (have at least one non-empty examples table)
  const outlineIds = new Set<string>(
    allScenarios
      .filter((s) => s.examples?.some((ex) => (ex.tableBody?.length ?? 0) > 0))
      .map((s) => s.id)
  );

  // For Scenario Outlines: one ParsedTest per outline (not per example row)
  for (const scenario of allScenarios) {
    if (outlineIds.has(scenario.id)) {
      results.push(
        scenarioOutlineToParsedTest(scenario, filePath, pathTags, tagPrefix, linkConfigs, feature, bgSteps, attachmentPrefixes)
      );
    }
  }

  // Build set of all AST node IDs that belong to outlines (scenario + example rows)
  const outlineAstNodeIds = new Set<string>();
  for (const scenario of allScenarios) {
    if (!outlineIds.has(scenario.id)) continue;
    outlineAstNodeIds.add(scenario.id);
    for (const ex of scenario.examples ?? []) {
      for (const row of ex.tableBody ?? []) {
        outlineAstNodeIds.add(row.id);
      }
    }
  }

  // For regular Scenarios: use pickles (background steps merged, correct keywords)
  for (const pickle of pickles) {
    // Skip pickles that originate from an outline
    if (pickle.astNodeIds.some((id) => outlineAstNodeIds.has(id))) continue;

    const pickleTags = pickle.tags.map((t) => stripAt(t.name));
    const allTags = [...new Set([...pathTags, ...pickleTags])];

    // Find the AST scenario node to build the full syntax-coloured description
    const scenarioNode = findScenarioNode(doc, pickle);

    results.push({
      filePath,
      title: pickle.name.trim(),
      description: scenarioNode
        ? buildGherkinDescription(feature, bgSteps, scenarioNode, tagPrefix)
        : undefined,
      steps: pickle.steps.map(pickleStepToParsedStep),
      tags: allTags,
      azureId: extractAzureId(allTags, tagPrefix),
      line: findScenarioLine(doc, pickle),
      linkRefs: extractLinkRefs(allTags, linkConfigs),
      attachmentRefs: extractAttachmentRefs(allTags, attachmentPrefixes),
    });
  }

  // Sort by line number to preserve file order
  results.sort((a, b) => a.line - b.line);
  return results;
}
