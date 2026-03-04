/**
 * Shared tabular parser — converts the Azure DevOps CSV/Excel export row format
 * into ParsedTest objects.
 *
 * Row format (9 columns):
 *   Col 0  ID            – numeric TC id, or empty for new cases
 *   Col 1  Work Item Type – always "Test Case" (ignored)
 *   Col 2  Title         – "Scenario: X" or "Scenario Outline: X" or just "X"
 *   Col 3  Test Step     – step number (1, 2, …), empty on the title row
 *   Col 4  Step Action   – step text (may include keyword prefix like "Given ")
 *   Col 5  Step Expected – expected result text, empty when none
 *   Col 6  Area Path     – ignored during parse, preserved in config
 *   Col 7  Assigned To   – ignored
 *   Col 8  State         – ignored
 *
 * A "test case block" consists of:
 *   1. A header row: non-empty Title (col 2), empty Test Step (col 3)
 *   2. Zero or more step rows: empty Title, non-empty Test Step
 *
 * The first row in the file is always the column-header row (ID, Work Item Type, …)
 * and is skipped automatically.
 */

import { LinkConfig, ParsedStep, ParsedTest } from '../types';
import { extractLinkRefs, extractPathTags } from './shared';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TITLE_STRIP_RE = /^(Scenario Outline|Scenario)\s*:\s*/i;
const STEP_KEYWORD_RE = /^(Background:\s*)?(Given|When|Then|And|But|Parameters|Scenario Outline|Scenario|\*)\s+/i;

/** Strip "Scenario: " / "Scenario Outline: " prefix from a title cell. */
function normalizeTitle(raw: string): string {
  return raw.replace(TITLE_STRIP_RE, '').trim();
}

/** Split a step action cell into keyword + text. */
function parseStepAction(raw: string): { keyword: string; text: string } {
  raw = raw.trim();
  const m = raw.match(STEP_KEYWORD_RE);
  if (!m) return { keyword: 'Step', text: raw };
  const keyword = m[0].replace(/^Background:\s*/i, '').trim();
  const text = raw.slice(m[0].length).trim();
  return { keyword, text };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface TabularRow {
  /** 9-element array: [ID, WorkItemType, Title, TestStep, StepAction, StepExpected, AreaPath, AssignedTo, State] */
  cells: string[];
  /** 1-based line/row number in the source file (for writeback). */
  rowIndex: number;
}

/**
 * Parse an array of TabularRow (already past the header row) into ParsedTest[].
 *
 * @param rows       All rows from the file including the column-header row.
 * @param filePath   Absolute path to the source file.
 * @param tagPrefix  Tag prefix for TC ID tags (e.g. 'tc').
 * @param linkConfigs Optional link configurations.
 */
export function parseTabularRows(
  rows: TabularRow[],
  filePath: string,
  _tagPrefix: string,
  linkConfigs: LinkConfig[] | undefined
): ParsedTest[] {
  const pathTags = extractPathTags(filePath);
  const tests: ParsedTest[] = [];

  // Skip column-header row (first row)
  let i = 0;
  if (rows.length > 0 && rows[0].cells[0].trim().toLowerCase() === 'id') i = 1;

  while (i < rows.length) {
    const row = rows[i];
    const titleCell = row.cells[2]?.trim() ?? '';
    const stepCell  = row.cells[3]?.trim() ?? '';

    // A test-case header row: has a title and no step number
    if (titleCell && !stepCell) {
      const idRaw = row.cells[0]?.trim() ?? '';
      const azureId = idRaw && !isNaN(Number(idRaw)) ? parseInt(idRaw, 10) : undefined;

      const title = normalizeTitle(titleCell);
      const steps: ParsedStep[] = [];

      // Collect subsequent step rows
      i++;
      while (i < rows.length) {
        const sr = rows[i];
        const srTitle = sr.cells[2]?.trim() ?? '';
        const srStep  = sr.cells[3]?.trim() ?? '';
        if (srTitle && !srStep) break; // next test case header
        if (srStep) {
          const actionRaw   = sr.cells[4]?.trim() ?? '';
          const expectedRaw = sr.cells[5]?.trim() ?? '';
          if (actionRaw) {
            const { keyword, text } = parseStepAction(actionRaw);
            steps.push({
              keyword,
              text,
              expected: expectedRaw || undefined,
            });
          }
        }
        i++;
      }

      tests.push({
        filePath,
        title,
        steps,
        tags: [...pathTags],
        azureId,
        line: row.rowIndex,
        linkRefs: extractLinkRefs(pathTags, linkConfigs),
      });
    } else {
      i++;
    }
  }

  return tests;
}
