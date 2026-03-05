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
 *   <!-- @tc:12345 -->                    ← written back after first push
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
import { extractAttachmentRefs, extractLinkRefs, extractPathTags, getAttachmentPrefixes } from './shared';

// ─── Regexes ─────────────────────────────────────────────────────────────────

const H3_RE = /^###\s+(?:\d+\.\s+)?(.+)$/;            // ### N. Title  or  ### Title
const STEPS_HEADING_RE = /^steps\s*:/i;
const EXPECTED_HEADING_RE = /^expected\s+results?\s*:/i;
const NUMBERED_STEP_RE = /^\s*\d+\.\s+(.+)$/;
const BULLET_STEP_RE = /^\s*[-*]\s+(.+)$/;

/** Strip leading/trailing markdown bold markers (**) so **Steps:** matches Steps: */
function stripBold(s: string): string {
  return s.replace(/^\*+/, '').replace(/\*+$/, '');
}
const SEPARATOR_RE = /^---+\s*$/;
// Matches a tag line that starts with "@tc:12345" optionally followed by more @tags.
// e.g.  "@tc:32845"  or  "@tc:32845 @smoke @regression"
const mdTcTagRe = (prefix: string) => new RegExp(`^\\s*@${prefix}:(\\d+)((?:\\s+@\\S+)*)\\s*$`, 'm');
const mdTcCommentRe = (prefix: string) =>
  new RegExp(`<!--\\s*@?${prefix}\\s*:\\s*(\\d+)\\s*-->`, 'i');
function findTcId(prefix: string, blockText: string): number | undefined {
  const m = blockText.match(mdTcTagRe(prefix)) ?? blockText.match(new RegExp(`<!--\\s*@?${prefix}\\s*:\\s*(\\d+)\\s*-->`, 'im'));
  return m ? parseInt(m[1], 10) : undefined;
}
/** Extract any extra @tags written on the same line as the tc ID, e.g. @tc:32845 @smoke → ['smoke'] */
function extractTcLineTags(prefix: string, blockText: string): string[] {
  const m = blockText.match(mdTcTagRe(prefix));
  if (!m || !m[2]) return [];
  return m[2].trim().split(/\s+/).filter(Boolean).map((t) => t.slice(1)); // strip leading '@'
}
/** A standalone tag line contains only @word tokens (no tc: ID prefix). e.g. "@smoke @regression" */
const STANDALONE_TAG_LINE_RE = /^\s*(@[A-Za-z][\w-]*(\s+@[A-Za-z][\w-]*)*)\s*$/;
function isStandaloneTagLine(prefix: string, line: string): boolean {
  const t = line.trim();
  // Must look like all-@tags but NOT be a tc ID line
  return STANDALONE_TAG_LINE_RE.test(t) && !mdTcTagRe(prefix).test(t);
}
/** Extract tags from a standalone tag line: "@smoke @regression" → ['smoke', 'regression'] */
function parseStandaloneTagLine(line: string): string[] {
  return line.trim().split(/\s+/).filter((t) => t.startsWith('@')).map((t) => t.slice(1));
}
function isTcLine(prefix: string, line: string): boolean {
  const t = line.trim();
  return mdTcTagRe(prefix).test(t) || mdTcCommentRe(prefix).test(t);
}
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
  linkConfigs: LinkConfig[] | undefined,
  attachmentPrefixes: string[]
): ParsedTest {
  const lines = block.lines;
  const blockText = lines.join('\n');

  // Find ID — plain "@tc:12345" line (new) or legacy HTML comment (backward compat)
  const azureId = findTcId(tagPrefix, blockText);

  // Collect tags from four sources:
  //  1. Path-based auto-tags
  //  2. Inline tags on the tc ID line:    @tc:32845 @smoke @regression
  //  3. Standalone @tag lines:            @smoke
  //                                       @regression
  //  4. HTML comment:                     <!-- tags: @smoke, @regression -->
  const blockTags: string[] = [...pathTags];
  blockTags.push(...extractTcLineTags(tagPrefix, blockText));
  for (const line of lines) {
    if (isStandaloneTagLine(tagPrefix, line)) {
      blockTags.push(...parseStandaloneTagLine(line));
    }
  }
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
    if (isTcLine(tagPrefix, line)) continue;           // skip ID tag/comment lines
    if (TAGS_COMMENT_RE.test(line)) continue;          // skip <!-- tags: ... --> lines
    if (isStandaloneTagLine(tagPrefix, line)) continue; // skip standalone @tag lines

    if (STEPS_HEADING_RE.test(stripBold(line.trim()))) {
      section = 'steps';
      continue;
    }
    if (EXPECTED_HEADING_RE.test(stripBold(line.trim()))) {
      section = 'expected';
      continue;
    }
    // H1/H2 headings are unexpected inside a scenario block — reset to ignore.
    // H4+ sub-headings (#### 1.1 ...) are treated as content within the current section.
    if (/^#{1,2}\s/.test(line)) {
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
    attachmentRefs: extractAttachmentRefs(allTags, attachmentPrefixes),
  };
}

export function parseMarkdownFile(
  filePath: string,
  tagPrefix: string,
  linkConfigs?: LinkConfig[],
  attachmentsConfig?: { enabled: boolean; tagPrefixes?: string[] }
): ParsedTest[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const lines = source.split('\n');
  const blocks = splitIntoScenarios(lines);
  // Path-based auto-tags (same as Gherkin)
  const pathTags = extractPathTags(filePath);
  const attachmentPrefixes = getAttachmentPrefixes(attachmentsConfig);
  return blocks.map((b) => parseScenarioBlock(b, filePath, tagPrefix, pathTags, linkConfigs, attachmentPrefixes));
}
