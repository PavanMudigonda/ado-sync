/**
 * Go testing parser for azure-test-sync.
 *
 * Detects  func TestXxx(t *testing.T)  functions in *_test.go files.
 *
 * Source mapping:
 *   Doc comment block above func       → TC Title + Steps
 *   // @{tagPrefix}:N above func       → Azure TC ID
 *   // @tags: smoke, regression        → TC Tags
 *   package.FunctionName               → automatedTestName
 *
 * ID writeback:
 *   Inserts / updates  // @tc:12345  immediately above the func line.
 *
 * Path-based auto-tagging: directory segments starting with '@' become tags.
 */

import * as fs from 'fs';
import * as path from 'path';

import { buildMarkerTagPrefixPattern, normalizeMarkerTagPrefixes } from '../id-markers';
import { LinkConfig, ParsedStep, ParsedTest } from '../types';
import { extractLinkRefs, extractPathTags } from './shared';

// ─── Test function detection ──────────────────────────────────────────────────

// Matches: func TestXxx(t *testing.T) / func TestXxx(b *testing.B) / func TestXxx(tb testing.TB)
const TEST_FUNC_RE = /^\s*func\s+(Test\w+)\s*\(\s*\w+\s+[\*]?testing\.[A-Za-z]+\s*\)/;

// ─── Package name extraction ──────────────────────────────────────────────────

function extractPackageName(lines: string[]): string {
  for (const line of lines) {
    const m = line.match(/^package\s+(\w+)/);
    if (m) return m[1];
  }
  return '';
}

// ─── Module path derivation ───────────────────────────────────────────────────

/**
 * Derive a Go package identifier from the file path.
 * If a go.mod is found, uses the module path + relative dir.
 * Otherwise falls back to the package name from source.
 */
function deriveGoModulePath(filePath: string, packageName: string): string {
  const dir = path.dirname(filePath);
  const parts = dir.replace(/\\/g, '/').split('/');

  // Walk up to find a meaningful root (cmd / pkg / internal / app / src)
  const rootNames = new Set(['cmd', 'pkg', 'internal', 'app', 'src', 'test', 'tests']);
  let rootIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (rootNames.has(parts[i])) { rootIdx = i; break; }
  }

  if (rootIdx >= 0) {
    return [...parts.slice(rootIdx), packageName].join('/');
  }
  return packageName;
}

// ─── Comment block scanning ───────────────────────────────────────────────────

interface GoCommentBlock {
  docLines: string[];
  azureId?: number;
  tags: string[];
}

function extractCommentBlockAbove(
  lines: string[],
  funcLineIdx: number,
  tagPrefix: string | string[]
): GoCommentBlock {
  const docLines: string[] = [];
  let azureId: number | undefined;
  const tags: string[] = [];
  const markerTagPrefixes = normalizeMarkerTagPrefixes(tagPrefix);

  const idRe   = new RegExp(`//\\s*@(?!tags?:)(?:${buildMarkerTagPrefixPattern(markerTagPrefixes)}):(\\d+)`);
  const tagsRe = /\/\/\s*@tags:\s*(.+)/i;
  const singleTagRe = /\/\/\s*@(\w+)\s*$/;

  for (let i = funcLineIdx - 1; i >= 0 && i >= funcLineIdx - 50; i--) {
    const trimmed = lines[i].trim();

    if (trimmed === '') break;

    // Must be a comment line
    if (!trimmed.startsWith('//')) break;

    const content = trimmed.replace(/^\/\/\s?/, '');

    // ID annotation
    const idMatch = trimmed.match(idRe);
    if (idMatch) {
      if (azureId === undefined) azureId = parseInt(idMatch[1], 10);
      continue;
    }

    // @tags: smoke, regression
    const tagsMatch = trimmed.match(tagsRe);
    if (tagsMatch) {
      for (const t of tagsMatch[1].split(',').map((s) => s.trim()).filter(Boolean)) {
        tags.push(t);
      }
      continue;
    }

    // Single-word @smoke shorthand
    const singleTagMatch = trimmed.match(singleTagRe);
    if (singleTagMatch && !markerTagPrefixes.includes(singleTagMatch[1])) {
      tags.push(singleTagMatch[1]);
      continue;
    }

    if (content) docLines.unshift(content);
  }

  return { docLines, azureId, tags };
}

// ─── Title / steps from doc comments ─────────────────────────────────────────

const NUMBERED_STEP_RE = /^\d+\.\s+(.+)$/;
const CHECK_RE = /^[Cc]heck:\s+(.+)$/;
const META_RE  = /^(?:test\s+case|user\s+story)[\s:]/i;

function parseSummary(
  docLines: string[],
  funcName: string
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
    // Strip Test prefix and convert PascalCase to words: TestUserLogin → User Login
    title = funcName
      .replace(/^Test/, '')
      .replace(/([A-Z])/g, ' $1')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .replace(/^\w/, (c) => c.toUpperCase());
  }

  return { title, steps, titleIsHeuristic };
}

// ─── Public parser ────────────────────────────────────────────────────────────

export function parseGoFile(
  filePath: string,
  tagPrefix: string | string[],
  linkConfigs?: LinkConfig[]
): ParsedTest[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const lines = source.split('\n');

  const packageName = extractPackageName(lines);
  const modulePath  = deriveGoModulePath(filePath, packageName);
  const pathTags    = extractPathTags(filePath);
  const results: ParsedTest[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const m = trimmed.match(TEST_FUNC_RE);
    if (!m) continue;

    const funcName = m[1];
    const { docLines, azureId, tags: commentTags } = extractCommentBlockAbove(lines, i, tagPrefix);

    const allTags = [...new Set([...pathTags, ...commentTags])];
    const { title, steps, titleIsHeuristic } = parseSummary(docLines, funcName);

    results.push({
      filePath,
      title,
      steps,
      tags: allTags,
      azureId: azureId !== undefined && !isNaN(azureId) ? azureId : undefined,
      line: i + 1, // 1-based line of func declaration
      linkRefs: extractLinkRefs(allTags, linkConfigs),
      automatedTestName: modulePath ? `${modulePath}.${funcName}` : funcName,
      titleIsHeuristic,
    });
  }

  return results;
}
