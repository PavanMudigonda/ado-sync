/**
 * Python pytest parser for azure-test-sync.
 *
 * Detects  def test_*  functions (both module-level and inside test classes).
 *
 * Source mapping:
 *   Docstring first non-numbered line    → TC Title
 *   Numbered lines "N. text"             → TC Steps (action)
 *   "N. Check: text"                     → TC Steps (expected result column)
 *   @pytest.mark.xxx                     → TC Tags (user-defined marks)
 *   @pytest.mark.{tagPrefix}(N)          → Azure TC ID (preferred writeback form)
 *   # @{tagPrefix}:N  above the def      → Azure TC ID (comment fallback)
 *   module.ClassName.method_name         → automatedTestName
 *
 * ID writeback:
 *   Inserts / updates  @pytest.mark.{tagPrefix}(12345)  immediately above the
 *   def test_*  line (below any existing marks).
 *   No extra Python dependency — pytest is already on the test path.
 *
 * Built-in pytest marks that are NOT treated as user tags:
 *   parametrize, skip, skipif, xfail, usefixtures, filterwarnings
 *
 * Path-based auto-tagging: directory segments starting with '@' become tags.
 */

import * as fs from 'fs';

import { LinkConfig, ParsedStep, ParsedTest } from '../types';
import { extractLinkRefs, extractPathTags } from './shared';

// ─── Module path derivation ───────────────────────────────────────────────────

/**
 * Derive a dotted Python module path from the file path.
 * Looks for a common root directory (tests / test / src / lib) and uses the
 * path from that directory onward, stripping the .py extension.
 *
 * e.g. /project/tests/login/test_login.py → tests.login.test_login
 */
export function derivePythonModulePath(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const fileNameNoExt = (parts.pop() ?? '').replace(/\.py$/, '');

  const rootNames = new Set(['tests', 'test', 'src', 'lib']);
  let rootIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (rootNames.has(parts[i])) { rootIdx = i; break; }
  }

  if (rootIdx >= 0) return [...parts.slice(rootIdx), fileNameNoExt].join('.');
  return fileNameNoExt;
}

// ─── Enclosing class detection ────────────────────────────────────────────────

/**
 * Walk backward from the def line to find a class definition at a lower
 * indentation level.  Returns the class name, or '' for module-level functions.
 */
function findEnclosingClass(lines: string[], defLineIdx: number): string {
  const defIndent = (lines[defLineIdx].match(/^(\s*)/) ?? ['', ''])[1].length;

  for (let i = defLineIdx - 1; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const lineIndent = (line.match(/^(\s*)/) ?? ['', ''])[1].length;
    if (lineIndent < defIndent) {
      const m = trimmed.match(/^class\s+(\w+)/);
      return m ? m[1] : '';
    }
  }
  return '';
}

// ─── Test function detection ──────────────────────────────────────────────────

function isTestFunction(trimmedLine: string): boolean {
  return /^(?:async\s+)?def\s+test_\w+\s*\(/.test(trimmedLine);
}

function extractMethodName(trimmedLine: string): string {
  const m = trimmedLine.match(/^(?:async\s+)?def\s+(test_\w+)\s*\(/);
  return m ? m[1] : '';
}

// ─── Docstring extraction ─────────────────────────────────────────────────────

/**
 * Find and return the lines inside the docstring immediately following a
 * def statement.  Handles both single-line and multi-line """ / ''' forms.
 */
function extractDocstring(lines: string[], defLineIdx: number): string[] {
  let i = defLineIdx + 1;
  // Skip the rest of the def signature if it spans multiple lines
  while (i < lines.length && !lines[i - 1].trim().endsWith(':') && lines[i].trim() === '') i++;
  // Skip blank lines between def and body
  while (i < lines.length && lines[i].trim() === '') i++;

  if (i >= lines.length) return [];

  const firstLine = lines[i].trim();
  let quote: '"""' | "'''";
  if (firstLine.startsWith('"""'))      quote = '"""';
  else if (firstLine.startsWith("'''")) quote = "'''";
  else return [];

  const afterOpen = firstLine.slice(3);

  // Single-line: """text"""
  if (afterOpen.endsWith(quote)) {
    const text = afterOpen.slice(0, afterOpen.length - 3).trim();
    return text ? [text] : [];
  }
  // Opening triple-quote with immediate text on same line
  const content: string[] = [];
  if (afterOpen.trim()) content.push(afterOpen.trim());
  i++;

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed.endsWith(quote)) {
      const before = trimmed.slice(0, trimmed.length - 3).trim();
      if (before) content.push(before);
      break;
    }
    content.push(trimmed);
    i++;
  }

  // Drop leading/trailing blank lines inside the docstring
  while (content.length && content[0] === '') content.shift();
  while (content.length && content[content.length - 1] === '') content.pop();
  return content;
}

// ─── Decorator block scanning ─────────────────────────────────────────────────

// pytest built-in marks that should NOT be treated as user-defined tags
const PYTEST_BUILTINS = new Set([
  'parametrize', 'skip', 'skipif', 'xfail', 'usefixtures', 'filterwarnings',
]);

interface PythonDecorators {
  marks: string[];
  azureId?: number;
}

/**
 * Scan backward from defLineIdx to collect pytest marks and a TC ID.
 *
 * Stops at:
 *   - blank lines (decorators in Python must be adjacent to def)
 *   - another function or class definition
 *   - any non-decorator, non-comment source line
 *
 * Multi-line decorator arguments (e.g. multi-line @parametrize) are skipped
 * over using a parenthesis depth counter so the scan continues correctly.
 */
function extractDecoratorsAbove(
  lines: string[],
  defLineIdx: number,
  tagPrefix: string
): PythonDecorators {
  const marks: string[] = [];
  let azureId: number | undefined;

  const idMarkRe   = new RegExp(`^@pytest\\.mark\\.${tagPrefix}\\((\\d+)\\)\\s*$`);
  const markRe     = /^@pytest\.mark\.(\w+)(?:\s*\(.*)?$/;
  const commentIdRe = new RegExp(`#\\s*@${tagPrefix}:(\\d+)`);

  let parenDepth = 0; // track open parens for multi-line decorators

  for (let i = defLineIdx - 1; i >= 0 && i >= defLineIdx - 50; i--) {
    const line = lines[i];
    const trimmed = line.trim();

    // Track parenthesis depth (scanning backward, so ) opens, ( closes)
    for (const ch of trimmed) {
      if (ch === ')') parenDepth++;
      if (ch === '(') parenDepth = Math.max(0, parenDepth - 1);
    }

    // While inside a multi-line decorator argument, keep going
    if (parenDepth > 0) continue;

    // Blank line — decorators must be adjacent
    if (trimmed === '') break;

    // Another function or class definition
    if (/^(?:async\s+)?def\s+/.test(trimmed) || /^class\s+/.test(trimmed)) break;

    // Comment with an ID: # @tc:12345
    const cmtMatch = trimmed.match(commentIdRe);
    if (cmtMatch && azureId === undefined) {
      azureId = parseInt(cmtMatch[1], 10);
      continue;
    }

    // Decorator line
    if (trimmed.startsWith('@')) {
      // ID mark: @pytest.mark.tc(12345)
      const idMatch = trimmed.match(idMarkRe);
      if (idMatch) {
        if (azureId === undefined) azureId = parseInt(idMatch[1], 10);
        continue;
      }

      // Regular mark: @pytest.mark.smoke
      const markMatch = trimmed.match(markRe);
      if (markMatch) {
        const name = markMatch[1];
        if (!PYTEST_BUILTINS.has(name) && name !== tagPrefix) marks.push(name);
        continue;
      }

      // Other decorator (@staticmethod, @classmethod, etc.) — ignore
      continue;
    }

    // Any other source line → stop
    break;
  }

  return { marks, azureId };
}

// ─── Docstring → title + steps ────────────────────────────────────────────────

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
    // Convert snake_case to readable words:  test_user_login → user login
    title = methodName.replace(/^test_/, '').replace(/_/g, ' ');
  }

  return { title, steps, titleIsHeuristic };
}

// ─── Public parser ────────────────────────────────────────────────────────────

export function parsePythonFile(
  filePath: string,
  tagPrefix: string,
  linkConfigs?: LinkConfig[]
): ParsedTest[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const lines = source.split('\n');

  const modulePath = derivePythonModulePath(filePath);
  const pathTags   = extractPathTags(filePath);
  const results: ParsedTest[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!isTestFunction(trimmed)) continue;

    const defLineIdx = i;
    const methodName = extractMethodName(trimmed);
    if (!methodName) continue;

    const className  = findEnclosingClass(lines, defLineIdx);
    const docLines   = extractDocstring(lines, defLineIdx);
    const { marks, azureId } = extractDecoratorsAbove(lines, defLineIdx, tagPrefix);

    const allTags = [...new Set([...pathTags, ...marks])];
    const { title, steps, titleIsHeuristic } = parseSummary(docLines, methodName);
    const fqmn = [modulePath, className, methodName].filter(Boolean).join('.');

    results.push({
      filePath,
      title,
      steps,
      tags: allTags,
      azureId: azureId !== undefined && !isNaN(azureId) ? azureId : undefined,
      line: defLineIdx + 1, // 1-based; writeback targets this def line
      linkRefs: extractLinkRefs(allTags, linkConfigs),
      automatedTestName: fqmn || undefined,
      titleIsHeuristic,
    });
  }

  return results;
}
