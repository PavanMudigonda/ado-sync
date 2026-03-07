/**
 * Swift / XCUITest parser for azure-test-sync.
 *
 * Handles iOS and macOS UI-automation tests written with Apple's XCTest framework.
 * Tests are `func test*()` methods inside classes that extend `XCTestCase`.
 *
 * Detected test functions:
 *   func testUserCanLogin() { ... }
 *   func test_login_succeeds() { ... }
 *
 * Detected class blocks (used as the test group / describe equivalent):
 *   class LoginTests: XCTestCase { ... }
 *
 * Source mapping:
 *   /// Swift doc comment above func test*        → TC Title (first non-numbered line)
 *   JSDoc /** ... * / doc comment above func test* → TC Title + Steps (same format)
 *   Numbered lines "N. text"                → TC Steps (action)
 *   "N. Check: text"                        → TC Steps (expected result column)
 *   // @tags: smoke, regression             → TC Tags (comma-separated list)
 *   // @smoke                               → TC Tag (single-word shorthand)
 *   // @{tagPrefix}:N  comment above func   → Azure TC ID (written back after push)
 *   {fileBasename} > {ClassName} > {method} → automatedTestName
 *
 * Method name → title fallback:
 *   "testUserCanLogin" → "User can login"
 *   "test_submit_form" → "Submit form"
 *
 * ID writeback:
 *   Inserts / updates  // @tc:12345  immediately above the func test*() line.
 *
 * Path-based auto-tagging: directory segments starting with '@' become tags.
 */

import * as fs from 'fs';
import * as path from 'path';

import { LinkConfig, ParsedStep, ParsedTest } from '../types';
import { extractLinkRefs, extractPathTags } from './shared';

// ─── Test method detection ────────────────────────────────────────────────────

const TEST_METHOD_RE = /^\s*func\s+(test\w+)\s*\(/;
const CLASS_RE = /^\s*(?:(?:open|final|public|internal|private)\s+)*class\s+(\w+)\s*(?::\s*[\w, ]+)?/;

// ─── Indentation helpers ──────────────────────────────────────────────────────

function getIndentLength(line: string): number {
  return (line.match(/^(\s*)/) ?? ['', ''])[1].length;
}

// ─── Enclosing class ──────────────────────────────────────────────────────────

function findEnclosingClass(lines: string[], methodLineIdx: number): string | undefined {
  const methodIndent = getIndentLength(lines[methodLineIdx]);

  for (let i = methodLineIdx - 1; i >= 0; i--) {
    const lineIndent = getIndentLength(lines[i]);
    if (lineIndent < methodIndent) {
      const m = lines[i].trim().match(CLASS_RE);
      if (m) return m[1];
    }
  }

  return undefined;
}

// ─── Doc comment extraction ───────────────────────────────────────────────────

/**
 * Extract Swift doc comments above func test*().
 * Handles both triple-slash (///) single-line and block (/* * /) style.
 * Skips blank lines and single-line // comments on the way up.
 */
function extractDocBefore(lines: string[], methodLineIdx: number): string[] {
  let i = methodLineIdx - 1;

  // Skip blank lines and non-doc single-line comments
  while (i >= 0) {
    const t = lines[i].trim();
    if (t === '' || (t.startsWith('//') && !t.startsWith('///'))) { i--; continue; }
    break;
  }

  if (i < 0) return [];

  // /// triple-slash style (Swift idiomatic)
  if (lines[i].trim().startsWith('///')) {
    const docLines: string[] = [];
    while (i >= 0 && lines[i].trim().startsWith('///')) {
      docLines.unshift(lines[i].trim().replace(/^\/\/\/\s?/, ''));
      i--;
    }
    return docLines.filter((l) => l !== '');
  }

  // /** ... */ block style
  if (!lines[i].trim().endsWith('*/')) return [];

  const raw: string[] = [];
  raw.unshift(lines[i]);
  i--;
  while (i >= 0) {
    raw.unshift(lines[i]);
    if (lines[i].trim().startsWith('/**') || lines[i].trim().startsWith('/*')) break;
    i--;
  }

  return raw
    .map((l) =>
      l
        .replace(/^\s*\/\*\*?\s?/, '')
        .replace(/\s*\*\/\s*$/, '')
        .replace(/^\s*\*\s?/, '')
        .trim()
    )
    .filter((l) => l !== '');
}

// ─── TC ID and tags from comments above the func ──────────────────────────────

interface CommentMetadata {
  azureId?: number;
  tags: string[];
}

function extractCommentMetadataAbove(
  lines: string[],
  methodLineIdx: number,
  tagPrefix: string
): CommentMetadata {
  const tags: string[] = [];
  let azureId: number | undefined;

  const idRe       = new RegExp(`//\\s*@${tagPrefix}:(\\d+)`);
  const tagsListRe = /\/\/\s*@tags?\s*:\s*(.+)/i;
  const singleTagRe = /\/\/\s*@(\w+)\s*$/;

  for (let i = methodLineIdx - 1; i >= 0 && i >= methodLineIdx - 25; i--) {
    const trimmed = lines[i].trim();

    if (trimmed === '') break;
    if (!trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')) break;

    const idMatch = trimmed.match(idRe);
    if (idMatch && azureId === undefined) {
      azureId = parseInt(idMatch[1], 10);
      continue;
    }

    const tagsMatch = trimmed.match(tagsListRe);
    if (tagsMatch) {
      tags.push(...tagsMatch[1].split(',').map((t) => t.trim()).filter(Boolean));
      continue;
    }

    const singleTag = trimmed.match(singleTagRe);
    if (singleTag && singleTag[1] !== tagPrefix) {
      tags.push(singleTag[1]);
      continue;
    }
  }

  return { azureId, tags };
}

// ─── Method name → human-readable title ──────────────────────────────────────

/**
 * Convert a Swift test method name to a sentence-style title.
 *   testUserCanLogin         → "User can login"
 *   testLoginFails_badPassword → "Login fails bad password"
 *   test_submit_form         → "Submit form"
 */
function methodNameToTitle(name: string): string {
  let s = name.replace(/^test_?/, '');
  if (!s) return name;
  // snake_case → words
  s = s.replace(/_/g, ' ');
  // camelCase → words
  s = s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  s = s.toLowerCase().replace(/^./, (c) => c.toUpperCase());
  return s;
}

// ─── Doc → title + steps ─────────────────────────────────────────────────────

const NUMBERED_STEP_RE = /^\d+\.\s+(.+)$/;
const CHECK_RE         = /^[Cc]heck:\s+(.+)$/;
const META_RE          = /^(?:test\s+case|user\s+story)[\s:]/i;

function parseSummary(
  docLines: string[],
  fallbackTitle: string
): { title: string; steps: ParsedStep[] } {
  let title = '';
  const steps: ParsedStep[] = [];

  for (const line of docLines) {
    if (!line || META_RE.test(line)) continue;

    const numMatch = NUMBERED_STEP_RE.exec(line);
    if (numMatch) {
      const content    = numMatch[1].trim();
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

export function parseSwiftFile(
  filePath: string,
  tagPrefix: string,
  linkConfigs?: LinkConfig[]
): ParsedTest[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const lines  = source.split('\n');

  const fileBaseName = path.basename(filePath).replace(/\.swift$/, '');
  const pathTags = extractPathTags(filePath);
  const results: ParsedTest[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TEST_METHOD_RE);
    if (!m) continue;

    const methodName    = m[1];
    const methodLineIdx = i;

    const docLines              = extractDocBefore(lines, methodLineIdx);
    const { azureId, tags: cTags } = extractCommentMetadataAbove(lines, methodLineIdx, tagPrefix);
    const className             = findEnclosingClass(lines, methodLineIdx);

    const allTags = [...new Set([...pathTags, ...cTags])];
    const fallbackTitle = methodNameToTitle(methodName);
    const { title, steps } = parseSummary(docLines, fallbackTitle);

    const automatedTestName = className
      ? [fileBaseName, className, methodName].join(' > ')
      : [fileBaseName, methodName].join(' > ');

    results.push({
      filePath,
      title,
      steps,
      tags: allTags,
      azureId: azureId !== undefined && !isNaN(azureId) ? azureId : undefined,
      line: methodLineIdx + 1,
      linkRefs: extractLinkRefs(allTags, linkConfigs),
      automatedTestName,
    });
  }

  return results;
}
