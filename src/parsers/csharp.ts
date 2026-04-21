/**
 * C# test parser for azure-test-sync.
 *
 * Supports both MSTest and NUnit frameworks:
 *
 *   Framework  Test marker    Category attr          Property attr
 *   ─────────  ───────────    ─────────────          ─────────────
 *   MSTest     [TestMethod]   [TestCategory("name")] [TestProperty("key","val")]
 *   NUnit      [Test]         [Category("name")]     [Property("key","val")]
 *
 * Source mapping:
 *   XML doc <summary> first line          → TC Title
 *   Numbered lines in <summary> "N. text" → TC Steps (action)
 *   "N. Check: text" lines                → TC Steps (keyword: 'Then' → expected col)
 *   [TestCategory("...")] / [Category("...")] → TC Tags (string literals only)
 *   [TestProperty("<tagPrefix>","N")] /
 *   [Property("<tagPrefix>","N")]          → Azure TC ID (written back after push)
 *   Namespace.ClassName.MethodName         → automatedTestName (for TRX result linking)
 *
 * ID writeback:
 *   MSTest → [TestProperty("tc", "12345")]
 *   NUnit  → [Property("tc", "12345")]
 *
 * The detected framework is stored in each ParsedTest so writeback uses the
 * correct attribute form without having to re-read the file.
 *
 * Path-based auto-tagging: directory segments starting with '@' become tags.
 */

import * as fs from 'fs';

import { normalizeMarkerTagPrefixes } from '../id-markers';
import { LinkConfig, ParsedStep, ParsedTest } from '../types';
import { extractLinkRefs, extractPathTags } from './shared';

// ─── Framework detection ──────────────────────────────────────────────────────

type CsTestFramework = 'mstest' | 'nunit';

/**
 * Check whether a (trimmed) line is a [TestMethod] (MSTest) or [Test] / [Test(...)] (NUnit)
 * attribute marker. Returns the detected framework, or null if neither.
 */
function detectTestMarker(trimmedLine: string): CsTestFramework | null {
  if (/^\[TestMethod[\]( ]/.test(trimmedLine) || trimmedLine === '[TestMethod]') {
    return 'mstest';
  }
  // [Test] or [Test("name")] but NOT [TestCase], [TestFixture], etc.
  if (/^\[Test[\]( ]/.test(trimmedLine) || trimmedLine === '[Test]') {
    // Exclude [TestCase(...)] — those are parameterised data rows, not a test marker
    if (/^\[TestCase[\]( ]/.test(trimmedLine) || /^\[TestCaseSource[\]( ]/.test(trimmedLine)) {
      return null;
    }
    return 'nunit';
  }
  return null;
}

// ─── Namespace / class extraction ────────────────────────────────────────────

function extractNamespace(lines: string[]): string {
  for (const line of lines) {
    const m = line.match(/^\s*namespace\s+([\w.]+)/);
    if (m) return m[1];
  }
  return '';
}

function extractClassName(lines: string[]): string {
  for (const line of lines) {
    // Handles optional partial, abstract, sealed modifiers before "class"
    const m = line.match(/^\s*(?:(?:public|internal|private|protected)\s+)?(?:(?:partial|abstract|sealed)\s+)*class\s+(\w+)/);
    if (m) return m[1];
  }
  return '';
}

// ─── Local string constant resolution ────────────────────────────────────────

function resolveStringConstants(lines: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of lines) {
    const m = line.match(/\bconst\s+string\s+(\w+)\s*=\s*"([^"]*)"/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

// ─── XML doc comment extraction ───────────────────────────────────────────────

function extractSummaryBefore(lines: string[], testMethodLineIdx: number): string[] {
  const raw: string[] = [];
  let i = testMethodLineIdx - 1;
  while (i >= 0 && /^\s*\/\/\//.test(lines[i])) {
    raw.unshift(lines[i]);
    i--;
  }

  const stripped = raw.map((l) => l.replace(/^\s*\/\/\/\s?/, '').trim());

  const startIdx = stripped.findIndex((l) => /<summary>/i.test(l));
  const endIdx   = stripped.findIndex((l) => /<\/summary>/i.test(l));
  if (startIdx === -1) return stripped;

  return stripped.slice(startIdx + 1, endIdx === -1 ? undefined : endIdx);
}

// ─── Summary → title + steps ─────────────────────────────────────────────────

const META_RE        = /^(?:test\s+case|user\s+story)[\s:]/i;
const NUMBERED_STEP_RE = /^\d+\.\s+(.+)$/;
const CHECK_RE       = /^[Cc]heck:\s+(.+)$/;

function parseSummary(
  summaryLines: string[],
  methodName: string
): { title: string; steps: ParsedStep[]; titleIsHeuristic: boolean } {
  let title = '';
  const steps: ParsedStep[] = [];

  for (const line of summaryLines) {
    if (!line || META_RE.test(line)) continue;

    const numMatch = NUMBERED_STEP_RE.exec(line);
    if (numMatch) {
      const content = numMatch[1].trim();
      const checkMatch = CHECK_RE.exec(content);
      if (checkMatch) {
        // Check: → Then keyword → expected result column when useExpectedResult is true
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
    title = methodName.replace(/([A-Z])/g, ' $1').trim();
  }

  return { title, steps, titleIsHeuristic };
}

// ─── Attribute scanning ───────────────────────────────────────────────────────

interface MethodAttributes {
  categories: string[];
  properties: Map<string, string>;
  methodName: string;
  endLine: number;
}

function extractAttributesAndMethod(
  lines: string[],
  testMethodLineIdx: number,
  _tagPrefix: string | string[],
  constants: Map<string, string>
): MethodAttributes {
  const categories: string[] = [];
  const properties = new Map<string, string>();
  let methodName = '';
  let endLine = testMethodLineIdx;

  for (let i = testMethodLineIdx + 1; i < lines.length && i < testMethodLineIdx + 30; i++) {
    const line = lines[i].trim();
    endLine = i;

    // Method signature — extract name and stop
    const methodMatch = line.match(/(?:public|private|protected|internal)\s+(?:(?:async|static|virtual|override)\s+)*(?:void|Task|[\w<>[\]]+)\s+(\w+)\s*\(/);
    if (methodMatch) {
      methodName = methodMatch[1];
      break;
    }

    // [TestCategory("literal"|CONSTANT)] — MSTest
    const msCatMatch = line.match(/\[TestCategory\(\s*(?:"([^"]+)"|([A-Za-z_]\w*))\s*\)\]/);
    if (msCatMatch) {
      const literal = msCatMatch[1];
      const constName = msCatMatch[2];
      if (literal) {
        categories.push(literal);
      } else if (constName && constants.has(constName)) {
        categories.push(constants.get(constName)!);
      }
      continue;
    }

    // [Category("literal"|CONSTANT)] — NUnit
    // Use a negative lookbehind concept: ensure it's [Category(], not [TestCategory(]
    const nuCatMatch = line.match(/(?<!\w)\[Category\(\s*(?:"([^"]+)"|([A-Za-z_]\w*))\s*\)\]/);
    if (nuCatMatch) {
      const literal = nuCatMatch[1];
      const constName = nuCatMatch[2];
      if (literal) {
        categories.push(literal);
      } else if (constName && constants.has(constName)) {
        categories.push(constants.get(constName)!);
      }
      continue;
    }

    // [TestProperty("key", "value")] — MSTest
    const msPropMatch = line.match(/\[TestProperty\(\s*"([^"]+)"\s*,\s*"([^"]*)"\s*\)\]/);
    if (msPropMatch) {
      properties.set(msPropMatch[1], msPropMatch[2]);
      continue;
    }

    // [Property("key", "value")] — NUnit
    const nuPropMatch = line.match(/(?<!\w)\[Property\(\s*"([^"]+)"\s*,\s*"([^"]*)"\s*\)\]/);
    if (nuPropMatch) {
      properties.set(nuPropMatch[1], nuPropMatch[2]);
      continue;
    }

    if (!line || line === '{') break;
  }

  return { categories, properties, methodName, endLine };
}

// ─── Public parser ────────────────────────────────────────────────────────────

export function parseCsharpFile(
  filePath: string,
  tagPrefix: string | string[],
  linkConfigs?: LinkConfig[]
): ParsedTest[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const lines = source.split('\n');

  const namespace = extractNamespace(lines);
  const className = extractClassName(lines);
  const constants = resolveStringConstants(lines);
  const markerTagPrefixes = normalizeMarkerTagPrefixes(tagPrefix);
  const pathTags = extractPathTags(filePath);

  const results: ParsedTest[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const framework = detectTestMarker(trimmed);
    if (!framework) continue;

    const testMethodLineIdx = i;
    const summaryLines = extractSummaryBefore(lines, testMethodLineIdx);
    const { categories, properties, methodName, endLine } = extractAttributesAndMethod(
      lines,
      testMethodLineIdx,
      tagPrefix,
      constants
    );

    if (!methodName) {
      i = endLine;
      continue;
    }

    const { title, steps, titleIsHeuristic } = parseSummary(summaryLines, methodName);

    const tcIdStr = markerTagPrefixes.map((prefix) => properties.get(prefix)).find((value) => value !== undefined);
    const azureId = tcIdStr ? parseInt(tcIdStr, 10) : undefined;

    const tags = [...new Set([...pathTags, ...categories])];
    const fqmn = [namespace, className, methodName].filter(Boolean).join('.');

    results.push({
      filePath,
      title,
      steps,
      tags,
      azureId: azureId !== undefined && !isNaN(azureId) ? azureId : undefined,
      line: testMethodLineIdx + 1, // 1-based; writeback uses this
      linkRefs: extractLinkRefs(tags, linkConfigs),
      automatedTestName: fqmn || undefined,
      titleIsHeuristic,
    });

    i = endLine;
  }

  return results;
}
