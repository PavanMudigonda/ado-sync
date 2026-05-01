/**
 * Kotlin JUnit parser for azure-test-sync.
 *
 * Detects  @Test  annotated  fun  methods in Kotlin test files.
 * Supports both JUnit 4 (comment-based ID) and JUnit 5 (@Tag-based ID).
 *
 * Source mapping:
 *   KDoc /** ... * /  above @Test       → TC Title + Steps
 *   @Tag("tc:12345")  (JUnit 5)         → Azure TC ID (preferred writeback form)
 *   // @{tagPrefix}:N (JUnit 4 / fallback) → Azure TC ID
 *   @Tag("tagname")  (non-tc tags)      → TC Tags
 *   package.ClassName.methodName        → automatedTestName
 *
 * ID writeback:
 *   Delegates to writebackJava() — identical @Tag / comment conventions.
 *
 * Path-based auto-tagging: directory segments starting with '@' become tags.
 */

import * as fs from 'fs';

import { buildMarkerTagPrefixPattern, normalizeMarkerTagPrefixes } from '../id-markers';
import { LinkConfig, ParsedStep, ParsedTest } from '../types';
import { extractLinkRefs, extractPathTags } from './shared';

// ─── Test method detection ────────────────────────────────────────────────────

const TEST_ANNOTATION_RE = /^\s*@Test\s*(?:\([^)]*\))?\s*$/;
const FUN_RE = /^\s*(?:open\s+)?fun\s+(\w+)\s*\(/;

// ─── Package / class extraction ───────────────────────────────────────────────

function findPackageAndClass(lines: string[], testLineIdx: number): { pkg: string; cls: string } {
  let pkg = '';
  let cls = '';

  for (let i = testLineIdx - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();

    if (!cls) {
      const m = trimmed.match(/^(?:(?:data|open|abstract|sealed|inner)\s+)?class\s+(\w+)/);
      if (m) cls = m[1];
    }

    if (!pkg) {
      const m = trimmed.match(/^package\s+([\w.]+)/);
      if (m) pkg = m[1];
    }

    if (pkg && cls) break;
  }

  return { pkg, cls };
}

// ─── KDoc / comment block scanning ───────────────────────────────────────────

interface KotlinAnnotationBlock {
  docLines: string[];
  azureId?: number;
  tags: string[];
}

function extractAnnotationBlockAbove(
  lines: string[],
  testAttrLineIdx: number,
  tagPrefix: string | string[]
): KotlinAnnotationBlock {
  const docLines: string[] = [];
  let azureId: number | undefined;
  const tags: string[] = [];
  const markerTagPrefixes = normalizeMarkerTagPrefixes(tagPrefix);

  const tagAnnotationRe = new RegExp(`^@Tag\\(\\s*["'](?:${buildMarkerTagPrefixPattern(markerTagPrefixes)}):(\\d+)["']\\s*\\)$`);
  const anyTagRe        = /^@Tag\(\s*["']([\w:]+)["']\s*\)/;
  const commentIdRe     = new RegExp(`//\\s*@(?!tags?:)(?:${buildMarkerTagPrefixPattern(markerTagPrefixes)}):(\\d+)`);

  // Scan backward from @Test line
  let inKDoc = false;
  for (let i = testAttrLineIdx - 1; i >= 0 && i >= testAttrLineIdx - 50; i--) {
    const line  = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') {
      if (!inKDoc) break;
      continue;
    }

    // KDoc end: */ — start collecting
    if (trimmed === '*/') {
      inKDoc = true;
      continue;
    }

    if (inKDoc) {
      // KDoc start: /**
      if (trimmed.startsWith('/**') || trimmed === '/*') {
        break;
      }
      // KDoc line: strip leading * and whitespace
      const content = trimmed.replace(/^\*\s?/, '').trim();
      if (content) docLines.unshift(content);
      continue;
    }

    // @Tag("tc:12345")
    const tcTagMatch = trimmed.match(tagAnnotationRe);
    if (tcTagMatch) {
      if (azureId === undefined) azureId = parseInt(tcTagMatch[1], 10);
      continue;
    }

    // @Tag("smoke") — other tags
    const anyTagMatch = trimmed.match(anyTagRe);
    if (anyTagMatch && !markerTagPrefixes.some((prefix) => anyTagMatch[1].startsWith(`${prefix}:`))) {
      tags.push(anyTagMatch[1]);
      continue;
    }

    // // @tc:12345 comment fallback
    const commentMatch = trimmed.match(commentIdRe);
    if (commentMatch) {
      if (azureId === undefined) azureId = parseInt(commentMatch[1], 10);
      continue;
    }

    // Other annotations (@BeforeEach, @DisplayName, etc.) — skip
    if (trimmed.startsWith('@')) continue;

    // // regular comment line inside the block
    if (trimmed.startsWith('//')) {
      const content = trimmed.replace(/^\/\/\s?/, '');
      if (content) docLines.unshift(content);
      continue;
    }

    break;
  }

  return { docLines, azureId, tags };
}

// ─── Also scan BELOW @Test for @Tag annotations ───────────────────────────────

function extractTagsBelow(
  lines: string[],
  testAttrLineIdx: number,
  tagPrefix: string | string[]
): { azureId?: number; tags: string[] } {
  let azureId: number | undefined;
  const tags: string[] = [];
  const markerTagPrefixes = normalizeMarkerTagPrefixes(tagPrefix);

  const tagAnnotationRe = new RegExp(`^@Tag\\(\\s*["'](?:${buildMarkerTagPrefixPattern(markerTagPrefixes)}):(\\d+)["']\\s*\\)$`);
  const anyTagRe        = /^@Tag\(\s*["']([\w:]+)["']\s*\)/;

  for (let i = testAttrLineIdx + 1; i < lines.length && i <= testAttrLineIdx + 10; i++) {
    const trimmed = lines[i].trim();

    if (!trimmed.startsWith('@')) break;

    const tcTagMatch = trimmed.match(tagAnnotationRe);
    if (tcTagMatch) {
      if (azureId === undefined) azureId = parseInt(tcTagMatch[1], 10);
      continue;
    }

    const anyTagMatch = trimmed.match(anyTagRe);
    if (anyTagMatch && !markerTagPrefixes.some((prefix) => anyTagMatch[1].startsWith(`${prefix}:`))) {
      tags.push(anyTagMatch[1]);
    }
  }

  return { azureId, tags };
}

// ─── Title / steps ────────────────────────────────────────────────────────────

const NUMBERED_STEP_RE = /^\d+\.\s+(.+)$/;
const CHECK_RE = /^[Cc]heck:\s+(.+)$/;
const META_RE  = /^(?:test\s+case|user\s+story)[\s:]/i;

function parseSummary(
  docLines: string[],
  methodName: string
): { title: string; steps: ParsedStep[]; titleIsHeuristic: boolean } {
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

  const titleIsHeuristic = !title;
  if (!title) {
    // testUserLogin → User Login / userCanLogin → User Can Login
    title = methodName
      .replace(/^test/i, '')
      .replace(/([A-Z])/g, ' $1')
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/^\w/, (c) => c.toUpperCase());
    if (!title) title = methodName;
  }

  return { title, steps, titleIsHeuristic };
}

// ─── Public parser ────────────────────────────────────────────────────────────

export function parseKotlinFile(
  filePath: string,
  tagPrefix: string | string[],
  linkConfigs?: LinkConfig[]
): ParsedTest[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const lines = source.split('\n');

  const pathTags = extractPathTags(filePath);
  const results: ParsedTest[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!TEST_ANNOTATION_RE.test(trimmed)) continue;

    // Find the fun declaration (within the next 3 lines)
    let methodName = '';
    let methodLineIdx = -1;
    for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
      const m = lines[j].trim().match(FUN_RE);
      if (m) {
        methodName = m[1];
        methodLineIdx = j;
        break;
      }
    }
    if (!methodName) continue;

    const { pkg, cls } = findPackageAndClass(lines, i);
    const { docLines, azureId: idAbove, tags: tagsAbove } = extractAnnotationBlockAbove(lines, i, tagPrefix);
    const { azureId: idBelow, tags: tagsBelow } = extractTagsBelow(lines, i, tagPrefix);

    const azureId = idAbove ?? idBelow;
    const allTags = [...new Set([...pathTags, ...tagsAbove, ...tagsBelow])];
    const { title, steps, titleIsHeuristic } = parseSummary(docLines, methodName);

    const automatedTestName = [pkg, cls, methodName].filter(Boolean).join('.');

    results.push({
      filePath,
      title,
      steps,
      tags: allTags,
      azureId: azureId !== undefined && !isNaN(azureId) ? azureId : undefined,
      line: i + 1, // 1-based line of @Test
      linkRefs: extractLinkRefs(allTags, linkConfigs),
      automatedTestName: automatedTestName || undefined,
      titleIsHeuristic,
    });

    // Advance past the fun declaration to avoid double-matching
    i = methodLineIdx;
  }

  return results;
}
