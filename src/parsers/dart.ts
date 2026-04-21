/**
 * Dart / Flutter test parser for azure-test-sync.
 *
 * Handles Flutter widget tests and unit tests written with the
 * `flutter_test` / `test` packages.
 *
 * Detected test functions:
 *   testWidgets('title', (WidgetTester tester) async { ... })
 *   test('title', () { ... })
 *   testUI('title', () { ... })           ← integration_test alias
 *
 * Detected group blocks (used as the describe / suite equivalent):
 *   group('Group title', () { ... })
 *
 * Source mapping:
 *   /// Dart doc comment above testWidgets      → TC Title (first non-numbered line)
 *   JSDoc /** ... * / doc comment              → TC Title + Steps (same format)
 *   Numbered lines "N. text"             → TC Steps (action)
 *   "N. Check: text"                     → TC Steps (expected result column)
 *   // @tags: smoke, regression          → TC Tags (comma-separated list)
 *   // @smoke                            → TC Tag (single-word shorthand)
 *   // @{tagPrefix}:N                    → Azure TC ID (written back after push)
 *   {fileBasename} > {group} > {title}   → automatedTestName
 *
 * ID writeback:
 *   Inserts / updates  // @tc:12345  immediately above the testWidgets() / test() line.
 *
 * Path-based auto-tagging: directory segments starting with '@' become tags.
 */

import * as fs from 'fs';
import * as path from 'path';

import { buildMarkerTagPrefixPattern, normalizeMarkerTagPrefixes } from '../id-markers';
import { LinkConfig, ParsedStep, ParsedTest } from '../types';
import { extractLinkRefs, extractPathTags } from './shared';

// ─── Test / group detection ────────────────────────────────────────────────────

const TEST_CALL_RE  = /^(?:testWidgets|testUI|test)\s*\(/;
const TEST_TITLE_RE = /^(?:testWidgets|testUI|test)\s*\(\s*(['"`])((?:\\.|[^\\])*?)\1/;
const GROUP_TITLE_RE = /^group\s*\(\s*(['"`])((?:\\.|[^\\])*?)\1/;

// ─── Indentation helpers ──────────────────────────────────────────────────────

function getIndentLength(line: string): number {
  return (line.match(/^(\s*)/) ?? ['', ''])[1].length;
}

// ─── Enclosing group blocks ───────────────────────────────────────────────────

function findEnclosingGroups(lines: string[], testLineIdx: number): string[] {
  const groups: string[] = [];
  let targetIndent = getIndentLength(lines[testLineIdx]);

  for (let i = testLineIdx - 1; i >= 0; i--) {
    const line    = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    const lineIndent = getIndentLength(line);
    if (lineIndent < targetIndent) {
      const m = trimmed.match(GROUP_TITLE_RE);
      if (m) {
        groups.unshift(
          m[2].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\`/g, '`')
        );
        targetIndent = lineIndent;
      }
    }
  }

  return groups;
}

// ─── Doc comment extraction ───────────────────────────────────────────────────

/**
 * Extract Dart doc comments above testWidgets() / test().
 * Supports triple-slash (///) Dart idiomatic style and block (/* * /) style.
 */
function extractDocBefore(lines: string[], testLineIdx: number): string[] {
  let i = testLineIdx - 1;

  // Skip blank lines and regular single-line comments
  while (i >= 0) {
    const t = lines[i].trim();
    if (t === '' || (t.startsWith('//') && !t.startsWith('///'))) { i--; continue; }
    break;
  }

  if (i < 0) return [];

  // /// triple-slash style (Dart idiomatic)
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

// ─── TC ID and tags from comments above the test ──────────────────────────────

interface CommentMetadata {
  azureId?: number;
  tags: string[];
}

function extractCommentMetadataAbove(
  lines: string[],
  testLineIdx: number,
  tagPrefix: string | string[]
): CommentMetadata {
  const tags: string[] = [];
  let azureId: number | undefined;
  const markerTagPrefixes = normalizeMarkerTagPrefixes(tagPrefix);

  const idRe       = new RegExp(`//\\s*@(?!tags?:)(?:${buildMarkerTagPrefixPattern(markerTagPrefixes)}):(\\d+)`);
  const tagsListRe = /\/\/\s*@tags?\s*:\s*(.+)/i;
  const singleTagRe = /\/\/\s*@(\w+)\s*$/;

  for (let i = testLineIdx - 1; i >= 0 && i >= testLineIdx - 25; i--) {
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
    if (singleTag && !markerTagPrefixes.includes(singleTag[1])) {
      tags.push(singleTag[1]);
      continue;
    }
  }

  return { azureId, tags };
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

export function parseDartFile(
  filePath: string,
  tagPrefix: string | string[],
  linkConfigs?: LinkConfig[]
): ParsedTest[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const lines  = source.split('\n');

  // Strip _test.dart / .dart suffixes for a clean base name
  const fileBaseName = path.basename(filePath)
    .replace(/_test\.dart$/, '')
    .replace(/\.dart$/, '');

  const pathTags = extractPathTags(filePath);
  const results: ParsedTest[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!TEST_CALL_RE.test(trimmed)) continue;

    const testLineIdx = i;
    const m = trimmed.match(TEST_TITLE_RE);
    if (!m) continue;

    const callTitle = m[2]
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\`/g, '`');

    if (!callTitle) continue;

    const docLines              = extractDocBefore(lines, testLineIdx);
    const { azureId, tags: cTags } = extractCommentMetadataAbove(lines, testLineIdx, tagPrefix);
    const groups                = findEnclosingGroups(lines, testLineIdx);

    const allTags = [...new Set([...pathTags, ...cTags])];
    const { title, steps } = parseSummary(docLines, callTitle);

    // automatedTestName mirrors Flutter test result format
    const automatedTestName = [fileBaseName, ...groups, callTitle].join(' > ');

    results.push({
      filePath,
      title,
      steps,
      tags: allTags,
      azureId: azureId !== undefined && !isNaN(azureId) ? azureId : undefined,
      line: testLineIdx + 1,
      linkRefs: extractLinkRefs(allTags, linkConfigs),
      automatedTestName,
      titleIsHeuristic: false,
    });
  }

  return results;
}
