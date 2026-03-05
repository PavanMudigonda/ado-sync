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

// ─── C# writeback ─────────────────────────────────────────────────────────────

/**
 * Write (or update) [TestProperty("tc", "ID")] in a .cs file for a given [TestMethod].
 *
 * Strategy:
 *  1. Locate [TestMethod] at test.line (1-based).
 *  2. Scan forward up to 20 lines for an existing [TestProperty("<tagPrefix>", "...")] — replace it.
 *  3. If not found, insert immediately after the [TestMethod] line, matching indentation.
 *
 * Only the value is replaced on an existing attribute; all other attributes are untouched.
 */
export function writebackCsharp(test: ParsedTest, id: number, tagPrefix: string): void {
  const raw = fs.readFileSync(test.filePath, 'utf8');
  const lines = raw.split('\n');

  const testMethodLineIdx = test.line - 1; // 0-based

  // Re-detect framework from the marker line so we use the correct attribute form.
  // MSTest uses [TestProperty("key","val")], NUnit uses [Property("key","val")].
  const markerTrimmed = (lines[testMethodLineIdx] ?? '').trim();
  const isNUnit = /^\[Test[\]( ]/.test(markerTrimmed) && !/^\[TestMethod[\]( ]/.test(markerTrimmed);
  const propAttrName = isNUnit ? 'Property' : 'TestProperty';

  const newAttr = `[${propAttrName}("${tagPrefix}", "${id}")]`;
  // Match either form so a pre-existing attribute written by a different tool is also replaced
  const existingRe = new RegExp(`\\[(?:Test)?Property\\("${tagPrefix}",\\s*"\\d+"\\)\\]`);

  // Detect indentation from the [TestMethod] / [Test] line
  const indentMatch = (lines[testMethodLineIdx] ?? '').match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : '        ';

  // Scan forward for an existing property attribute within the attribute block
  const scanEnd = Math.min(testMethodLineIdx + 20, lines.length);
  let replaced = false;
  for (let i = testMethodLineIdx + 1; i < scanEnd; i++) {
    const trimmed = lines[i].trim();
    // Stop once we reach the method signature or body
    if (/^(public|private|protected|internal)\s/.test(trimmed) || trimmed === '{') break;
    if (existingRe.test(trimmed)) {
      lines[i] = lines[i].replace(existingRe, newAttr);
      replaced = true;
      break;
    }
  }

  if (!replaced) {
    // Insert on the line immediately after [TestMethod] / [Test]
    lines.splice(testMethodLineIdx + 1, 0, `${indent}${newAttr}`);
  }

  fs.writeFileSync(test.filePath, lines.join('\n'), 'utf8');
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export async function writebackId(
  test: ParsedTest,
  id: number,
  localType: 'gherkin' | 'markdown' | 'csv' | 'excel' | 'csharp',
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
    case 'csharp':
      writebackCsharp(test, id, tagPrefix);
      break;
  }
}
