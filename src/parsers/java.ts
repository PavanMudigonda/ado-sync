/**
 * Java test parser for azure-test-sync.
 *
 * Supports JUnit 4, JUnit 5 (Jupiter), and TestNG frameworks:
 *
 *   Framework  Test marker  Tag / group attr
 *   ─────────  ───────────  ────────────────
 *   JUnit 4    @Test        @Category({Smoke.class, Regression.class})
 *   JUnit 5    @Test        @Tag("smoke")
 *   TestNG     @Test        @Test(groups = {"smoke"}) or @Test(groups = "smoke")
 *
 * Source mapping:
 *   Javadoc /** ... * / first non-numbered line    → TC Title
 *   Numbered lines "N. text"                       → TC Steps (action)
 *   "N. Check: text"                               → TC Steps (expected result column)
 *   @Tag("name")                                   → TC Tags (JUnit 5)
 *   @Category({Smoke.class})                       → TC Tags (JUnit 4)
 *   @Test(groups = {"smoke"})                      → TC Tags (TestNG)
 *   @Test(description = "...")                     → TC Title fallback (TestNG)
 *   @Tag("tc:N")  in the annotation block          → Azure TC ID (JUnit 5)
 *   // @tc:N  comment above @Test                  → Azure TC ID (JUnit 4 / TestNG / fallback)
 *   package.ClassName.methodName                   → automatedTestName
 *
 * ID writeback:
 *   JUnit 5  →  @Tag("tc:12345")  inserted/updated in the annotation block above @Test.
 *               No extra dependency — @Tag is part of junit-jupiter-api.
 *   JUnit 4  →  // @tc:12345  comment inserted/updated immediately above @Test.
 *   TestNG   →  // @tc:12345  comment inserted/updated immediately above @Test.
 *               Note: @Test(tc="...") is NOT valid TestNG syntax; @Test has no such attribute.
 *
 * Path-based auto-tagging: directory segments starting with '@' become tags.
 */

import * as fs from 'fs';

import { LinkConfig, ParsedStep, ParsedTest } from '../types';
import { extractLinkRefs, extractPathTags } from './shared';

// ─── Framework detection ──────────────────────────────────────────────────────

export type JavaTestFramework = 'junit5' | 'junit4' | 'testng' | 'unknown';

/**
 * Detect the test framework from import statements.
 * Returns 'junit5' when org.junit.jupiter imports are present.
 */
export function detectJavaFramework(lines: string[]): JavaTestFramework {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('import org.junit.jupiter.')) return 'junit5';
    if (trimmed.startsWith('import org.testng.')) return 'testng';
    if (trimmed.startsWith('import org.junit.Test') || trimmed.startsWith('import org.junit.runner.')) return 'junit4';
  }
  return 'unknown';
}

// ─── Package / class extraction ───────────────────────────────────────────────

function extractPackage(lines: string[]): string {
  for (const line of lines) {
    const m = line.match(/^\s*package\s+([\w.]+)\s*;/);
    if (m) return m[1];
  }
  return '';
}

function extractClassName(lines: string[]): string {
  for (const line of lines) {
    const m = line.match(/^\s*(?:(?:public|protected|private|abstract|final)\s+)*class\s+(\w+)/);
    if (m) return m[1];
  }
  return '';
}

// ─── @Test annotation detection ───────────────────────────────────────────────

/**
 * Returns true when the trimmed line is a @Test annotation.
 * Matches  @Test  and  @Test(...)  but not @TestFactory / @TestTemplate.
 */
function isTestAnnotation(trimmedLine: string): boolean {
  return /^@Test(?:$|\s*\()/.test(trimmedLine);
}

// ─── Javadoc extraction ───────────────────────────────────────────────────────

/**
 * Walk backward from testLineIdx to find a Javadoc comment (/** ... * /).
 * Skips blank lines, // comments, and @annotation lines.
 */
function extractJavadocBefore(lines: string[], testLineIdx: number): string[] {
  let i = testLineIdx - 1;

  while (i >= 0) {
    const t = lines[i].trim();
    if (t === '' || t.startsWith('//') || (t.startsWith('@') && !t.endsWith('*/'))) {
      i--;
      continue;
    }
    break;
  }

  if (i < 0 || !lines[i].trim().endsWith('*/')) return [];

  const raw: string[] = [];
  raw.unshift(lines[i]);
  i--;
  while (i >= 0) {
    raw.unshift(lines[i]);
    if (lines[i].trim().startsWith('/**')) break;
    i--;
  }

  return raw
    .map((l) =>
      l
        .replace(/^\s*\/\*\*\s?/, '')
        .replace(/\s*\*\/\s*$/, '')
        .replace(/^\s*\*\s?/, '')
        .trim()
    )
    .filter((l) => l !== '');
}

// ─── TC ID extraction — @Tag (JUnit 5) + comment fallback ─────────────────────

/**
 * Scan above the @Test line (up to 25 lines) for a TC ID stored as either:
 *   @Tag("{tagPrefix}:N")   — JUnit 5 style
 *   // @{tagPrefix}:N       — comment style (JUnit 4 / TestNG)
 *
 * Stops at a closing brace or class declaration.
 */
function extractTcIdAbove(lines: string[], testLineIdx: number, tagPrefix: string): number | undefined {
  const tagRe  = new RegExp(`^@Tag\\(\\s*"${tagPrefix}:(\\d+)"\\s*\\)$`);
  const cmmtRe = new RegExp(`//\\s*@${tagPrefix}:(\\d+)`);

  for (let i = testLineIdx - 1; i >= 0 && i >= testLineIdx - 25; i--) {
    const trimmed = lines[i].trim();

    const tagMatch = trimmed.match(tagRe);
    if (tagMatch) return parseInt(tagMatch[1], 10);

    const cmtMatch = trimmed.match(cmmtRe);
    if (cmtMatch) return parseInt(cmtMatch[1], 10);

    if (trimmed === '}' || /^\s*(?:(?:public|protected|private|abstract|final)\s+)*class\s+/.test(trimmed)) break;
  }
  return undefined;
}

// ─── @Test attribute extraction (TestNG groups / description) ─────────────────

interface TestAnnotationAttrs {
  groups: string[];
  description: string;
}

function parseTestAnnotationAttrs(testLine: string): TestAnnotationAttrs {
  const groups: string[] = [];
  let description = '';

  const multiGroupMatch = testLine.match(/\bgroups\s*=\s*\{([^}]*)\}/);
  if (multiGroupMatch) {
    const literals = multiGroupMatch[1].match(/"([^"]+)"/g);
    if (literals) groups.push(...literals.map((g) => g.replace(/"/g, '')));
  } else {
    const singleGroupMatch = testLine.match(/\bgroups\s*=\s*"([^"]+)"/);
    if (singleGroupMatch) groups.push(singleGroupMatch[1]);
  }

  const descMatch = testLine.match(/\bdescription\s*=\s*"([^"]+)"/);
  if (descMatch) description = descMatch[1];

  return { groups, description };
}

// ─── Forward scan: annotations + method signature ─────────────────────────────

const JAVA_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'super', 'this', 'new', 'return', 'throw',
  'instanceof', 'assert', 'synchronized',
]);

interface MethodInfo {
  methodName: string;
  /** All @Tag values found below @Test (includes potential "tc:N" ID tags). */
  tagValues: string[];
  endLine: number;
}

function extractMethodInfo(lines: string[], testLineIdx: number): MethodInfo {
  const tagValues: string[] = [];
  let methodName = '';
  let endLine = testLineIdx;

  // TestNG groups on the @Test line itself
  const { groups } = parseTestAnnotationAttrs(lines[testLineIdx] ?? '');
  // Groups are handled separately; don't put them in tagValues

  for (let i = testLineIdx + 1; i < lines.length && i < testLineIdx + 30; i++) {
    const trimmed = lines[i].trim();
    endLine = i;

    // @Tag("value") — JUnit 5  (includes potential tc:N ID tags)
    const tagMatch = trimmed.match(/^@Tag\(\s*"([^"]+)"\s*\)/);
    if (tagMatch) { tagValues.push(tagMatch[1]); continue; }

    // @Category({Smoke.class, Reg.class}) — JUnit 4
    const multiCatMatch = trimmed.match(/^@Category\(\s*\{([^}]*)\}\s*\)/);
    if (multiCatMatch) {
      const classRefs = multiCatMatch[1].match(/(\w+)\.class/g);
      if (classRefs) tagValues.push(...classRefs.map((c) => c.replace('.class', '')));
      continue;
    }

    // @Category(Smoke.class) — single
    const singleCatMatch = trimmed.match(/^@Category\(\s*(\w+)\.class\s*\)/);
    if (singleCatMatch) { tagValues.push(singleCatMatch[1]); continue; }

    // Other @Annotation — skip (e.g. @DisplayName, @Timeout, @AzureTestCase)
    if (trimmed.startsWith('@')) continue;

    // Blank / comment interior
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    // Method signature: first word before ( that is not a keyword
    if (trimmed.includes('(')) {
      const m = trimmed.match(/(\w+)\s*\(/);
      if (m && !JAVA_KEYWORDS.has(m[1])) {
        methodName = m[1];
        break;
      }
    }

    if (trimmed === '{') break;
  }

  return { methodName, tagValues, endLine };
}

// ─── Javadoc → title + steps ──────────────────────────────────────────────────

const NUMBERED_STEP_RE = /^\d+\.\s+(.+)$/;
const CHECK_RE = /^[Cc]heck:\s+(.+)$/;
const META_RE = /^(?:test\s+case|user\s+story)[\s:]/i;

function parseSummary(
  summaryLines: string[],
  methodName: string,
  descriptionFallback: string
): { title: string; steps: ParsedStep[] } {
  let title = '';
  const steps: ParsedStep[] = [];

  for (const line of summaryLines) {
    if (!line || META_RE.test(line)) continue;

    const numMatch = NUMBERED_STEP_RE.exec(line);
    if (numMatch) {
      const content = numMatch[1].trim();
      const checkMatch = CHECK_RE.exec(content);
      if (checkMatch) {
        steps.push({ keyword: 'Then', text: checkMatch[1].trim() });
      } else {
        steps.push({ keyword: 'Step', text: content });
      }
      continue;
    }

    if (!title) title = line;
  }

  if (!title) {
    title = descriptionFallback || methodName.replace(/([A-Z])/g, ' $1').trim();
  }

  return { title, steps };
}

// ─── Public parser ────────────────────────────────────────────────────────────

export function parseJavaFile(
  filePath: string,
  tagPrefix: string,
  linkConfigs?: LinkConfig[]
): ParsedTest[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const lines = source.split('\n');

  const pkg = extractPackage(lines);
  const className = extractClassName(lines);
  const pathTags = extractPathTags(filePath);

  // ID tag regex: matches e.g. "tc:12345" inside a @Tag value
  const idTagValueRe = new RegExp(`^${tagPrefix}:(\\d+)$`);

  const results: ParsedTest[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!isTestAnnotation(trimmed)) continue;

    const testAnnotationLineIdx = i;

    const summaryLines = extractJavadocBefore(lines, testAnnotationLineIdx);
    const { description: testNgDescription, groups: testNgGroups } = parseTestAnnotationAttrs(
      lines[testAnnotationLineIdx] ?? ''
    );
    const { methodName, tagValues, endLine } = extractMethodInfo(lines, testAnnotationLineIdx);

    if (!methodName) {
      i = endLine;
      continue;
    }

    // Separate tc-ID tags from regular @Tag values (JUnit 5)
    let azureId: number | undefined;
    const regularTagValues: string[] = [];
    for (const tv of tagValues) {
      const m = tv.match(idTagValueRe);
      if (m && azureId === undefined) {
        azureId = parseInt(m[1], 10);
      } else {
        regularTagValues.push(tv);
      }
    }

    // Fallback: look for ID above @Test (@Tag or comment)
    if (azureId === undefined) {
      azureId = extractTcIdAbove(lines, testAnnotationLineIdx, tagPrefix);
    }

    const allTags = [...new Set([...pathTags, ...regularTagValues, ...testNgGroups])];
    const { title, steps } = parseSummary(summaryLines, methodName, testNgDescription);
    const fqmn = [pkg, className, methodName].filter(Boolean).join('.');

    results.push({
      filePath,
      title,
      steps,
      tags: allTags,
      azureId: azureId !== undefined && !isNaN(azureId) ? azureId : undefined,
      line: testAnnotationLineIdx + 1, // 1-based; writeback targets this @Test line
      linkRefs: extractLinkRefs(allTags, linkConfigs),
      automatedTestName: fqmn || undefined,
    });

    i = endLine;
  }

  return results;
}
