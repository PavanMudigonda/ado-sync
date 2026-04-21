/**
 * Rust testing parser for azure-test-sync.
 *
 * Detects  #[test]  attributed functions in Rust source files.
 *
 * Source mapping:
 *   /// or // doc comment above #[test]  → TC Title + Steps
 *   // @{tagPrefix}:N above #[test]      → Azure TC ID
 *   // @tags: smoke, regression          → TC Tags
 *   module::function_name               → automatedTestName
 *
 * ID writeback:
 *   Inserts / updates  // @tc:12345  immediately above the #[test] line.
 *
 * Path-based auto-tagging: directory segments starting with '@' become tags.
 */

import * as fs from 'fs';

import { buildMarkerTagPrefixPattern, normalizeMarkerTagPrefixes } from '../id-markers';
import { LinkConfig, ParsedStep, ParsedTest } from '../types';
import { extractLinkRefs, extractPathTags } from './shared';

// ─── Test attribute detection ─────────────────────────────────────────────────

const TEST_ATTR_RE  = /^\s*#\[(?:tokio::)?test(?:\(.*\))?\]\s*$/;
const FN_RE         = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(/;

// ─── Module path building ─────────────────────────────────────────────────────

function findModulePath(lines: string[], testAttrLineIdx: number): string {
  const testIndent = (lines[testAttrLineIdx].match(/^(\s*)/) ?? ['', ''])[1].length;
  const modules: string[] = [];

  for (let i = testAttrLineIdx - 1; i >= 0; i--) {
    const line = lines[i];
    const lineIndent = (line.match(/^(\s*)/) ?? ['', ''])[1].length;
    if (lineIndent >= testIndent) continue;

    const m = line.trim().match(/^(?:pub\s+)?mod\s+(\w+)\s*\{?/);
    if (m) {
      modules.unshift(m[1]);
    }
  }

  return modules.join('::');
}

// ─── Comment / doc block scanning ────────────────────────────────────────────

interface RustCommentBlock {
  docLines: string[];
  azureId?: number;
  tags: string[];
}

function extractCommentBlockAbove(
  lines: string[],
  attrLineIdx: number,
  tagPrefix: string | string[]
): RustCommentBlock {
  const docLines: string[] = [];
  let azureId: number | undefined;
  const tags: string[] = [];
  const markerTagPrefixes = normalizeMarkerTagPrefixes(tagPrefix);

  const idRe       = new RegExp(`//\\s*@(?!tags?:)(?:${buildMarkerTagPrefixPattern(markerTagPrefixes)}):(\\d+)`);
  const tagsRe     = /\/\/\s*@tags:\s*(.+)/i;
  const singleTagRe = /\/\/\s*@(\w+)\s*$/;
  const docRe       = /^\/\/[\/!]?\s?(.*)$/; // matches //, ///, //!

  for (let i = attrLineIdx - 1; i >= 0 && i >= attrLineIdx - 40; i--) {
    const trimmed = lines[i].trim();

    if (trimmed === '') break;

    // Must be a comment line
    if (!trimmed.startsWith('//') && !trimmed.startsWith('#[')) break;

    // Skip other attributes like #[ignore], #[should_panic]
    if (trimmed.startsWith('#[')) continue;

    const idMatch = trimmed.match(idRe);
    if (idMatch) {
      if (azureId === undefined) azureId = parseInt(idMatch[1], 10);
      continue;
    }

    const tagsMatch = trimmed.match(tagsRe);
    if (tagsMatch) {
      for (const t of tagsMatch[1].split(',').map((s) => s.trim()).filter(Boolean)) {
        tags.push(t);
      }
      continue;
    }

    const singleTagMatch = trimmed.match(singleTagRe);
    if (singleTagMatch && !markerTagPrefixes.includes(singleTagMatch[1])) {
      tags.push(singleTagMatch[1]);
      continue;
    }

    const docMatch = trimmed.match(docRe);
    if (docMatch && docMatch[1] !== undefined) {
      docLines.unshift(docMatch[1]);
    }
  }

  return { docLines, azureId, tags };
}

// ─── Title / steps ────────────────────────────────────────────────────────────

const NUMBERED_STEP_RE = /^\d+\.\s+(.+)$/;
const CHECK_RE = /^[Cc]heck:\s+(.+)$/;
const META_RE  = /^(?:test\s+case|user\s+story)[\s:]/i;

function parseSummary(
  docLines: string[],
  fnName: string
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
    // it_works → It works
    title = fnName.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }

  return { title, steps, titleIsHeuristic };
}

// ─── Public parser ────────────────────────────────────────────────────────────

export function parseRustFile(
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
    if (!TEST_ATTR_RE.test(trimmed)) continue;

    // Find the fn declaration (within the next 5 lines)
    let fnName = '';
    let fnLineIdx = -1;
    for (let j = i + 1; j < lines.length && j <= i + 5; j++) {
      const m = lines[j].trim().match(FN_RE);
      if (m) {
        fnName = m[1];
        fnLineIdx = j;
        break;
      }
    }
    if (!fnName) continue;

    const modulePath = findModulePath(lines, i);
    const { docLines, azureId, tags: commentTags } = extractCommentBlockAbove(lines, i, tagPrefix);

    const allTags = [...new Set([...pathTags, ...commentTags])];
    const { title, steps, titleIsHeuristic } = parseSummary(docLines, fnName);

    const automatedTestName = modulePath ? `${modulePath}::${fnName}` : fnName;

    results.push({
      filePath,
      title,
      steps,
      tags: allTags,
      azureId: azureId !== undefined && !isNaN(azureId) ? azureId : undefined,
      line: i + 1, // 1-based line of #[test]
      linkRefs: extractLinkRefs(allTags, linkConfigs),
      automatedTestName,
      titleIsHeuristic,
    });

    // Skip to after fn declaration to avoid re-processing
    i = fnLineIdx;
  }

  return results;
}
