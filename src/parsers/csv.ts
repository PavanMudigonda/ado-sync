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

import { LinkConfig, ParsedStep, ParsedTest } from '../types';
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

// ─── CSV serialiser ───────────────────────────────────────────────────────────

/** Quote a single cell value if it contains commas, quotes, or newlines. */
function serializeCsvCell(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

/** Serialise a row of already-unquoted cell values back to a valid CSV line. */
function serializeCsvLine(cells: string[]): string {
  return cells.map(serializeCsvCell).join(',');
}

// ─── ID writeback ─────────────────────────────────────────────────────────────

/**
 * Write (or update) the TC ID in column A of the matching title row in a CSV file.
 *
 * Strategy:
 *  1. Parse the CSV into raw lines.
 *  2. Find the data row whose Title column (col 2) normalises to the test's title.
 *  3. Replace (or insert) the ID field (col 0) with the new numeric id.
 *  4. Re-serialise with proper quoting and write back.
 *
 * Note: rows that already have an ID are updated too — this handles the case
 * where a deleted TC is re-created with a new ID.
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
    const titleCell = cells[2]?.trim() ?? '';
    const stepCell  = cells[3]?.trim() ?? '';

    // Match title rows (non-empty title, no step number) by normalised title.
    // Allow any existing ID value — handles re-creation of deleted TCs.
    if (titleCell && !stepCell && normalize(titleCell) === title) {
      cells[0] = String(id);
      // Pad to at least 9 columns before re-serialising
      while (cells.length < 9) cells.push('');
      return serializeCsvLine(cells);
    }
    return line;
  });

  const result = (hasBom ? '\uFEFF' : '') + updated.join('\n');
  fs.writeFileSync(filePath, result, 'utf8');
}

// ─── Pull / apply remote changes ─────────────────────────────────────────────

/**
 * Apply a title + steps update from Azure DevOps back into a CSV file.
 *
 * Finds the row matching `currentTitle`, updates the Title cell (col C) and
 * replaces all subsequent step rows with the new steps from Azure.
 */
export function applyRemoteToCsv(
  filePath: string,
  currentTitle: string,
  newTitle: string,
  newSteps: ParsedStep[]
): void {
  const source = fs.readFileSync(filePath, 'utf8');
  const hasBom = source.startsWith('\uFEFF');
  const text = hasBom ? source.slice(1) : source;
  const lines = text.split(/\r?\n/);

  const TITLE_STRIP_RE = /^(Scenario Outline|Scenario)\s*:\s*/i;
  const normalize = (s: string) => s.replace(TITLE_STRIP_RE, '').trim();

  // Find the title row
  let titleRowIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const titleCell = cells[2]?.trim() ?? '';
    const stepCell  = cells[3]?.trim() ?? '';
    if (titleCell && !stepCell && normalize(titleCell) === currentTitle) {
      titleRowIdx = i;
      break;
    }
  }
  if (titleRowIdx === -1) return; // not found

  // Find the extent of the existing step rows (up to the next title row or end)
  let nextTitleIdx = lines.length;
  for (let i = titleRowIdx + 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const titleCell = cells[2]?.trim() ?? '';
    const stepCell  = cells[3]?.trim() ?? '';
    if (titleCell && !stepCell && titleCell.toLowerCase() !== 'title') {
      nextTitleIdx = i;
      break;
    }
  }

  // Update the title row — preserve ID and prefix ("Scenario: " etc.)
  const titleRowCells = parseCsvLine(lines[titleRowIdx]);
  while (titleRowCells.length < 9) titleRowCells.push('');
  const prefix = (titleRowCells[2]?.match(TITLE_STRIP_RE)?.[0] ?? '');
  titleRowCells[2] = prefix + newTitle;

  // Build new step rows using the Azure step action text (already includes keyword)
  const newStepRows = newSteps.map((step, idx) => {
    const action = step.text; // Azure action already includes "Given"/"When"/etc.
    const cells = ['', '', '', String(idx + 1), action, step.expected ?? '', '', '', ''];
    return serializeCsvLine(cells);
  });

  const updatedLines = [
    ...lines.slice(0, titleRowIdx),
    serializeCsvLine(titleRowCells),
    ...newStepRows,
    ...lines.slice(nextTitleIdx),
  ];

  const result = (hasBom ? '\uFEFF' : '') + updatedLines.join('\n');
  fs.writeFileSync(filePath, result, 'utf8');
}
