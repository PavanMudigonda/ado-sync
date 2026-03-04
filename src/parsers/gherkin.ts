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
import { extractLinkRefs, extractPathTags } from './shared';

// Re-export for backward-compatibility
export { extractPathTags };

// ─── Step type → keyword mapping ─────────────────────────────────────────────

const STEP_TYPE_KEYWORD: Record<string, string> = {
  Context: 'Given',
  Action:  'When',
  Outcome: 'Then',
  Unknown: 'Step',
};

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

function pickleStepToParsedStep(step: PickleStep): ParsedStep {
  return {
    keyword: STEP_TYPE_KEYWORD[step.type ?? 'Unknown'] ?? 'Step',
    text: step.text.trim(),
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
  linkConfigs: LinkConfig[] | undefined
): ParsedTest {
  const scenarioTags = scenario.tags.map((t) => stripAt(t.name));
  const allTags = [...new Set([...pathTags, ...scenarioTags])];

  // Template steps keep <param> angle-bracket syntax as-is
  const steps: ParsedStep[] = (scenario.steps as Step[]).map((s) => ({
    keyword: (s.keyword ?? '').trim(),
    text: s.text.trim(),
  }));

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
    steps,
    tags: allTags,
    azureId: extractAzureId(allTags, tagPrefix),
    line: scenario.location?.line ?? 1,
    outlineParameters: headers.length ? { headers, rows } : undefined,
    linkRefs: extractLinkRefs(allTags, linkConfigs),
  };
}

// ─── Public parser ────────────────────────────────────────────────────────────

export function parseGherkinFile(
  filePath: string,
  tagPrefix: string,
  linkConfigs?: LinkConfig[]
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
  } catch (err: any) {
    throw new Error(`Failed to parse ${filePath}: ${err.message}`);
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
  const pickles: Pickle[] = messages
    .filter((m) => m.pickle)
    .map((m) => m.pickle!);

  // Tags from directory path segments (e.g. specs/@smoke/ → 'smoke')
  const pathTags = extractPathTags(filePath);

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
        scenarioOutlineToParsedTest(scenario, filePath, pathTags, tagPrefix, linkConfigs)
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

    results.push({
      filePath,
      title: pickle.name.trim(),
      steps: pickle.steps.map(pickleStepToParsedStep),
      tags: allTags,
      azureId: extractAzureId(allTags, tagPrefix),
      line: findScenarioLine(doc, pickle),
      linkRefs: extractLinkRefs(allTags, linkConfigs),
    });
  }

  // Sort by line number to preserve file order
  results.sort((a, b) => a.line - b.line);
  return results;
}
