/**
 * Gherkin / Cucumber .feature file parser.
 *
 * Uses the modern @cucumber/gherkin generateMessages() API (same approach as
 * playwright-bdd). This produces both the GherkinDocument (AST) and Pickles
 * (compiled, example-substituted scenarios) in a single pass.
 *
 * Pickles are the canonical unit of work — they already have:
 *   - Example values substituted in titles and step text
 *   - Background steps merged into every scenario
 *   - Tags inherited from Feature + Scenario + Examples blocks
 *   - Step type (Context/Action/Outcome) instead of keyword
 *
 * ID tag convention:  @tc:12345  (prefix configurable via sync.tagPrefix)
 *
 * Path-based auto-tagging:
 *   Directory segments prefixed with @ are added as tags automatically.
 *   e.g.  specs/@smoke/@regression/login.feature  →  tags: ['smoke', 'regression']
 */

import { generateMessages } from '@cucumber/gherkin';
import { GherkinDocument, IdGenerator, Pickle, PickleStep,SourceMediaType } from '@cucumber/messages';
import * as fs from 'fs';
import * as path from 'path';

import { ParsedStep, ParsedTest } from '../types';

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
 * Extract auto-tags from directory segments that start with '@'.
 *
 * Given  /project/specs/@smoke/@regression/login.feature
 * returns ['smoke', 'regression']
 */
export function extractPathTags(filePath: string): string[] {
  const segments = filePath.split(path.sep);
  const tags: string[] = [];
  // Walk directory segments (not the filename itself)
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    // A segment may contain multiple @tags separated by spaces or be just one tag
    const matches = seg.match(/@[^\s@/\\]+/g);
    if (matches) {
      tags.push(...matches.map(stripAt));
    }
  }
  return tags;
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

// ─── Public parser ────────────────────────────────────────────────────────────

export function parseGherkinFile(filePath: string, tagPrefix: string): ParsedTest[] {
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

  return pickles.map((pickle): ParsedTest => {
    // Pickle tags already include Feature + Scenario + Examples tags (inherited)
    const pickleTags = pickle.tags.map((t) => stripAt(t.name));
    const allTags = [...new Set([...pathTags, ...pickleTags])];

    return {
      filePath,
      title: pickle.name.trim(),
      steps: pickle.steps.map(pickleStepToParsedStep),
      tags: allTags,
      azureId: extractAzureId(allTags, tagPrefix),
      line: findScenarioLine(doc, pickle),
    };
  });
}
