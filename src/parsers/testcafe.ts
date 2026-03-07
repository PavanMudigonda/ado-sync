/**
 * TestCafe test parser for azure-test-sync.
 *
 * TestCafe uses a fixture / test API that is fundamentally different from
 * describe() / it(), so it gets its own parser.
 *
 * Detected test functions:
 *   test('title', async t => { ... })
 *   test.skip('title', async t => { ... })
 *   test.only('title', async t => { ... })
 *
 * Detected fixture blocks (used as the test group / describe equivalent):
 *   fixture('Fixture title')
 *   fixture.skip('Fixture title')
 *   fixture.only('Fixture title')
 *
 * Source mapping:
 *   JSDoc /** ... * / first non-numbered line    → TC Title
 *   Numbered lines "N. text"                     → TC Steps (action)
 *   "N. Check: text"                             → TC Steps (expected result column)
 *   // @tags: smoke, regression                  → TC Tags (comma-separated list)
 *   // @smoke                                    → TC Tag (single-word shorthand)
 *   // @{tagPrefix}:N  comment above test()      → Azure TC ID (written back after push)
 *   {fileBasename} > {fixture} > {test title}    → automatedTestName
 *
 * ID writeback:
 *   Inserts / updates  // @tc:12345  immediately above the test() line.
 *
 * Path-based auto-tagging: directory segments starting with '@' become tags.
 */

import * as fs from 'fs';
import * as path from 'path';

import { LinkConfig, ParsedStep, ParsedTest } from '../types';
import { extractLinkRefs, extractPathTags } from './shared';

// ─── Test / fixture detection ─────────────────────────────────────────────────

const TEST_CALL_RE =
  /^(?:test|test\.skip|test\.only)\s*\(/;

const TEST_TITLE_RE =
  /^(?:test|test\.skip|test\.only)\s*\(\s*(['"`])((?:\\.|[^\\])*?)\1/;

const FIXTURE_TITLE_RE =
  /^(?:fixture|fixture\.skip|fixture\.only)\s*\(\s*(['"`])((?:\\.|[^\\])*?)\1/;

// ─── Indentation helpers ──────────────────────────────────────────────────────

function getIndentLength(line: string): number {
  return (line.match(/^(\s*)/) ?? ['', ''])[1].length;
}

// ─── Enclosing fixture ────────────────────────────────────────────────────────

/**
 * Walk backward from the test() line to find the most recent fixture() title.
 */
function findEnclosingFixture(lines: string[], testLineIdx: number): string | undefined {
  const testIndent = getIndentLength(lines[testLineIdx]);

  for (let i = testLineIdx - 1; i >= 0; i--) {
    const line    = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    const lineIndent = getIndentLength(line);
    if (lineIndent <= testIndent) {
      const m = trimmed.match(FIXTURE_TITLE_RE);
      if (m) {
        return m[2].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\`/g, '`');
      }
    }
  }

  return undefined;
}

// ─── JSDoc extraction ─────────────────────────────────────────────────────────

function extractJsdocBefore(lines: string[], testLineIdx: number): string[] {
  let i = testLineIdx - 1;

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

function extractCommentMetadataAbove(
  lines: string[],
  testLineIdx: number,
  tagPrefix: string
): CommentMetadata {
  const tags: string[] = [];
  let azureId: number | undefined;

  const idRe       = new RegExp(`//\\s*@${tagPrefix}:(\\d+)`);
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

export function parseTestCafeFile(
  filePath: string,
  tagPrefix: string,
  linkConfigs?: LinkConfig[]
): ParsedTest[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const lines  = source.split('\n');

  const fileBaseName = path.basename(filePath)
    .replace(/\.(spec|test)\.(js|ts|mjs|cjs)$/, '')
    .replace(/\.(js|ts|mjs|cjs)$/, '');

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
      .replace(/\\`/g, '`')
      .replace(/\\\\/g, '\\');

    if (!callTitle) continue;

    const jsdocLines              = extractJsdocBefore(lines, testLineIdx);
    const { azureId, tags: cTags } = extractCommentMetadataAbove(lines, testLineIdx, tagPrefix);
    const fixture                 = findEnclosingFixture(lines, testLineIdx);

    const allTags = [...new Set([...pathTags, ...cTags])];
    const { title, steps } = parseSummary(jsdocLines, callTitle);

    const automatedTestName = fixture
      ? [fileBaseName, fixture, callTitle].join(' > ')
      : [fileBaseName, callTitle].join(' > ');

    results.push({
      filePath,
      title,
      steps,
      tags: allTags,
      azureId: azureId !== undefined && !isNaN(azureId) ? azureId : undefined,
      line: testLineIdx + 1,
      linkRefs: extractLinkRefs(allTags, linkConfigs),
      automatedTestName,
    });
  }

  return results;
}
