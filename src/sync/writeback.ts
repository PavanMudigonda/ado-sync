/**
 * ID writeback — writes the Azure DevOps Test Case ID back to the local file
 * after a test case is created, so subsequent syncs can match them.
 *
 * Gherkin strategy:
 *   Inserts (or replaces) a  @{tagPrefix}:12345  tag line directly above the Scenario line.
 *   Default with tagPrefix "tc":  @tc:12345
 *
 * Markdown strategy:
 *   Inserts (or replaces) a  <!-- @{tagPrefix}:{id} -->  comment on the line
 *   immediately following the ### heading.
 *   Default with tagPrefix "tc":  <!-- @tc:12345 -->
 */

import * as fs from 'fs';

import { writebackCsv } from '../parsers/csv';
import { writebackExcel } from '../parsers/excel';
import { ParsedTest } from '../types';

// ─── Gherkin writeback ────────────────────────────────────────────────────────


/**
 * Write (or update) the @tc:ID tag in a .feature file for a given scenario.
 *
 * Strategy:
 *  1. Find the scenario's line (1-based).
 *  2. Look at lines above it for an existing @tc tag line.
 *  3. If found, replace the tag in place.
 *  4. If not found, insert a new tag line directly above the Scenario keyword.
 */
export function writebackGherkin(test: ParsedTest, id: number, tagPrefix: string): void {
  const raw = fs.readFileSync(test.filePath, 'utf8');
  const lines = raw.split('\n');
  const scenarioLineIdx = test.line - 1; // convert to 0-based

  const tagToken = `@${tagPrefix}:${id}`;
  const tagLineRe = new RegExp(`@${tagPrefix}:\\d+`);

  // Walk upward from the scenario line to find an existing tag line
  let replacedInline = false;
  for (let i = scenarioLineIdx - 1; i >= 0 && i >= scenarioLineIdx - 5; i--) {
    if (tagLineRe.test(lines[i])) {
      // Replace the existing tc tag on this line, preserve other tags
      lines[i] = lines[i].replace(tagLineRe, tagToken);
      replacedInline = true;
      break;
    }
  }

  if (!replacedInline) {
    // Insert a new tag line above the Scenario line
    // Detect indentation of the scenario line
    const scenarioLine = lines[scenarioLineIdx] ?? '';
    const indentMatch = scenarioLine.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';
    lines.splice(scenarioLineIdx, 0, `${indent}${tagToken}`);
  }

  fs.writeFileSync(test.filePath, lines.join('\n'), 'utf8');
}

// ─── Markdown writeback ───────────────────────────────────────────────────────

/**
 * Write (or update) the <!-- {tagPrefix}: ID --> comment in a .md file
 * for a given scenario heading.
 *
 * Strategy:
 *  1. Find the ### heading line (1-based).
 *  2. Scan the next ~15 lines for an existing <!-- @tc:N --> comment.
 *  3. If found, replace it.
 *  4. If not found, insert immediately after the heading line.
 */
export function writebackMarkdown(test: ParsedTest, id: number, tagPrefix: string): void {
  const raw = fs.readFileSync(test.filePath, 'utf8');
  const lines = raw.split('\n');
  const headingLineIdx = test.line - 1; // 0-based

  // Plain tag line (same style as Gherkin).  Legacy HTML comment format also matched for replacement.
  const comment = `@${tagPrefix}:${id}`;
  const existingRe = new RegExp(
    `^\\s*@${tagPrefix}:\\d+\\s*$|<!--\\s*@?${tagPrefix}\\s*:\\s*\\d+\\s*-->`,
    'i'
  );

  // Scan forward for an existing comment (up to 15 lines after heading)
  const scanEnd = Math.min(headingLineIdx + 15, lines.length);
  let found = false;
  for (let i = headingLineIdx + 1; i < scanEnd; i++) {
    if (existingRe.test(lines[i])) {
      lines[i] = comment;
      found = true;
      break;
    }
    // Stop at the next heading or separator
    if (/^#{1,6}\s/.test(lines[i]) || /^---+\s*$/.test(lines[i])) break;
  }

  if (!found) {
    // Insert on the line immediately after the heading
    lines.splice(headingLineIdx + 1, 0, comment);
  }

  fs.writeFileSync(test.filePath, lines.join('\n'), 'utf8');
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export async function writebackId(
  test: ParsedTest,
  id: number,
  localType: 'gherkin' | 'markdown' | 'csv' | 'excel',
  tagPrefix: string
): Promise<void> {
  switch (localType) {
    case 'gherkin':
      writebackGherkin(test, id, tagPrefix);
      break;
    case 'markdown':
      writebackMarkdown(test, id, tagPrefix);
      break;
    case 'csv':
      writebackCsv(test.filePath, test.title, id);
      break;
    case 'excel':
      await writebackExcel(test.filePath, test.title, id);
      break;
  }
}
