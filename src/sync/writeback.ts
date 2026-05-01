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
import * as path from 'path';

import { writebackCsv } from '../parsers/csv';
import { writebackExcel } from '../parsers/excel';
import { detectJavaFramework } from '../parsers/java';
import { ParsedStep, ParsedTest } from '../types';

// ─── Atomic write helper ──────────────────────────────────────────────────────

/**
 * Write content atomically: write to a temp file then rename to the target.
 * Prevents partial writes from corrupting spec files if the process is interrupted.
 */
function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.ado-sync-tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup error */ }
    throw err;
  }
}

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

  atomicWriteFileSync(test.filePath, lines.join('\n'));
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

  atomicWriteFileSync(test.filePath, lines.join('\n'));
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

  atomicWriteFileSync(test.filePath, lines.join('\n'));
}

// ─── Comment-style writeback (JavaScript, TypeScript, Swift, Dart) ───────────
//
// Used by all frameworks that store the TC ID as a single-line  // @tc:12345
// comment immediately above the test function call / definition:
//   • JavaScript / TypeScript  (Jest, Playwright, Cypress, TestCafe, Detox, Puppeteer, WebdriverIO)
//   • Swift  (XCUITest — same  // comment syntax)
//   • Dart   (Flutter   — same  // comment syntax)
//
// Re-exported as writebackJavaScript to avoid a breaking rename.

/**
 * Write (or update) the TC ID comment in a source file for a given test function.
 *
 * Format:  // @tc:12345  inserted immediately above the test call / method line.
 * Applies to: JS/TS (all frameworks), Swift (XCUITest), Dart (Flutter).
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

    // Stop at blank lines — the ID comment must be adjacent to the test.
    // But first peek one more line above a blank line in case the ID comment
    // is separated by a single blank line.
    if (trimmed === '') {
      if (i - 1 >= 0 && existingRe.test(lines[i - 1].trim())) {
        lines[i - 1] = lines[i - 1].replace(existingRe, comment.trim());
        replaced = true;
      }
      break;
    }
  }

  if (!replaced) {
    lines.splice(itLineIdx, 0, `${indent}${comment}`);
  }

  atomicWriteFileSync(test.filePath, lines.join('\n'));
}

// ─── Playwright writeback ─────────────────────────────────────────────────────

/**
 * Write (or update) the TC ID in a Playwright test file using the native
 * annotation API rather than a comment.
 *
 * Target format: annotation: { type: 'tc', description: '12345' }
 * inserted/updated in the test call's options object.
 *
 * Three-phase strategy:
 *  1. Update existing annotation — find  type: '<tagPrefix>'  within 25 lines,
 *     then replace the adjacent  description  value in-place.  Handles both
 *     inline  { type: 'tc', description: 'OLD' }  and multi-line forms.
 *  2. Inject into existing options — when the test call already has an options
 *     object on the same line, add  annotation: { … }  before the closing '}'.
 *  3. Create options — when the test call has no options object and  async
 *     appears on the same line, insert  { annotation: { … } },  before  async.
 *  4. Comment fallback — if none of the above match, fall back to the
 *     comment-style  // @tc:12345  (handles unusual multi-line patterns).
 */
export function writebackPlaywright(test: ParsedTest, id: number, tagPrefix: string): void {
  const raw = fs.readFileSync(test.filePath, 'utf8');
  const lines = raw.split('\n');
  const itLineIdx = test.line - 1;
  const newAnnotation = `{ type: '${tagPrefix}', description: '${id}' }`;
  const scanEnd = Math.min(itLineIdx + 25, lines.length);

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
      atomicWriteFileSync(test.filePath, lines.join('\n'));
      return;
    }
    if (inlineRevRe.test(lines[i])) {
      lines[i] = lines[i].replace(inlineRevRe, `$1${id}$2`);
      atomicWriteFileSync(test.filePath, lines.join('\n'));
      return;
    }
    if (i > itLineIdx && /^\s*async[\s(]/.test(lines[i])) break;
  }

  // 1C — multi-line: type: 'tc' on its own line, description on an adjacent line
  const typeLineRe = new RegExp(`^\\s*type\\s*:\\s*['"]${tagPrefix}['"]`);
  const descLineRe = /^(\s*description\s*:\s*['"])\d+(['"]\s*,?\s*)$/;

  for (let i = itLineIdx; i < scanEnd; i++) {
    if (typeLineRe.test(lines[i])) {
      for (const j of [i - 1, i + 1, i + 2]) {
        if (j >= 0 && j < lines.length && descLineRe.test(lines[j])) {
          lines[j] = lines[j].replace(descLineRe, `$1${id}$2`);
          atomicWriteFileSync(test.filePath, lines.join('\n'));
          return;
        }
      }
    }
    if (i > itLineIdx && /^\s*async[\s(]/.test(lines[i])) break;
  }

  // ── Phase 2 & 3: inject annotation into the test call ─────────────────────
  //
  // Only handles single-line test calls (most common Playwright style).
  // Multi-line calls fall through to the comment fallback.

  const itLine = lines[itLineIdx];

  // Quoted-title pattern — handles 'title', "title", `title`
  const titlePat = `(?:'[^']*'|"[^"]*"|\`[^\`]*\`)`;
  const fnPat    = `(?:it|test|xit|xtest|specify)(?:\\.(?:only|skip|concurrent|fixme|fail))?`;

  // Phase 3 — no options object, async or sync callback on the same line:
  //   test('title', async ({ page }) => {
  //   test('title', () => {
  //   → test('title', { annotation: { … } }, async ({ page }) => {
  //   → test('title', { annotation: { … } }, () => {
  const noOptsRe = new RegExp(
    `^(\\s*${fnPat}\\s*\\(\\s*${titlePat}\\s*,\\s*)(async[\\s(]|\\()`
  );
  const noOptsMatch = itLine.match(noOptsRe);
  if (noOptsMatch) {
    lines[itLineIdx] =
      noOptsMatch[1] +
      `{ annotation: ${newAnnotation} }, ` +
      noOptsMatch[2] +
      itLine.slice(noOptsMatch[0].length);
    atomicWriteFileSync(test.filePath, lines.join('\n'));
    return;
  }

  // Phase 2 — options object already present on the same line:
  //   test('title', { tag: '@smoke' }, async ...
  //   → test('title', { tag: '@smoke', annotation: { … } }, async ...
  const withOptsRe = new RegExp(
    `^(\\s*${fnPat}\\s*\\(\\s*${titlePat}\\s*,\\s*)(\\{)`
  );
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
      const after  = itLine.slice(braceEnd);
      const sep    = before.trimEnd().endsWith(',') ? ' ' : ', ';
      lines[itLineIdx] = `${before}${sep}annotation: ${newAnnotation}${after}`;
      atomicWriteFileSync(test.filePath, lines.join('\n'));
      return;
    }
  }

  // ── Phase 4: comment fallback ──────────────────────────────────────────────
  writebackJavaScript(test, id, tagPrefix);
}

// ─── TestCafe writeback ───────────────────────────────────────────────────────

/**
 * Write (or update) the TC ID in a TestCafe test file using the native
 * test.meta() API.
 *
 * Target format:
 *   test.meta('<tagPrefix>', 'N')('title', async t => { ... })
 *
 * Three-phase strategy:
 *  1. Update existing .meta('<tagPrefix>', 'OLD') — key-value form.
 *  2. Update existing .meta({ <tagPrefix>: 'OLD' }) — object form.
 *  3. Inject .meta('<tagPrefix>', 'N') — when no meta exists, transform
 *       test('title', fn)       →  test.meta('tc','N')('title', fn)
 *       test.skip('title', fn)  →  test.skip.meta('tc','N')('title', fn)
 *  4. Comment fallback — // @tc:N if none of the above apply.
 */
export function writebackTestCafe(test: ParsedTest, id: number, tagPrefix: string): void {
  const raw = fs.readFileSync(test.filePath, 'utf8');
  const lines = raw.split('\n');
  const testLineIdx = test.line - 1;
  const scanEnd = Math.min(testLineIdx + 8, lines.length);

  // ── Phase 1: update existing key-value meta: .meta('tc', 'OLD') ──────────
  const kvRe = new RegExp(
    `(\\.meta\\s*\\(\\s*['"]${tagPrefix}['"]\\s*,\\s*['"])\\d+(['"])`
  );
  for (let i = testLineIdx; i < scanEnd; i++) {
    if (kvRe.test(lines[i])) {
      lines[i] = lines[i].replace(kvRe, `$1${id}$2`);
      atomicWriteFileSync(test.filePath, lines.join('\n'));
      return;
    }
    if (i > testLineIdx && /^\s*async[\s(]/.test(lines[i])) break;
  }

  // ── Phase 2: update existing object meta: .meta({ tc: 'OLD', ... }) ──────
  const objRe = new RegExp(
    `(\\.meta\\s*\\(\\s*\\{[^}]*['"]?${tagPrefix}['"]?\\s*:\\s*['"])\\d+(['"][^}]*\\})`
  );
  for (let i = testLineIdx; i < scanEnd; i++) {
    if (objRe.test(lines[i])) {
      lines[i] = lines[i].replace(objRe, `$1${id}$2`);
      atomicWriteFileSync(test.filePath, lines.join('\n'));
      return;
    }
    if (i > testLineIdx && /^\s*async[\s(]/.test(lines[i])) break;
  }

  // ── Phase 3: inject .meta('tc', N) when no meta exists ───────────────────
  // Only inject when the test line has NO .meta( already (avoid double-meta).
  const testLine = lines[testLineIdx];
  const alreadyHasMeta = /\.meta\s*\(/.test(testLine);

  if (!alreadyHasMeta) {
    // Transform: test('title', ...)       → test.meta('tc','N')('title', ...)
    //            test.skip('title', ...)  → test.skip.meta('tc','N')('title', ...)
    const injected = testLine.replace(
      /^(\s*)(test(?:\.(?:skip|only))?)\s*\(/,
      `$1$2.meta('${tagPrefix}', '${id}')(`
    );
    if (injected !== testLine) {
      lines[testLineIdx] = injected;
      atomicWriteFileSync(test.filePath, lines.join('\n'));
      return;
    }
  }

  // ── Phase 4: comment fallback ──────────────────────────────────────────────
  writebackJavaScript(test, id, tagPrefix);
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

  atomicWriteFileSync(test.filePath, lines.join('\n'));
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

  atomicWriteFileSync(test.filePath, lines.join('\n'));
}

// ─── Robot Framework writeback ────────────────────────────────────────────────

/**
 * Write (or update) the TC ID in a Robot Framework .robot file.
 *
 * Strategy:
 *  1. Find the test case name line (test.line - 1, 0-based).
 *  2. Scan forward within the test body (up to 15 lines) for a [Tags] row.
 *  3. If found: replace existing tc:N tag in it, or append tc:ID.
 *  4. If not found: insert a new [Tags] row on the line after the test name.
 */
export function writebackRobot(test: ParsedTest, id: number, tagPrefix: string): void {
  const raw = fs.readFileSync(test.filePath, 'utf8');
  const lines = raw.split('\n');

  const testNameLineIdx = test.line - 1; // 0-based

  // Detect indentation from the first indented body line or default 4 spaces
  const indent = '    ';
  const tagToken  = `${tagPrefix}:${id}`;
  const existingRe = new RegExp(`\\b${tagPrefix}:\\d+\\b`, 'i');
  const tagsRowRe  = /^\s*\[tags\]/i;

  const scanEnd = Math.min(testNameLineIdx + 20, lines.length);
  let replaced = false;

  for (let i = testNameLineIdx + 1; i < scanEnd; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Next non-indented line = next test case → stop
    if (trimmed && !/^\s/.test(line)) break;

    if (tagsRowRe.test(trimmed)) {
      if (existingRe.test(trimmed)) {
        lines[i] = trimmed.replace(existingRe, tagToken);
      } else {
        // Append the new tag (with separator)
        lines[i] = `${trimmed}    ${tagToken}`;
      }
      replaced = true;
      break;
    }
  }

  if (!replaced) {
    // Insert [Tags] row immediately after the test name line
    lines.splice(testNameLineIdx + 1, 0, `${indent}[Tags]    ${tagToken}`);
  }

  atomicWriteFileSync(test.filePath, lines.join('\n'));
}

// ─── Ruby writeback ───────────────────────────────────────────────────────────

/**
 * Write (or update) the TC ID in a Ruby RSpec file.
 * Format:  # @tc:12345  inserted immediately above the it line.
 */
export function writebackRuby(test: ParsedTest, id: number, tagPrefix: string): void {
  const raw = fs.readFileSync(test.filePath, 'utf8');
  const lines = raw.split('\n');

  const itLineIdx = test.line - 1; // 0-based

  const indentMatch = (lines[itLineIdx] ?? '').match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : '';

  const comment    = `# @${tagPrefix}:${id}`;
  const existingRe = new RegExp(`#\\s*@${tagPrefix}:\\d+`);

  let replaced = false;
  for (let i = itLineIdx - 1; i >= 0 && i >= itLineIdx - 25; i--) {
    const trimmed = lines[i].trim();

    if (existingRe.test(trimmed)) {
      lines[i] = lines[i].replace(existingRe, comment.trim());
      replaced = true;
      break;
    }

    if (trimmed === '') break;
  }

  if (!replaced) {
    lines.splice(itLineIdx, 0, `${indent}${comment}`);
  }

  atomicWriteFileSync(test.filePath, lines.join('\n'));
}

// ─── PHP writeback ────────────────────────────────────────────────────────────

/**
 * Write (or update) the TC ID in a PHP PHPUnit file.
 * Format:  * @tc N  inside the docblock above the method.
 * If no docblock exists, inserts one.
 */
export function writebackPhp(test: ParsedTest, id: number, tagPrefix: string): void {
  const raw = fs.readFileSync(test.filePath, 'utf8');
  const lines = raw.split('\n');

  const methodLineIdx = test.line - 1; // 0-based

  const indentMatch = (lines[methodLineIdx] ?? '').match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : '    ';

  const existingRe = new RegExp(`@${tagPrefix}\\s+\\d+`);
  const newAnnotation = `@${tagPrefix} ${id}`;

  // Find end of docblock (*/), scanning backward
  let docEnd = -1;
  for (let i = methodLineIdx - 1; i >= 0 && i >= methodLineIdx - 5; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === '') continue;
    if (trimmed.endsWith('*/')) { docEnd = i; break; }
    // Attributes / annotations between doc and method are fine
    if (trimmed.startsWith('#[') || trimmed.startsWith('@')) continue;
    break;
  }

  if (docEnd >= 0) {
    // Walk backward to find docblock start and check for existing @tc
    for (let i = docEnd - 1; i >= 0 && i >= docEnd - 50; i--) {
      const trimmed = lines[i].trim();
      if (existingRe.test(trimmed)) {
        lines[i] = lines[i].replace(existingRe, newAnnotation);
        atomicWriteFileSync(test.filePath, lines.join('\n'));
        return;
      }
      if (trimmed.startsWith('/**') || trimmed === '/*') { break; }
    }

    // No existing @tc — insert before closing */
    lines.splice(docEnd, 0, `${indent} * ${newAnnotation}`);
  } else {
    // No docblock — insert one above the method
    lines.splice(methodLineIdx, 0,
      `${indent}/**`,
      `${indent} * ${newAnnotation}`,
      `${indent} */`
    );
  }

  atomicWriteFileSync(test.filePath, lines.join('\n'));
}

// ─── Rust writeback ───────────────────────────────────────────────────────────

/**
 * Write (or update) the TC ID in a Rust file.
 * Format:  // @tc:12345  inserted immediately above the #[test] line.
 */
export function writebackRust(test: ParsedTest, id: number, tagPrefix: string): void {
  const raw = fs.readFileSync(test.filePath, 'utf8');
  const lines = raw.split('\n');

  const attrLineIdx = test.line - 1; // 0-based — points at #[test]

  const indentMatch = (lines[attrLineIdx] ?? '').match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : '';

  const comment    = `// @${tagPrefix}:${id}`;
  const existingRe = new RegExp(`//\\s*@${tagPrefix}:\\d+`);

  // Scan backward for existing annotation (may be within doc comments above #[test])
  let replaced = false;
  for (let i = attrLineIdx - 1; i >= 0 && i >= attrLineIdx - 20; i--) {
    const trimmed = lines[i].trim();

    if (existingRe.test(trimmed)) {
      lines[i] = lines[i].replace(existingRe, comment.trim());
      replaced = true;
      break;
    }

    if (trimmed === '') break;
  }

  if (!replaced) {
    lines.splice(attrLineIdx, 0, `${indent}${comment}`);
  }

  atomicWriteFileSync(test.filePath, lines.join('\n'));
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export async function writebackId(
  test: ParsedTest,
  id: number,
  localType: 'gherkin' | 'reqnroll' | 'markdown' | 'csv' | 'excel' | 'csharp' | 'java' | 'python' | 'javascript' | 'playwright' | 'puppeteer' | 'cypress' | 'testcafe' | 'detox' | 'espresso' | 'xcuitest' | 'flutter' | 'robot' | 'go' | 'rspec' | 'phpunit' | 'rust' | 'kotlin',
  tagPrefix: string
): Promise<void> {
  switch (localType) {
    case 'gherkin':
    case 'reqnroll':
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
    case 'espresso':
    case 'kotlin':
      writebackJava(test, id, tagPrefix);
      break;
    case 'python':
      writebackPython(test, id, tagPrefix);
      break;
    case 'playwright':
      writebackPlaywright(test, id, tagPrefix);
      break;
    case 'testcafe':
      writebackTestCafe(test, id, tagPrefix);
      break;
    case 'javascript':
    case 'puppeteer':
    case 'cypress':
    case 'detox':
    case 'xcuitest':
    case 'flutter':
    case 'go':
      writebackJavaScript(test, id, tagPrefix);
      break;
    case 'robot':
      writebackRobot(test, id, tagPrefix);
      break;
    case 'rspec':
      writebackRuby(test, id, tagPrefix);
      break;
    case 'phpunit':
      writebackPhp(test, id, tagPrefix);
      break;
    case 'rust':
      writebackRust(test, id, tagPrefix);
      break;
  }
}

// ─── JSDoc doc-comment writeback ──────────────────────────────────────────────

/**
 * Write (or update) a JSDoc comment immediately above the test() / it() line
 * in a JavaScript/TypeScript file with the AI-generated title, description,
 * and steps.
 *
 * Format written:
 *   /**
 *    * <title>
 *    * Description: <description>    ← only when description is non-empty
 *    * 1. <action step>
 *    * 2. Check: <expected result>
 *    * /
 *
 * On the next push the JavaScript parser reads this JSDoc block back, so
 * test.steps.length > 0 and test.description is populated — AI is not
 * re-invoked and the steps remain stable.
 *
 * Strategy:
 *  1. Find test.line (1-based) — the it()/test() call.
 *  2. Walk backward to find an existing /** … *‌/ block (skipping blank lines
 *     and // single-line comments), and remove it entirely.
 *  3. Build the new JSDoc lines.
 *  4. Insert the JSDoc immediately above the test() line, matching indentation.
 */
export function writebackDocComment(
  test: ParsedTest,
  title: string,
  description: string | undefined,
  steps: ParsedStep[]
): void {
  const raw   = fs.readFileSync(test.filePath, 'utf8');
  const lines = raw.split('\n');

  const itLineIdx = test.line - 1; // 0-based

  // ── Step 1: detect and remove any existing JSDoc block above the test ───────

  let insertAt = itLineIdx; // default: insert right before the test line

  // Walk backward past blank lines and // comments to find a closing */
  let i = itLineIdx - 1;
  while (i >= 0) {
    const t = lines[i].trim();
    if (t === '' || t.startsWith('//')) { i--; continue; }
    break;
  }

  if (i >= 0 && lines[i].trim().endsWith('*/')) {
    // Found a block comment ending — locate its opening /**
    const closeIdx = i;
    let openIdx    = i;
    while (openIdx >= 0 && !lines[openIdx].trim().startsWith('/**')) openIdx--;

    if (openIdx >= 0) {
      const blockLines = lines
        .slice(openIdx, closeIdx + 1)
        .map((line) =>
          line
            .replace(/^\s*\/\*\*\s?/, '')
            .replace(/\s*\*\/\s*$/, '')
            .replace(/^\s*\*\s?/, '')
            .trim()
        );
      // Only replace ado-sync-managed blocks; leave user-authored JSDoc intact.
      if (blockLines.some((line) => line === 'ado-sync:ai-summary')) {
        lines.splice(openIdx, closeIdx - openIdx + 1);
        insertAt = openIdx; // insert the new block at the same position
      }
    }
  }

  // ── Step 2: build new JSDoc lines ─────────────────────────────────────────

  const indentMatch = (lines[insertAt] ?? '').match(/^(\s*)/);
  const indent      = indentMatch ? indentMatch[1] : '';

  const docLines: string[] = [];
  docLines.push(`${indent}/**`);
  docLines.push(`${indent} * ado-sync:ai-summary`);
  docLines.push(`${indent} * ${title}`);
  if (description) {
    docLines.push(`${indent} * Description: ${description}`);
  }

  let stepNum = 1;
  for (const step of steps) {
    if (step.keyword === 'Then') {
      docLines.push(`${indent} * ${stepNum}. Check: ${step.text}`);
    } else {
      docLines.push(`${indent} * ${stepNum}. ${step.text}`);
    }
    stepNum++;
  }

  docLines.push(`${indent} */`);

  // ── Step 3: splice the new block in ───────────────────────────────────────

  lines.splice(insertAt, 0, ...docLines);
  atomicWriteFileSync(test.filePath, lines.join('\n'));
}
