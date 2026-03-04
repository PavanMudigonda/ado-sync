/**
 * Markdown test spec parser.
 *
 * Expected file structure:
 *
 *   # Plan title
 *
 *   ## Test scenarios          ← optional section heading (ignored)
 *
 *   ### 1. Scenario title      ← H3 heading = one test case
 *
 *   <!-- tags: @smoke, @regression -->   ← optional tags (Gap 5)
 *   <!-- tc: 12345 -->                   ← written back after first push
 *
 *   Assumption: ...            ← optional prose, used as description
 *
 *   Steps:
 *   1. Do this
 *   2. Do that
 *
 *   Expected results:
 *   - Result A
 *   - Result B
 *
 *   ---                        ← separator between scenarios
 *
 * ID tag convention:  <!-- {tagPrefix}: 12345 --> anywhere within the scenario block
 * Tags convention:    <!-- tags: @tag1, @tag2 --> anywhere within the scenario block
 * Path-based auto-tagging: same as Gherkin (directory segments starting with @)
 */

import * as fs from 'fs';

import { LinkConfig, ParsedStep, ParsedTest } from '../types';
import { extractLinkRefs, extractPathTags } from './shared';

// ─── Regexes ─────────────────────────────────────────────────────────────────

const H3_RE = /^###\s+(?:\d+\.\s+)?(.+)$/;            // ### N. Title  or  ### Title
const STEPS_HEADING_RE = /^steps\s*:/i;
const EXPECTED_HEADING_RE = /^expected\s+results?\s*:/i;
const NUMBERED_STEP_RE = /^\s*\d+\.\s+(.+)$/;
const BULLET_STEP_RE = /^\s*[-*]\s+(.+)$/;
const SEPARATOR_RE = /^---+\s*$/;
const mdTcCommentRe = (prefix: string) =>
  new RegExp(`<!--\\s*${prefix}\\s*:\\s*(\\d+)\\s*-->`, 'i');
const TAGS_COMMENT_RE = /<!--\s*tags\s*:\s*([^>]+)-->/i;

// ─── Parser ──────────────────────────────────────────────────────────────────

interface ScenarioBlock {
  title: string;
  startLine: number;
  lines: string[];
}

function splitIntoScenarios(lines: string[]): ScenarioBlock[] {
  const blocks: ScenarioBlock[] = [];
  let current: ScenarioBlock | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h3Match = line.match(H3_RE);

    if (h3Match) {
      if (current) blocks.push(current);
      current = { title: h3Match[1].trim(), startLine: i + 1, lines: [] };
    } else if (current) {
      if (SEPARATOR_RE.test(line)) {
        blocks.push(current);
        current = null;
      } else {
        current.lines.push(line);
      }
    }
  }

  if (current) blocks.push(current);
  return blocks;
}

function parseScenarioBlock(
  block: ScenarioBlock,
  filePath: string,
  tagPrefix: string,
  pathTags: string[],
  linkConfigs: LinkConfig[] | undefined
): ParsedTest {
  const lines = block.lines;
  const blockText = lines.join('\n');

  const tcRe = mdTcCommentRe(tagPrefix);

  // Find ID comment
  let azureId: number | undefined;
  const tcComment = blockText.match(tcRe);
  if (tcComment) {
    azureId = parseInt(tcComment[1], 10);
  }

  // Find <!-- tags: @smoke, @regression --> comment (Gap 5)
  const blockTags: string[] = [...pathTags];
  const tagsComment = blockText.match(TAGS_COMMENT_RE);
  if (tagsComment) {
    const rawTags = tagsComment[1]
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => (t.startsWith('@') ? t.slice(1) : t));
    blockTags.push(...rawTags);
  }
  const allTags = [...new Set(blockTags)];

  // Extract sections
  let section: 'description' | 'steps' | 'expected' | 'other' = 'description';
  const descLines: string[] = [];
  const stepLines: string[] = [];
  const expectedLines: string[] = [];

  for (const line of lines) {
    if (tcRe.test(line)) continue;       // skip ID comment lines
    if (TAGS_COMMENT_RE.test(line)) continue; // skip tags comment lines

    if (STEPS_HEADING_RE.test(line.trim())) {
      section = 'steps';
      continue;
    }
    if (EXPECTED_HEADING_RE.test(line.trim())) {
      section = 'expected';
      continue;
    }
    // A new unrecognised heading resets to 'other'
    if (/^#{1,6}\s/.test(line)) {
      section = 'other';
    }

    switch (section) {
      case 'description':
        descLines.push(line);
        break;
      case 'steps':
        if (NUMBERED_STEP_RE.test(line) || BULLET_STEP_RE.test(line)) stepLines.push(line);
        break;
      case 'expected':
        if (NUMBERED_STEP_RE.test(line) || BULLET_STEP_RE.test(line)) expectedLines.push(line);
        break;
    }
  }

  // Build steps
  const parsedSteps: ParsedStep[] = stepLines.map((l) => {
    const m = l.match(NUMBERED_STEP_RE) ?? l.match(BULLET_STEP_RE);
    return { keyword: 'Step', text: (m ? m[1] : l).trim() };
  });

  // Attach expected results as the expected value of the last step,
  // or add a dedicated verification step if there are no regular steps.
  const expectedText = expectedLines
    .map((l) => {
      const m = l.match(NUMBERED_STEP_RE) ?? l.match(BULLET_STEP_RE);
      return (m ? m[1] : l).trim();
    })
    .join('\n');

  if (expectedText) {
    if (parsedSteps.length > 0) {
      parsedSteps[parsedSteps.length - 1].expected = expectedText;
    } else {
      parsedSteps.push({ keyword: 'Verify', text: 'Expected results', expected: expectedText });
    }
  }

  // Description: trim trailing blank lines
  const description = descLines
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim() || undefined;

  return {
    filePath,
    title: block.title,
    description,
    steps: parsedSteps,
    tags: allTags,
    azureId,
    line: block.startLine,
    linkRefs: extractLinkRefs(allTags, linkConfigs),
  };
}

export function parseMarkdownFile(
  filePath: string,
  tagPrefix: string,
  linkConfigs?: LinkConfig[]
): ParsedTest[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const lines = source.split('\n');
  const blocks = splitIntoScenarios(lines);
  // Path-based auto-tags (same as Gherkin)
  const pathTags = extractPathTags(filePath);
  return blocks.map((b) => parseScenarioBlock(b, filePath, tagPrefix, pathTags, linkConfigs));
}
