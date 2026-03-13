/**
 * Ruby RSpec parser for azure-test-sync.
 *
 * Detects  it 'description'  and  it "description"  blocks in *_spec.rb files.
 *
 * Source mapping:
 *   it 'title'                          → TC Title (with enclosing describe/context prefix)
 *   # Numbered lines in comment above   → TC Steps
 *   # @{tagPrefix}:N above it           → Azure TC ID
 *   # @tags: smoke, regression          → TC Tags
 *   # @smoke (single-word)              → TC Tag
 *   filePath::full description          → automatedTestName
 *
 * ID writeback:
 *   Inserts / updates  # @tc:12345  immediately above the it line.
 *
 * Path-based auto-tagging: directory segments starting with '@' become tags.
 */

import * as fs from 'fs';
import * as path from 'path';

import { LinkConfig, ParsedStep, ParsedTest } from '../types';
import { extractLinkRefs, extractPathTags } from './shared';

// ─── Test detection ───────────────────────────────────────────────────────────

// Matches: it 'title' or it "title" (with optional whitespace)
const IT_RE = /^\s*it\s+(['"])(.*?)\1/;

// Matches: describe/context/RSpec.describe blocks
const DESCRIBE_RE = /^\s*(?:RSpec\.)?(?:describe|context|feature)\s+(['"])(.*?)\1/;

// ─── Enclosing context building ───────────────────────────────────────────────

interface IndentBlock {
  description: string;
  indent: number;
}

function findEnclosingContexts(lines: string[], itLineIdx: number): string[] {
  const itIndent = getIndent(lines[itLineIdx]);
  const contexts: IndentBlock[] = [];

  for (let i = itLineIdx - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;

    const lineIndent = getIndent(line);
    if (lineIndent >= itIndent) continue;

    const m = line.match(DESCRIBE_RE);
    if (m) {
      contexts.unshift({ description: m[2], indent: lineIndent });
    }
  }

  return contexts.map((c) => c.description);
}

function getIndent(line: string): number {
  return (line.match(/^(\s*)/) ?? ['', ''])[1].length;
}

// ─── Comment block scanning ───────────────────────────────────────────────────

interface RubyCommentBlock {
  docLines: string[];
  azureId?: number;
  tags: string[];
}

function extractCommentBlockAbove(
  lines: string[],
  itLineIdx: number,
  tagPrefix: string
): RubyCommentBlock {
  const docLines: string[] = [];
  let azureId: number | undefined;
  const tags: string[] = [];

  const idRe       = new RegExp(`#\\s*@${tagPrefix}:(\\d+)`);
  const tagsRe     = /^#\s*@tags:\s*(.+)/i;
  const singleTagRe = /^#\s*@(\w+)\s*$/;

  for (let i = itLineIdx - 1; i >= 0 && i >= itLineIdx - 30; i--) {
    const trimmed = lines[i].trim();

    if (trimmed === '') break;
    if (!trimmed.startsWith('#')) break;

    // Stop at enclosing block boundary keywords
    if (/^\s*(?:describe|context|before|after|let|subject)\b/.test(lines[i])) break;

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
    if (singleTagMatch && singleTagMatch[1] !== tagPrefix) {
      tags.push(singleTagMatch[1]);
      continue;
    }

    const content = trimmed.replace(/^#\s?/, '');
    if (content) docLines.unshift(content);
  }

  return { docLines, azureId, tags };
}

// ─── Title / steps from comment block ────────────────────────────────────────

const NUMBERED_STEP_RE = /^\d+\.\s+(.+)$/;
const CHECK_RE = /^[Cc]heck:\s+(.+)$/;
const META_RE  = /^(?:test\s+case|user\s+story)[\s:]/i;

function parseSummary(
  docLines: string[],
  itDescription: string,
  contexts: string[]
): { title: string; steps: ParsedStep[] } {
  let titleFromDoc = '';
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

    if (!titleFromDoc) titleFromDoc = line;
  }

  const contextPrefix = contexts.length > 0 ? `${contexts.join(' ')} ` : '';
  const title = titleFromDoc || `${contextPrefix}${itDescription}`.trim();

  return { title, steps };
}

// ─── Public parser ────────────────────────────────────────────────────────────

export function parseRubyFile(
  filePath: string,
  tagPrefix: string,
  linkConfigs?: LinkConfig[]
): ParsedTest[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const lines = source.split('\n');

  const pathTags  = extractPathTags(filePath);
  const results: ParsedTest[] = [];

  // Derive a relative path for automatedTestName
  const relPath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(IT_RE);
    if (!m) continue;

    const itDescription = m[2];
    const { docLines, azureId, tags: commentTags } = extractCommentBlockAbove(lines, i, tagPrefix);
    const contexts = findEnclosingContexts(lines, i);

    const allTags = [...new Set([...pathTags, ...commentTags])];
    const { title, steps } = parseSummary(docLines, itDescription, contexts);

    const fullDescription = [...contexts, itDescription].join(' ');
    const automatedTestName = `${relPath}::${fullDescription}`;

    results.push({
      filePath,
      title,
      steps,
      tags: allTags,
      azureId: azureId !== undefined && !isNaN(azureId) ? azureId : undefined,
      line: i + 1,
      linkRefs: extractLinkRefs(allTags, linkConfigs),
      automatedTestName,
      titleIsHeuristic: false,
    });
  }

  return results;
}
