/**
 * JavaScript / TypeScript test parser for azure-test-sync.
 *
 * Supports Jest, Jasmine, WebdriverIO, Playwright Test, Puppeteer (Mocha/Jest),
 * and Cypress. All frameworks share the same describe() / it() / test() API for
 * test organisation, so a single parser handles all of them.
 *
 * Cucumber (.feature files) is already handled by the existing 'gherkin' type.
 * TestCafe uses a fixture/test API and is handled by the separate 'testcafe' type.
 *
 * Detected test functions:
 *   it(title, fn)                    test(title, fn)
 *   it.only / test.only              it.skip / test.skip
 *   xit / xtest                      (Jasmine skip — still synced to Azure)
 *   it.concurrent / test.concurrent
 *   test.fixme(title, fn)            (Playwright — annotates test as fixme)
 *   test.fail(title, fn)             (Playwright — marks test as expected to fail)
 *   specify(title, fn)               specify.only / specify.skip  (Cypress alias for it)
 *
 * Detected describe functions (for nesting):
 *   describe()  describe.only()  describe.skip()  describe.concurrent()
 *   test.describe()              (Playwright)
 *   test.describe.only()         test.describe.skip()
 *   test.describe.parallel()     test.describe.serial()
 *   context()  context.only()  context.skip()  (Cypress alias for describe)
 *
 * Source mapping:
 *   JSDoc /** ... * / first non-numbered line    → TC Title
 *   Numbered lines "N. text"                     → TC Steps (action)
 *   "N. Check: text"                             → TC Steps (expected result column)
 *   // @tags: smoke, regression                  → TC Tags (comma-separated list)
 *   // @smoke                                    → TC Tag (single-word shorthand)
 *   // @{tagPrefix}:N  comment above it()/test() → Azure TC ID (written back after push)
 *   {fileBasename} > {describe} > {it title}     → automatedTestName (Jest report format)
 *
 * ID writeback:
 *   Inserts / updates  // @tc:12345  immediately above the it() / test() line.
 *   No extra dependency required.
 *
 * Path-based auto-tagging: directory segments starting with '@' become tags.
 */

import * as fs from 'fs';
import * as path from 'path';

import { LinkConfig, ParsedStep, ParsedTest } from '../types';
import { extractLinkRefs, extractPathTags } from './shared';

// ─── Test function detection ──────────────────────────────────────────────────

const TEST_FN_PREFIX =
  '(?:it|test|xit|xtest|specify|it\\.only|test\\.only|specify\\.only|it\\.skip|test\\.skip|specify\\.skip|it\\.concurrent|test\\.concurrent|test\\.fixme|test\\.fail)';

const TEST_CALL_RE      = new RegExp(`^${TEST_FN_PREFIX}\\s*\\(`);
const TEST_TITLE_RE     = new RegExp(
  `^${TEST_FN_PREFIX}\\s*\\(\\s*(['"\`])((?:\\\\.|[^\\\\])*?)\\1`
);
// context() and context.only/skip are Cypress aliases for describe()
const DESCRIBE_TITLE_RE =
  /^(?:describe(?:\.(?:only|skip|concurrent))?|context(?:\.(?:only|skip))?|test\.describe(?:\.(?:only|skip|parallel|serial|configure))?)\s*\(\s*(['"`])((?:\\.|[^\\])*?)\1/;

function isTestLine(trimmedLine: string): boolean {
  return TEST_CALL_RE.test(trimmedLine);
}

/** Extract the literal string passed as the first argument of it() / test(). */
function extractTestCallTitle(trimmedLine: string): string {
  const m = trimmedLine.match(TEST_TITLE_RE);
  if (!m) return '';
  return m[2]
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\`/g, '`')
    .replace(/\\\\/g, '\\');
}

// ─── Indentation helpers ──────────────────────────────────────────────────────

function getIndentLength(line: string): number {
  return (line.match(/^(\s*)/) ?? ['', ''])[1].length;
}

// ─── Enclosing describe blocks ────────────────────────────────────────────────

/**
 * Walk backward from the it()/test() line to collect enclosing describe() titles,
 * outermost first.  Uses indentation to identify nesting levels.
 */
function findEnclosingDescribes(lines: string[], itLineIdx: number): string[] {
  const describes: string[] = [];
  let targetIndent = getIndentLength(lines[itLineIdx]);

  for (let i = itLineIdx - 1; i >= 0; i--) {
    const line    = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    const lineIndent = getIndentLength(line);
    if (lineIndent < targetIndent) {
      const m = trimmed.match(DESCRIBE_TITLE_RE);
      if (m) {
        describes.unshift(
          m[2].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\`/g, '`')
        );
        targetIndent = lineIndent;
      }
    }
  }

  return describes;
}

// ─── JSDoc extraction ─────────────────────────────────────────────────────────

/**
 * Walk backward from the it()/test() line to find a JSDoc comment (/** ... * /).
 * Skips blank lines and // single-line comment lines on the way.
 */
function extractJsdocBefore(lines: string[], itLineIdx: number): string[] {
  let i = itLineIdx - 1;

  while (i >= 0) {
    const t = lines[i].trim();
    if (t === '' || t.startsWith('//')) { i--; continue; }
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

// ─── TC ID and tags from comments above the test ──────────────────────────────

interface CommentMetadata {
  azureId?: number;
  tags: string[];
}

/**
 * Scan the comment block immediately above the it()/test() line for:
 *   // @tc:12345          → Azure TC ID
 *   // @tags: a, b, c    → tag list (comma-separated)
 *   // @smoke             → single-word tag shorthand
 *
 * Stops at blank lines (the comment block must be adjacent to the test).
 */
function extractCommentMetadataAbove(
  lines: string[],
  itLineIdx: number,
  tagPrefix: string
): CommentMetadata {
  const tags: string[] = [];
  let azureId: number | undefined;

  const idRe      = new RegExp(`//\\s*@${tagPrefix}:(\\d+)`);
  const tagsListRe = /\/\/\s*@tags?\s*:\s*(.+)/i;
  const singleTagRe = /\/\/\s*@(\w+)\s*$/;

  for (let i = itLineIdx - 1; i >= 0 && i >= itLineIdx - 25; i--) {
    const trimmed = lines[i].trim();

    // Stop at blank lines — metadata must be adjacent
    if (trimmed === '') break;

    // Stop at lines that are clearly not comments
    if (!trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')) break;

    // ID comment
    const idMatch = trimmed.match(idRe);
    if (idMatch && azureId === undefined) {
      azureId = parseInt(idMatch[1], 10);
      continue;
    }

    // Tags list: // @tags: smoke, regression
    const tagsMatch = trimmed.match(tagsListRe);
    if (tagsMatch) {
      tags.push(...tagsMatch[1].split(',').map((t) => t.trim()).filter(Boolean));
      continue;
    }

    // Single tag shorthand: // @smoke
    const singleTag = trimmed.match(singleTagRe);
    if (singleTag && singleTag[1] !== tagPrefix) {
      tags.push(singleTag[1]);
      continue;
    }
  }

  return { azureId, tags };
}

// ─── JSDoc → title + steps ────────────────────────────────────────────────────

const NUMBERED_STEP_RE = /^\d+\.\s+(.+)$/;
const CHECK_RE         = /^[Cc]heck:\s+(.+)$/;
const META_RE          = /^(?:test\s+case|user\s+story)[\s:]/i;

function parseSummary(
  jsdocLines: string[],
  fallbackTitle: string
): { title: string; steps: ParsedStep[] } {
  let title = '';
  const steps: ParsedStep[] = [];

  for (const line of jsdocLines) {
    if (!line || META_RE.test(line)) continue;

    const numMatch = NUMBERED_STEP_RE.exec(line);
    if (numMatch) {
      const content   = numMatch[1].trim();
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

  return { title: title || fallbackTitle, steps };
}

// ─── Public parser ────────────────────────────────────────────────────────────

export function parseJavaScriptFile(
  filePath: string,
  tagPrefix: string,
  linkConfigs?: LinkConfig[]
): ParsedTest[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const lines  = source.split('\n');

  // Strip .spec.ts / .test.js / .js / .ts suffixes for a clean base name
  const fileBaseName = path.basename(filePath)
    .replace(/\.(spec|test)\.(js|ts|mjs|cjs)$/, '')
    .replace(/\.(js|ts|mjs|cjs)$/, '');

  const pathTags = extractPathTags(filePath);
  const results: ParsedTest[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!isTestLine(trimmed)) continue;

    const itLineIdx = i;
    const callTitle = extractTestCallTitle(trimmed);

    // Skip dynamic titles (e.g. template expressions) that we can't resolve
    if (!callTitle) continue;

    const jsdocLines              = extractJsdocBefore(lines, itLineIdx);
    const { azureId, tags: cTags } = extractCommentMetadataAbove(lines, itLineIdx, tagPrefix);
    const describes               = findEnclosingDescribes(lines, itLineIdx);

    const allTags = [...new Set([...pathTags, ...cTags])];
    const { title, steps } = parseSummary(jsdocLines, callTitle);

    // automatedTestName mirrors Jest's built-in test-result path format
    const automatedTestName = [fileBaseName, ...describes, callTitle].join(' > ');

    results.push({
      filePath,
      title,
      steps,
      tags: allTags,
      azureId: azureId !== undefined && !isNaN(azureId) ? azureId : undefined,
      line: itLineIdx + 1, // 1-based; writeback targets this it()/test() line
      linkRefs: extractLinkRefs(allTags, linkConfigs),
      automatedTestName,
    });
  }

  return results;
}
