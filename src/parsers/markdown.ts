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
 *   <!-- azure-tc: 12345 -->   ← written back after first push
 *
 *   ---                        ← separator between scenarios
 *
 * ID tag convention:  <!-- {tagPrefix}: 12345 --> anywhere within the scenario block
 * e.g. with default tagPrefix "tc":  <!-- tc: 12345 -->
 * The prefix is set via sync.tagPrefix in the config file.
 */

import * as fs from 'fs';

import { ParsedStep, ParsedTest } from '../types';

// ─── Regexes ─────────────────────────────────────────────────────────────────

const H3_RE = /^###\s+(?:\d+\.\s+)?(.+)$/;            // ### N. Title  or  ### Title
const STEPS_HEADING_RE = /^steps\s*:/i;
const EXPECTED_HEADING_RE = /^expected\s+results?\s*:/i;
const NUMBERED_STEP_RE = /^\s*\d+\.\s+(.+)$/;
const BULLET_STEP_RE = /^\s*[-*]\s+(.+)$/;
const SEPARATOR_RE = /^---+\s*$/;
const mdTcCommentRe = (prefix: string) =>
  new RegExp(`<!--\\s*${prefix}\\s*:\\s*(\\d+)\\s*-->`, 'i');

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
  tagPrefix: string
): ParsedTest {
  const lines = block.lines;

  const tcRe = mdTcCommentRe(tagPrefix);

  // Find ID comment
  let azureId: number | undefined;
  const tcComment = lines.join('\n').match(tcRe);
  if (tcComment) {
    azureId = parseInt(tcComment[1], 10);
  }

  // Extract sections
  let section: 'description' | 'steps' | 'expected' | 'other' = 'description';
  const descLines: string[] = [];
  const stepLines: string[] = [];
  const expectedLines: string[] = [];

  for (const line of lines) {
    if (tcRe.test(line)) continue; // skip ID comment lines

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
    tags: [], // markdown specs don't have Gherkin tags
    azureId,
    line: block.startLine,
  };
}

export function parseMarkdownFile(filePath: string, tagPrefix: string): ParsedTest[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const lines = source.split('\n');
  const blocks = splitIntoScenarios(lines);
  return blocks.map((b) => parseScenarioBlock(b, filePath, tagPrefix));
}
