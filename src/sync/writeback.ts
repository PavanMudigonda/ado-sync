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
import { detectJavaFramework } from '../parsers/java';
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

// ─── JavaScript writeback ─────────────────────────────────────────────────────

/**
 * Write (or update) the TC ID comment in a .js / .ts file for a given
 * it() / test() call (Jest, Jasmine, WebdriverIO).
 *
 * Format:  // @tc:12345  inserted immediately above the it() / test() line.
 * No extra dependency required.
 *
 * Strategy:
 *  1. Locate the it()/test() line at test.line (1-based).
 *  2. Scan backward (up to 25 lines) for an existing // @{tagPrefix}:N comment.
 *  3. If found, replace in place.
 *  4. If not found, insert immediately above the it()/test() line.
 */
export function writebackJavaScript(test: ParsedTest, id: number, tagPrefix: string): void {
  const raw = fs.readFileSync(test.filePath, 'utf8');
  const lines = raw.split('\n');

  const itLineIdx = test.line - 1; // 0-based

  const indentMatch = (lines[itLineIdx] ?? '').match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : '  ';

  const comment    = `// @${tagPrefix}:${id}`;
  const existingRe = new RegExp(`//\\s*@${tagPrefix}:\\d+`);

  let replaced = false;
  for (let i = itLineIdx - 1; i >= 0 && i >= itLineIdx - 25; i--) {
    const trimmed = lines[i].trim();

    if (existingRe.test(trimmed)) {
      lines[i] = lines[i].replace(existingRe, comment.trim());
      replaced = true;
      break;
    }

    // Stop at blank lines — the ID comment must be adjacent to the test
    if (trimmed === '') break;
  }

  if (!replaced) {
    lines.splice(itLineIdx, 0, `${indent}${comment}`);
  }

  fs.writeFileSync(test.filePath, lines.join('\n'), 'utf8');
}

// ─── Python writeback ─────────────────────────────────────────────────────────

/**
 * Write (or update) the TC ID in a .py file for a given def test_* function.
 *
 * Format:  @pytest.mark.{tagPrefix}(12345)  inserted immediately above the
 * def line, below any other existing marks.
 *
 * No extra Python dependency — pytest is already on the test path.
 *
 * Strategy:
 *  1. Locate the def line at test.line (1-based).
 *  2. Scan backward (up to 30 lines) for an existing @pytest.mark.{tagPrefix}(N).
 *     Also recognises the comment fallback  # @tc:N  and replaces it with the mark.
 *  3. If found, update in place.
 *  4. If not found, insert @pytest.mark.{tagPrefix}(N) immediately above the def line.
 */
export function writebackPython(test: ParsedTest, id: number, tagPrefix: string): void {
  const raw = fs.readFileSync(test.filePath, 'utf8');
  const lines = raw.split('\n');

  const defLineIdx = test.line - 1; // 0-based

  const indentMatch = (lines[defLineIdx] ?? '').match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : '';

  const newMark     = `${indent}@pytest.mark.${tagPrefix}(${id})`;
  const existMarkRe = new RegExp(`^\\s*@pytest\\.mark\\.${tagPrefix}\\(\\d+\\)\\s*$`);
  const commentIdRe = new RegExp(`#\\s*@${tagPrefix}:\\d+`);

  // Scan backward for an existing ID mark or comment
  let replaced = false;
  for (let i = defLineIdx - 1; i >= 0 && i >= defLineIdx - 30; i--) {
    const trimmed = lines[i].trim();

    if (existMarkRe.test(lines[i])) {
      lines[i] = newMark;
      replaced = true;
      break;
    }

    // Replace a legacy comment-style ID with the proper mark
    if (commentIdRe.test(trimmed)) {
      lines[i] = newMark;
      replaced = true;
      break;
    }

    // Stop at blank lines or non-decorator lines
    if (trimmed === '' || (!trimmed.startsWith('@') && !trimmed.startsWith('#'))) break;
  }

  if (!replaced) {
    // Insert immediately above the def line
    lines.splice(defLineIdx, 0, newMark);
  }

  fs.writeFileSync(test.filePath, lines.join('\n'), 'utf8');
}

// ─── Java writeback ───────────────────────────────────────────────────────────

/**
 * Write (or update) the TC ID in a .java file for a given @Test method.
 *
 * Strategy by framework (detected from import statements):
 *
 *   JUnit 5  →  @Tag("tc:12345")  inserted/updated in the annotation block above @Test.
 *               @Tag is already in junit-jupiter-api — no extra dependency.
 *               Scans both above and below @Test for an existing @Tag("tc:N") to update.
 *
 *   JUnit 4  →  // @tc:12345  comment inserted/updated immediately above @Test.
 *   TestNG   →  // @tc:12345  comment inserted/updated immediately above @Test.
 *               Note: @Test(tc="...") is not valid TestNG syntax.
 *   unknown  →  comment fallback (same as JUnit 4/TestNG).
 */
export function writebackJava(test: ParsedTest, id: number, tagPrefix: string): void {
  const raw = fs.readFileSync(test.filePath, 'utf8');
  const lines = raw.split('\n');

  const testAnnotationLineIdx = test.line - 1; // 0-based

  const indentMatch = (lines[testAnnotationLineIdx] ?? '').match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : '    ';

  const framework = detectJavaFramework(lines);

  if (framework === 'junit5') {
    // ── JUnit 5: use @Tag("tc:12345") ──────────────────────────────────────
    const newTag = `@Tag("${tagPrefix}:${id}")`;
    const existingTagRe = new RegExp(`^@Tag\\(\\s*"${tagPrefix}:\\d+"\\s*\\)$`);

    // Scan ABOVE @Test first (up to 25 lines)
    let replaced = false;
    for (let i = testAnnotationLineIdx - 1; i >= 0 && i >= testAnnotationLineIdx - 25; i--) {
      const trimmed = lines[i].trim();
      if (existingTagRe.test(trimmed)) {
        lines[i] = lines[i].replace(existingTagRe, newTag);
        replaced = true;
        break;
      }
      if (trimmed === '}' || /^\s*(?:(?:public|protected|private|abstract|final)\s+)*class\s+/.test(trimmed)) break;
    }

    // Scan BELOW @Test (annotation block, up to 25 lines) if not found above
    if (!replaced) {
      for (let i = testAnnotationLineIdx + 1; i < lines.length && i < testAnnotationLineIdx + 25; i++) {
        const trimmed = lines[i].trim();
        if (existingTagRe.test(trimmed)) {
          lines[i] = lines[i].replace(existingTagRe, newTag);
          replaced = true;
          break;
        }
        // Stop at method signature or body
        if (!trimmed.startsWith('@') && trimmed.includes('(')) break;
        if (trimmed === '{') break;
      }
    }

    if (!replaced) {
      // Insert immediately above the @Test line
      lines.splice(testAnnotationLineIdx, 0, `${indent}${newTag}`);
    }

    // Also remove any stale comment-style ID that may have been written previously
    const staleCommentRe = new RegExp(`//\\s*@${tagPrefix}:\\d+`);
    for (let i = testAnnotationLineIdx; i >= 0 && i >= testAnnotationLineIdx - 25; i--) {
      if (staleCommentRe.test(lines[i])) {
        lines.splice(i, 1);
        break;
      }
      const t = lines[i]?.trim() ?? '';
      if (t === '}' || /^\s*(?:(?:public|protected|private|abstract|final)\s+)*class\s+/.test(t)) break;
    }
  } else {
    // ── JUnit 4 / TestNG / unknown: use // @tc:12345 comment ───────────────
    const comment = `// @${tagPrefix}:${id}`;
    const existingCommentRe = new RegExp(`//\\s*@${tagPrefix}:\\d+`);

    let replaced = false;
    for (let i = testAnnotationLineIdx - 1; i >= 0 && i >= testAnnotationLineIdx - 25; i--) {
      const trimmed = lines[i].trim();
      if (existingCommentRe.test(trimmed)) {
        lines[i] = lines[i].replace(existingCommentRe, comment.trim());
        replaced = true;
        break;
      }
      if (trimmed === '}' || /^\s*(?:(?:public|protected|private|abstract|final)\s+)*class\s+/.test(trimmed)) break;
    }

    if (!replaced) {
      lines.splice(testAnnotationLineIdx, 0, `${indent}${comment}`);
    }
  }

  fs.writeFileSync(test.filePath, lines.join('\n'), 'utf8');
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export async function writebackId(
  test: ParsedTest,
  id: number,
  localType: 'gherkin' | 'markdown' | 'csv' | 'excel' | 'csharp' | 'java' | 'python' | 'javascript',
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
    case 'java':
      writebackJava(test, id, tagPrefix);
      break;
    case 'python':
      writebackPython(test, id, tagPrefix);
      break;
    case 'javascript':
      writebackJavaScript(test, id, tagPrefix);
      break;
  }
}
