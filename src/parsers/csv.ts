/**
 * CSV test spec parser.
 *
 * Reads the Azure DevOps / SpecSync CSV export format:
 *
 *   ID,Work Item Type,Title,Test Step,Step Action,Step Expected,Area Path,Assigned To,State
 *   "24213","Test Case","Scenario: Login test",,,,...
 *   ,,,,"1","Given I open the app",,,,
 *   ,,,,"2","When I click login","Then I see dashboard",,
 *
 * ID writeback: updates column A on the title row for newly created test cases.
 */

import * as fs from 'fs';

import { LinkConfig, ParsedTest } from '../types';
import { parseTabularRows, TabularRow } from './tabular';

// ─── RFC-4180 CSV parser ───────────────────────────────────────────────────────

/** Parse a single CSV line, handling quoted fields and escaped quotes (""). */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      // Quoted field
      let field = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          field += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++;
          break;
        } else {
          field += line[i++];
        }
      }
      fields.push(field);
      if (line[i] === ',') i++;
    } else {
      // Unquoted field
      const end = line.indexOf(',', i);
      if (end === -1) {
        fields.push(line.slice(i));
        break;
      }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

/** Parse CSV source text into rows of cells. Handles BOM. */
function parseCsv(source: string): string[][] {
  // Strip BOM
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source;
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map(parseCsvLine);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function parseCsvFile(
  filePath: string,
  tagPrefix: string,
  linkConfigs?: LinkConfig[]
): ParsedTest[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const rawRows = parseCsv(source);

  const rows: TabularRow[] = rawRows.map((cells, idx) => ({
    cells: cells.concat(Array(Math.max(0, 9 - cells.length)).fill('')), // pad to 9 cols
    rowIndex: idx + 1, // 1-based
  }));

  return parseTabularRows(rows, filePath, tagPrefix, linkConfigs);
}

// ─── ID writeback ─────────────────────────────────────────────────────────────

/**
 * Write (or update) the TC ID in column A of the matching title row in a CSV file.
 *
 * Strategy:
 *  1. Parse the CSV into raw lines.
 *  2. Find the data row whose Title column (col 2) normalises to the test's title.
 *  3. Replace the ID field (col 0) with the new numeric id.
 *  4. Re-serialise and write back.
 */
export function writebackCsv(filePath: string, title: string, id: number): void {
  const source = fs.readFileSync(filePath, 'utf8');
  const hasBom = source.startsWith('\uFEFF');
  const text = hasBom ? source.slice(1) : source;
  const lines = text.split(/\r?\n/);

  const TITLE_STRIP_RE = /^(Scenario Outline|Scenario)\s*:\s*/i;
  const normalize = (s: string) => s.replace(TITLE_STRIP_RE, '').trim();

  const updated = lines.map((line) => {
    const cells = parseCsvLine(line);
    const titleCell = cells[2]?.replace(/^"|"$/g, '') ?? '';
    const stepCell  = cells[3]?.replace(/^"|"$/g, '') ?? '';
    const idCell    = cells[0]?.replace(/^"|"$/g, '') ?? '';

    // Match: has title, no step number, and ID is currently empty or matches a previous ID
    if (titleCell && !stepCell && !idCell && normalize(titleCell) === title) {
      cells[0] = `"${id}"`;
      return cells.join(',');
    }
    return line;
  });

  const result = (hasBom ? '\uFEFF' : '') + updated.join('\n');
  fs.writeFileSync(filePath, result, 'utf8');
}
