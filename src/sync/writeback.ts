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

// ─── JavaScript writeback (Jest / Cypress / Jasmine / etc.) ──────────────────

/**
 * Write (or update) the TC ID comment in a source file for a given test function.
 *
 * Format:  // @tc:12345  inserted immediately above the test call / method line.
 * Applies to: JS/TS (non-Playwright frameworks).
 *
 * Strategy:
 *  1. Locate the test line at test.line (1-based).
 *  2. Scan backward (up to 25 lines) for an existing // @{tagPrefix}:N comment.
 *  3. If found, replace in place.
 *  4. If not found, insert immediately above the test line.
 */
export function writebackJavaScript(test: ParsedTest, id: number, tagPrefix: string): void {
  const raw = fs.readFileSync(test.filePath, 'utf8');
  const lines = raw.split('\n');
  const itLineIdx = test.line - 1; // 0-based
  const indentMatch = (lines[itLineIdx] ?? '').match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : '  ';
  const comment = `// @${tagPrefix}:${id}`;
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

// ─── Playwright writeback ─────────────────────────────────────────────────────

/**
 * Write (or update) the TC ID in a Playwright test file using the native
 * annotation API rather than a comment.
 *
 * Target format: annotation: { type: 'tc', description: '12345' }
 * inserted/updated in the test call's options object.
 *
 * Four-phase strategy:
 *  1. Update existing annotation — find  type: '<tagPrefix>'  within 25 lines,
 *     then replace the adjacent  description  value in-place.
 *  2. Inject into existing options — when the test call already has an options
 *     object on the same line, add  annotation: { … }  before the closing '}'.
 *  3. Create options — when the test call has no options object and  async
 *     appears on the same line, insert  { annotation: { … } },  before  async.
 *  4. Comment fallback — if none of the above match, fall back to the
 *     comment-style  // @tc:12345.
 *
 * After successfully writing a native annotation (phases 1-3), any existing
 * // @tc:N  comment above the test line is removed.
 */
export function writebackPlaywright(test: ParsedTest, id: number, tagPrefix: string): void {
  const raw = fs.readFileSync(test.filePath, 'utf8');
  const lines = raw.split('\n');
  const itLineIdx = test.line - 1;
  const newAnnotation = `{ type: '${tagPrefix}', description: '${id}' }`;
  const scanEnd = Math.min(itLineIdx + 25, lines.length);
  let wroteNative = false;

  // ── Phase 1: update an existing tc annotation ─────────────────────────────
  // 1A — inline, type before description:
  //   annotation: { type: 'tc', description: 'OLD' }
  const inlineRe = new RegExp(
    `(annotation\\s*:\\s*\\{[^{}]*type\\s*:\\s*['"]${tagPrefix}['"][^{}]*description\\s*:\\s*['"'])` +
    `\\d+(['"][^{}]*\\})`
  );
  // 1B — inline, description before type:
  //   annotation: { description: 'OLD', type: 'tc' }
  const inlineRevRe = new RegExp(
    `(annotation\\s*:\\s*\\{[^{}]*description\\s*:\\s*['"'])\\d+(['"][^{}]*type\\s*:\\s*['"]${tagPrefix}['"][^{}]*\\})`
  );
  for (let i = itLineIdx; i < scanEnd; i++) {
    if (inlineRe.test(lines[i])) {
      lines[i] = lines[i].replace(inlineRe, `$1${id}$2`);
      wroteNative = true;
      break;
    }
    if (inlineRevRe.test(lines[i])) {
      lines[i] = lines[i].replace(inlineRevRe, `$1${id}$2`);
      wroteNative = true;
      break;
    }
    if (i > itLineIdx && /^\s*async[\s(]/.test(lines[i])) break;
  }

  if (!wroteNative) {
    // 1C — multi-line: type: 'tc' on its own line, description on an adjacent line
    const typeLineRe = new RegExp(`^\\s*type\\s*:\\s*['"]${tagPrefix}['"]`);
    const descLineRe = /^(\s*description\s*:\s*['"])\d+(['"]\s*,?\s*)$/;
    for (let i = itLineIdx; i < scanEnd; i++) {
      if (typeLineRe.test(lines[i])) {
        for (const j of [i - 1, i + 1, i + 2]) {
          if (j >= 0 && j < lines.length && descLineRe.test(lines[j])) {
            lines[j] = lines[j].replace(descLineRe, `$1${id}$2`);
            wroteNative = true;
            break;
          }
        }
        if (wroteNative) break;
      }
      if (i > itLineIdx && /^\s*async[\s(]/.test(lines[i])) break;
    }
  }

  if (!wroteNative) {
    // ── Phase 2 & 3: inject annotation into the test call ─────────────────────
    const itLine = lines[itLineIdx];
    const titlePat = `(?:'[^']*'|"[^"]*"|\`[^\`]*\`)`;
    const fnPat = `(?:it|test|xit|xtest|specify)(?:\\.(?:only|skip|concurrent|fixme|fail))?`;

    // Phase 3 — no options object, async on the same line:
    //   test('title', async ({ page }) => {
    //   → test('title', { annotation: { … } }, async ({ page }) => {
    const noOptsRe = new RegExp(`^(\\s*${fnPat}\\s*\\(\\s*${titlePat}\\s*,\\s*)(async[\\s(])`);
    const noOptsMatch = itLine.match(noOptsRe);
    if (noOptsMatch) {
      lines[itLineIdx] =
        noOptsMatch[1] +
        `{ annotation: ${newAnnotation} }, ` +
        noOptsMatch[2] +
        itLine.slice(noOptsMatch[0].length);
      wroteNative = true;
    }

    if (!wroteNative) {
      // Phase 2 — options object already present on the same line:
      //   test('title', { tag: '@smoke' }, async ...
      //   → test('title', { tag: '@smoke', annotation: { … } }, async ...
      const withOptsRe = new RegExp(`^(\\s*${fnPat}\\s*\\(\\s*${titlePat}\\s*,\\s*)(\\{)`);
      const withOptsMatch = itLine.match(withOptsRe);
      if (withOptsMatch) {
        const braceStart = withOptsMatch[0].length - 1; // position of opening '{'
        let depth = 0;
        let braceEnd = -1;
        for (let k = braceStart; k < itLine.length; k++) {
          if (itLine[k] === '{') depth++;
          else if (itLine[k] === '}') {
            depth--;
            if (depth === 0) { braceEnd = k; break; }
          }
        }
        if (braceEnd >= 0) {
          const before = itLine.slice(0, braceEnd);
          const after = itLine.slice(braceEnd);
          const sep = before.trimEnd().endsWith(',') ? ' ' : ', ';
          lines[itLineIdx] = `${before}${sep}annotation: ${newAnnotation}${after}`;
          wroteNative = true;
        }
      }
    }
  }

  if (wroteNative) {
    // Remove any existing // @tc:N comment above the test line so it doesn't
    // coexist with the native annotation.
    const commentRe = new RegExp(`^\\s*//\\s*@${tagPrefix}:\\d+\\s*$`);
    for (let i = itLineIdx - 1; i >= 0 && i >= itLineIdx - 10; i--) {
      if (commentRe.test(lines[i])) {
        lines.splice(i, 1);
        break;
      }
      if (lines[i].trim() === '') break;
    }
    fs.writeFileSync(test.filePath, lines.join('\n'), 'utf8');
    return;
  }

  // ── Phase 4 (fallback): comment style ─────────────────────────────────────
  writebackJavaScript(test, id, tagPrefix);
}

// ─── Java writeback ───────────────────────────────────────────────────────────

/**
 * Write (or update) the TC ID in a Java test file.
 *
 * Strategy:
 *   JUnit 5 — insert/update  @Tag("{tagPrefix}:N")  in the annotation block
 *             directly after the @Test line (within 20 lines).
 *   JUnit 4 / TestNG — fall back to  // @{tagPrefix}:N  comment style.
 *
 * Framework detection: scan imports above the @Test line for 'org.junit.jupiter.'
 * (JUnit 5). Anything else uses the comment fallback.
 */
export function writebackJava(test: ParsedTest, id: number, tagPrefix: string): void {
  const raw = fs.readFileSync(test.filePath, 'utf8');
  const lines = raw.split('\n');
  const testLineIdx = test.line - 1; // @Test annotation line (0-based)

  // Detect framework by scanning imports at the top of the file
  let isJunit5 = false;
  for (let i = 0; i < lines.length && i < 80; i++) {
    if (lines[i].trim().startsWith('import org.junit.jupiter.')) { isJunit5 = true; break; }
  }

  if (!isJunit5) {
    // JUnit 4 / TestNG: use comment style above the @Test line
    writebackJavaScript(test, id, tagPrefix);
    return;
  }

  // JUnit 5: insert/update @Tag("{tagPrefix}:N") inside the attribute block
  const newTag = `@Tag("${tagPrefix}:${id}")`;
  const existingRe = new RegExp(`@Tag\\(\\s*"${tagPrefix}:\\d+"\\s*\\)`);
  const indentMatch = (lines[testLineIdx] ?? '').match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : '    ';

  // Scan forward (up to 20 lines) for existing tag or method signature
  const scanEnd = Math.min(testLineIdx + 20, lines.length);
  let replaced = false;
  for (let i = testLineIdx + 1; i < scanEnd; i++) {
    const trimmed = lines[i].trim();
    // Stop at method signature or class body
    if (/^(?:public|private|protected|void|static)\s/.test(trimmed) || trimmed === '{') break;
    if (existingRe.test(trimmed)) {
      lines[i] = lines[i].replace(existingRe, newTag);
      replaced = true;
      break;
    }
  }

  if (!replaced) {
    // Insert immediately after @Test line
    lines.splice(testLineIdx + 1, 0, `${indent}${newTag}`);
  }

  fs.writeFileSync(test.filePath, lines.join('\n'), 'utf8');
}

// ─── Python writeback ─────────────────────────────────────────────────────────

/**
 * Write (or update) the TC ID in a Python pytest file.
 *
 * Strategy:
 *   Insert / update  @pytest.mark.{tagPrefix}(N)  immediately above the
 *   def test_*  line (below any existing marks that are already there).
 *   If the mark already exists, replace the number in-place.
 */
export function writebackPython(test: ParsedTest, id: number, tagPrefix: string): void {
  const raw = fs.readFileSync(test.filePath, 'utf8');
  const lines = raw.split('\n');
  const defLineIdx = test.line - 1; // def test_* line (0-based)

  const indentMatch = (lines[defLineIdx] ?? '').match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : '';
  const newMark = `${indent}@pytest.mark.${tagPrefix}(${id})`;
  const existingRe = new RegExp(`^(\\s*)@pytest\\.mark\\.${tagPrefix}\\(\\d+\\)\\s*$`);

  // Scan backward through the decorator block to find existing mark
  let replaced = false;
  for (let i = defLineIdx - 1; i >= 0 && i >= defLineIdx - 50; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || (/^(?:async\s+)?def\s+/.test(trimmed) && i !== defLineIdx) || /^class\s+/.test(trimmed)) break;
    if (existingRe.test(lines[i])) {
      lines[i] = newMark;
      replaced = true;
      break;
    }
  }

  if (!replaced) {
    // Insert immediately above the def line
    lines.splice(defLineIdx, 0, newMark);
  }

  fs.writeFileSync(test.filePath, lines.join('\n'), 'utf8');
}

// ─── TestCafe writeback ───────────────────────────────────────────────────────

/**
 * Write (or update) the TC ID in a TestCafe test file.
 *
 * Strategy:
 *   1. If the test call already has a .meta() chain, update the ID value inside it.
 *   2. If the line is a plain test('title', fn) call, prepend .meta('{tagPrefix}', 'N').
 *   3. Fall back to comment style // @{tagPrefix}:N if the call cannot be parsed.
 */
export function writebackTestCafe(test: ParsedTest, id: number, tagPrefix: string): void {
  const raw = fs.readFileSync(test.filePath, 'utf8');
  const lines = raw.split('\n');
  const testLineIdx = test.line - 1; // 0-based

  const line = lines[testLineIdx] ?? '';

  // ── Update existing .meta('tc', 'OLD') key-value form ───────────────────────
  const kvRe = new RegExp(`(\\.meta\\s*\\(\\s*['"]${tagPrefix}['"]\\s*,\\s*['"])\\d+(['"]\\s*\\))`);
  if (kvRe.test(line)) {
    lines[testLineIdx] = line.replace(kvRe, `$1${id}$2`);
    fs.writeFileSync(test.filePath, lines.join('\n'), 'utf8');
    return;
  }

  // ── Update existing .meta({ tc: 'OLD' }) object form ────────────────────────
  const objRe = new RegExp(`(\\.meta\\s*\\(\\s*\\{[^}]*['"]?${tagPrefix}['"]?\\s*:\\s*['"])\\d+(['"][^}]*\\}\\s*\\))`);
  if (objRe.test(line)) {
    lines[testLineIdx] = line.replace(objRe, `$1${id}$2`);
    fs.writeFileSync(test.filePath, lines.join('\n'), 'utf8');
    return;
  }

  // ── No existing .meta — inject before the title argument ────────────────────
  // Matches: test('title', fn)  test.skip('title', fn)  test.only('title', fn)
  const plainRe = /^(\s*)(test(?:\.(?:skip|only))?)\s*\(/;
  const plainMatch = line.match(plainRe);
  if (plainMatch) {
    const prefix = plainMatch[1];
    const fn = plainMatch[2];
    const rest = line.slice(plainMatch[0].length);
    lines[testLineIdx] = `${prefix}${fn}.meta('${tagPrefix}', '${id}')(${rest}`;
    fs.writeFileSync(test.filePath, lines.join('\n'), 'utf8');
    return;
  }

  // ── Fallback: comment style ──────────────────────────────────────────────────
  writebackJavaScript(test, id, tagPrefix);
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export async function writebackId(
  test: ParsedTest,
  id: number,
  localType: string,
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
    case 'playwright':
      writebackPlaywright(test, id, tagPrefix);
      break;
    case 'javascript':
    case 'cypress':
    case 'puppeteer':
    case 'detox':
      writebackJavaScript(test, id, tagPrefix);
      break;
    case 'java':
    case 'espresso':
      writebackJava(test, id, tagPrefix);
      break;
    case 'python':
      writebackPython(test, id, tagPrefix);
      break;
    case 'testcafe':
      writebackTestCafe(test, id, tagPrefix);
      break;
    case 'xcuitest':
    case 'flutter':
      // Swift / Dart use comment style
      writebackJavaScript(test, id, tagPrefix);
      break;
  }
}
