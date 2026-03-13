/**
 * PHP PHPUnit parser for azure-test-sync.
 *
 * Detects test methods in PHPUnit test classes:
 *   - public function test*()     (method name starts with "test")
 *   - @test in docblock above method
 *
 * Source mapping:
 *   Docblock first non-step line        → TC Title
 *   Numbered lines "N. text" in doc     → TC Steps
 *   /** @tc N * /                       → Azure TC ID
 *   /** @group smoke * /                → TC Tags
 *   Namespace\ClassName::methodName     → automatedTestName
 *
 * ID writeback:
 *   Inserts / updates  * @tc N  in the docblock above the method.
 *   If no docblock exists, inserts one.
 *
 * Path-based auto-tagging: directory segments starting with '@' become tags.
 */

import * as fs from 'fs';

import { LinkConfig, ParsedStep, ParsedTest } from '../types';
import { extractLinkRefs, extractPathTags } from './shared';

// ─── Test method detection ────────────────────────────────────────────────────

// Matches: public function testXxx( or public function testXxx (
const TEST_METHOD_RE = /^\s*public\s+function\s+(test\w+)\s*\(/;

// ─── Namespace / class extraction ────────────────────────────────────────────

function findNamespaceAndClass(lines: string[], methodLineIdx: number): { ns: string; cls: string } {
  let ns = '';
  let cls = '';

  for (let i = methodLineIdx - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();

    if (!cls) {
      const m = trimmed.match(/^(?:abstract\s+)?class\s+(\w+)/);
      if (m) cls = m[1];
    }

    if (!ns) {
      const m = trimmed.match(/^namespace\s+([\w\\]+)\s*;/);
      if (m) ns = m[1];
    }

    if (cls && ns) break;
  }

  return { ns, cls };
}

// ─── Docblock scanning ────────────────────────────────────────────────────────

interface PhpDocBlock {
  docLines: string[];
  azureId?: number;
  tags: string[];
  hasTestAnnotation: boolean;
}

function extractDocBlockAbove(
  lines: string[],
  methodLineIdx: number,
  tagPrefix: string
): PhpDocBlock {
  const docLines: string[] = [];
  let azureId: number | undefined;
  const tags: string[] = [];
  let hasTestAnnotation = false;

  // Find the closing */ of a docblock immediately before the method line
  // (possibly with a blank line or other annotations between)
  let docEnd = -1;
  for (let i = methodLineIdx - 1; i >= 0 && i >= methodLineIdx - 5; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === '') continue;
    if (trimmed === '*/') { docEnd = i; break; }
    // Could have attribute-style annotations like #[Attribute] between doc and method
    if (trimmed.startsWith('#[') || trimmed.startsWith('@') || trimmed.startsWith('//')) continue;
    break;
  }

  if (docEnd < 0) return { docLines, azureId, tags, hasTestAnnotation };

  const idRe    = new RegExp(`@${tagPrefix}\\s+(\\d+)`);
  const groupRe = /@group\s+(\w+)/;

  // Walk backward from docEnd to find /**
  for (let i = docEnd - 1; i >= 0 && i >= docEnd - 50; i--) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Strip leading * or /**
    const content = trimmed.replace(/^\/\*\*?\s?/, '').replace(/^\*\s?/, '').trim();

    const idMatch = content.match(idRe);
    if (idMatch) {
      if (azureId === undefined) azureId = parseInt(idMatch[1], 10);
    }

    const groupMatch = content.match(groupRe);
    if (groupMatch) tags.push(groupMatch[1]);

    if (content.trim() === '@test') hasTestAnnotation = true;

    if (content && !content.startsWith('@') && !content.startsWith('/')) {
      docLines.unshift(content);
    }

    // Reached docblock start
    if (trimmed.startsWith('/**') || trimmed === '/*') break;
  }

  return { docLines, azureId, tags, hasTestAnnotation };
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
    // testUserCanLogin → User Can Login
    title = methodName
      .replace(/^test/, '')
      .replace(/([A-Z])/g, ' $1')
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/^\w/, (c) => c.toUpperCase());
    if (!title) title = methodName;
  }

  return { title, steps, titleIsHeuristic };
}

// ─── Public parser ────────────────────────────────────────────────────────────

export function parsePhpFile(
  filePath: string,
  tagPrefix: string,
  linkConfigs?: LinkConfig[]
): ParsedTest[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const lines = source.split('\n');

  const pathTags = extractPathTags(filePath);
  const results: ParsedTest[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Check for public function testXxx()
    const methodMatch = trimmed.match(TEST_METHOD_RE);
    if (!methodMatch) continue;

    const methodName = methodMatch[1];
    const { ns, cls } = findNamespaceAndClass(lines, i);
    const { docLines, azureId, tags: docTags } = extractDocBlockAbove(lines, i, tagPrefix);

    const allTags = [...new Set([...pathTags, ...docTags])];
    const { title, steps, titleIsHeuristic } = parseSummary(docLines, methodName);

    const nsFormatted = ns.replace(/\\/g, '\\');
    const automatedTestName = [nsFormatted, cls, methodName].filter(Boolean).join('::');

    results.push({
      filePath,
      title,
      steps,
      tags: allTags,
      azureId: azureId !== undefined && !isNaN(azureId) ? azureId : undefined,
      line: i + 1,
      linkRefs: extractLinkRefs(allTags, linkConfigs),
      automatedTestName: automatedTestName || undefined,
      titleIsHeuristic,
    });
  }

  return results;
}
