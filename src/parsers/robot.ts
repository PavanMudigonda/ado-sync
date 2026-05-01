/**
 * Robot Framework parser for azure-test-sync.
 *
 * Parses .robot files (Robot Framework test suites).
 *
 * Source mapping:
 *   Test case name line (non-indented)  → TC Title
 *   [Documentation] row                 → TC Description
 *   [Tags] row value tc:N               → Azure TC ID (preferred writeback form)
 *   # @{tagPrefix}:N comment above name → Azure TC ID (comment fallback)
 *   [Tags] other values                 → TC Tags
 *   Indented keyword lines              → TC Steps
 *   Test case name                      → automatedTestName
 *
 * ID writeback:
 *   Inserts / updates the tc:N tag in the [Tags] row of the test case body.
 *   If no [Tags] row exists, inserts one immediately after the test name line.
 *
 * Path-based auto-tagging: directory segments starting with '@' become tags.
 */

import * as fs from 'fs';

import { buildMarkerTagPrefixPattern, normalizeMarkerTagPrefixes } from '../id-markers';
import { LinkConfig, ParsedStep, ParsedTest } from '../types';
import { extractLinkRefs, extractPathTags } from './shared';

// ─── Section detection ────────────────────────────────────────────────────────

const SECTION_RE = /^\*{1,3}\s*(\w[\w\s]*\w|\w)\s*\*{0,3}\s*$/;
const SETTINGS_ROWS = new Set(['[Documentation]', '[Tags]', '[Setup]', '[Teardown]', '[Template]', '[Timeout]', '[Arguments]', '[Return]']);

// ─── Step parsing ─────────────────────────────────────────────────────────────

const NUMBERED_STEP_RE = /^\d+\.\s+(.+)$/;
const CHECK_RE = /^[Cc]heck:\s+(.+)$/;
const META_RE  = /^(?:test\s+case|user\s+story)[\s:]/i;

interface SummaryResult {
  title: string;
  steps: ParsedStep[];
}

function parseSummary(
  docLines: string[],
  fallbackTitle: string
): SummaryResult {
  let title = '';
  const steps: ParsedStep[] = [];

  for (const line of docLines) {
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

  if (!title) title = fallbackTitle;
  return { title, steps };
}

// ─── Tags / ID from [Tags] row ────────────────────────────────────────────────

interface TagsResult {
  tags: string[];
  azureId?: number;
}

function parseTagsRow(raw: string, tagPrefix: string | string[]): TagsResult {
  const markerTagPrefixes = normalizeMarkerTagPrefixes(tagPrefix);
  // Strip [Tags] / [tags] prefix and split on 2+ spaces or tab
  const withoutKey = raw.replace(/^\[tags\]\s*/i, '');
  const values = withoutKey.split(/\s{2,}|\t/).map((v) => v.trim()).filter(Boolean);

  const tags: string[] = [];
  let azureId: number | undefined;

  for (const v of values) {
    const idMatch = v.match(new RegExp(`^(?:${buildMarkerTagPrefixPattern(markerTagPrefixes)}):(\\d+)$`, 'i'));
    if (idMatch) {
      if (azureId === undefined) azureId = parseInt(idMatch[1], 10);
    } else {
      tags.push(v);
    }
  }

  return { tags, azureId };
}

// ─── Keyword step lines → ParsedStep ─────────────────────────────────────────

function keywordToStep(keyword: string): ParsedStep {
  return { keyword: 'Step', text: keyword };
}

// ─── Public parser ────────────────────────────────────────────────────────────

export function parseRobotFile(
  filePath: string,
  tagPrefix: string | string[],
  linkConfigs?: LinkConfig[]
): ParsedTest[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const lines = source.split('\n');
  const pathTags = extractPathTags(filePath);
  const markerTagPrefixes = normalizeMarkerTagPrefixes(tagPrefix);
  const results: ParsedTest[] = [];

  let inTestCases = false;

  // State for current test case being accumulated
  let testNameLine = -1;
  let testName = '';
  let docLines: string[] = [];
  let tagsRow = '';
  let stepLines: string[] = [];
  let commentIdAbove: number | undefined;

  function flushTest(): void {
    if (testNameLine < 0 || !testName) return;

    let azureId: number | undefined;
    let tags: string[] = [];

    if (tagsRow) {
      const parsed = parseTagsRow(tagsRow, tagPrefix);
      azureId = parsed.azureId;
      tags = parsed.tags;
    }
    if (azureId === undefined) azureId = commentIdAbove;

    const allTags = [...new Set([...pathTags, ...tags])];
    const docText = docLines.join(' ');
    const { title, steps } = parseSummary([docText], testName);

    // Build steps from keyword lines if no numbered steps in doc
    const finalSteps: ParsedStep[] = steps.length > 0
      ? steps
      : stepLines.map(keywordToStep);

    results.push({
      filePath,
      title,
      description: docText || undefined,
      steps: finalSteps,
      tags: allTags,
      azureId: azureId !== undefined && !isNaN(azureId) ? azureId : undefined,
      line: testNameLine + 1, // 1-based
      linkRefs: extractLinkRefs(allTags, linkConfigs),
      automatedTestName: testName,
      titleIsHeuristic: false,
    });

    testNameLine = -1;
    testName = '';
    docLines = [];
    tagsRow = '';
    stepLines = [];
    commentIdAbove = undefined;
  }

  const commentIdRe = new RegExp(`#\\s*@(?!tags?:)(?:${buildMarkerTagPrefixPattern(markerTagPrefixes)}):(\\d+)`);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Detect section headers
    if (SECTION_RE.test(trimmed)) {
      flushTest();
      const sectionName = trimmed.replace(/\*/g, '').trim().toLowerCase();
      inTestCases = sectionName === 'test cases' || sectionName === 'tasks';
      continue;
    }

    if (!inTestCases) continue;

    // Comment line (possible ID above test name)
    if (trimmed.startsWith('#')) {
      const m = trimmed.match(commentIdRe);
      if (m) commentIdAbove = parseInt(m[1], 10);
      continue;
    }

    // Blank line inside a test case → flush
    if (trimmed === '') {
      if (testNameLine >= 0) flushTest();
      continue;
    }

    // Non-indented non-empty line = test case name
    const isIndented = /^\s/.test(raw);
    if (!isIndented) {
      flushTest();
      testNameLine = i;
      testName = trimmed;
      commentIdAbove = undefined; // reset — will be picked up from scanning above
      // Scan backward for a comment ID immediately above this line
      for (let j = i - 1; j >= 0 && j >= i - 5; j--) {
        const t = lines[j].trim();
        if (t === '') break;
        const m = t.match(commentIdRe);
        if (m) { commentIdAbove = parseInt(m[1], 10); break; }
      }
      continue;
    }

    // Indented line — part of current test case body
    if (testNameLine < 0) continue;

    const rowKey = trimmed.split(/\s{2,}|\t/)[0];
    const upperKey = rowKey.toUpperCase();

    if (upperKey === '[DOCUMENTATION]') {
      const doc = trimmed.replace(/^\[documentation\]\s*/i, '');
      docLines.push(doc);
    } else if (upperKey === '[TAGS]') {
      tagsRow = trimmed;
    } else if (!SETTINGS_ROWS.has(rowKey) && trimmed && !trimmed.startsWith('#')) {
      stepLines.push(trimmed);
    }
  }

  flushTest();
  return results;
}
