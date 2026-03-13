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
 *   test.meta('tc', '12345')('title', async t => { ... })     ← native meta, key-value
 *   test.meta({ tc: '12345' })('title', async t => { ... })   ← native meta, object form
 *   test.skip.meta(...)('title', ...)   /   test.meta(...).skip('title', ...)
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
 *   test.meta('<tagPrefix>', 'N')                → Azure TC ID (preferred)
 *   test.meta({ <tagPrefix>: 'N' })              → Azure TC ID (object form)
 *   // @tags: smoke, regression                  → TC Tags (comma-separated list)
 *   // @smoke                                    → TC Tag (single-word shorthand)
 *   // @{tagPrefix}:N  comment above test()      → Azure TC ID (comment fallback)
 *   {fileBasename} > {fixture} > {test title}    → automatedTestName
 *
 * ID writeback:
 *   Inserts / updates  test.meta('<tagPrefix>', 'N')  chained to the test call.
 *   Falls back to  // @tc:12345  comment if the test call cannot be parsed.
 *
 * Path-based auto-tagging: directory segments starting with '@' become tags.
 */

import * as fs from 'fs';
import * as path from 'path';

import { LinkConfig, ParsedStep, ParsedTest } from '../types';
import { extractLinkRefs, extractPathTags } from './shared';

// ─── Test / fixture detection ─────────────────────────────────────────────────

/** Matches a regular test call (no .meta chaining). */
const TEST_CALL_RE =
  /^(?:test|test\.skip|test\.only)\s*\(/;

const TEST_TITLE_RE =
  /^(?:test|test\.skip|test\.only)\s*\(\s*(['"`])((?:\\.|[^\\])*?)\1/;

const FIXTURE_TITLE_RE =
  /^(?:fixture|fixture\.skip|fixture\.only)\s*\(\s*(['"`])((?:\\.|[^\\])*?)\1/;

/**
 * Matches a meta-chained test call:
 *   test.meta(...)('title', fn)
 *   test.skip.meta(...)('title', fn)
 *   test.only.meta(...)('title', fn)
 */
const META_CHAIN_RE = /^test(?:\.(?:skip|only))?\.meta\s*\(/;

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

// ─── TestCafe native .meta() extraction ───────────────────────────────────────

interface MetaChainResult {
  callTitle: string;
  azureId?: number;
  tags: string[];
  /** Line index of the title call — used to advance the outer loop. */
  titleLineIdx: number;
}

/**
 * Parse a meta-chained TestCafe test call:
 *   test.meta('tc', '12345')('title', async t => { ... })
 *   test.meta({ tc: '12345', priority: 'high' })('title', async t => { ... })
 *
 * Collects up to 8 lines starting at startLineIdx to handle multi-line meta
 * calls. The titleLineIdx in the result indicates where the title was found
 * (used to advance the outer parsing loop past this test).
 *
 * Returns null if the pattern cannot be parsed.
 */
function extractMetaChainResult(
  lines: string[],
  startLineIdx: number,
  tagPrefix: string
): MetaChainResult | null {
  let azureId: number | undefined;
  const tags: string[] = [];

  const scanEnd = Math.min(startLineIdx + 8, lines.length);

  // Accumulate trimmed source lines until we can see the )(title pattern
  let collected = '';
  for (let i = startLineIdx; i < scanEnd; i++) {
    collected += (i > startLineIdx ? ' ' : '') + lines[i].trim();

    // Have we closed the .meta(...) call and opened the title call?
    // Pattern: ) followed by ( with a quoted string
    const titleMatch = collected.match(/\)\s*\(\s*(['"`])((?:\\.|[^\\])*?)\1/);
    if (!titleMatch) continue;

    const callTitle = titleMatch[2]
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\`/g, '`')
      .replace(/\\\\/g, '\\');

    if (!callTitle) return null;

    // Extract TC ID — key-value form: .meta('tc', '12345')
    const kvRe = new RegExp(
      `\\.meta\\s*\\(\\s*['"]${tagPrefix}['"]\\s*,\\s*['"]([\\d]+)['"]`
    );
    const kvMatch = collected.match(kvRe);
    if (kvMatch) {
      azureId = parseInt(kvMatch[1], 10);
    }

    // Extract TC ID — object form: .meta({ tc: '12345', ... }) or .meta({ "tc": '12345' })
    if (azureId === undefined) {
      const objRe = new RegExp(
        `\\.meta\\s*\\(\\s*\\{[^}]*['"]?${tagPrefix}['"]?\\s*:\\s*['"]([\\d]+)['"]`
      );
      const objMatch = collected.match(objRe);
      if (objMatch) {
        azureId = parseInt(objMatch[1], 10);
      }
    }

    // Extract extra tags from object form (non-tc string values)
    const metaObjMatch = collected.match(/\.meta\s*\(\s*\{([^}]*)\}/);
    if (metaObjMatch) {
      const pairRe = /['"]?([\w]+)['"]?\s*:\s*['"]([^'"]+)['"]/g;
      let pm: RegExpExecArray | null;
      while ((pm = pairRe.exec(metaObjMatch[1])) !== null) {
        if (pm[1] !== tagPrefix) tags.push(pm[2]);
      }
    }

    return { callTitle, azureId, tags, titleLineIdx: i };
  }

  return null;
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

    let testLineIdx = i;    // line used for JSDoc / comment extraction (start of test expression)
    let callTitle   = '';
    let metaAzureId: number | undefined;
    let metaTags: string[] = [];

    if (META_CHAIN_RE.test(trimmed)) {
      // ── meta-chained test: test.meta(...)('title', fn) ──────────────────────
      const extracted = extractMetaChainResult(lines, i, tagPrefix);
      if (!extracted) continue;

      callTitle   = extracted.callTitle;
      metaAzureId = extracted.azureId;
      metaTags    = extracted.tags;
      // testLineIdx stays at i (start of meta chain, used for JSDoc/comment/writeback)
      i = extracted.titleLineIdx; // advance past multi-line meta to avoid re-parsing

    } else if (TEST_CALL_RE.test(trimmed)) {
      // ── regular test: test('title', fn) ─────────────────────────────────────
      const m = trimmed.match(TEST_TITLE_RE);
      if (!m) continue;

      callTitle = m[2]
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\`/g, '`')
        .replace(/\\\\/g, '\\');

    } else {
      continue;
    }

    if (!callTitle) continue;

    const jsdocLines              = extractJsdocBefore(lines, testLineIdx);
    const { azureId: cId, tags: cTags } = extractCommentMetadataAbove(lines, testLineIdx, tagPrefix);
    const fixture                 = findEnclosingFixture(lines, testLineIdx);

    // Native .meta() ID takes priority over comment-style ID
    const azureId = metaAzureId ?? cId;
    const allTags = [...new Set([...pathTags, ...cTags, ...metaTags])];
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
      line: testLineIdx + 1, // 1-based; writeback starts from here
      linkRefs: extractLinkRefs(allTags, linkConfigs),
      automatedTestName,
      titleIsHeuristic: false,
    });
  }

  return results;
}
