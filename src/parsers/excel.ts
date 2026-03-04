/**
 * Excel (.xlsx) test spec parser.
 *
 * Reads the Azure DevOps / SpecSync xlsx export format. The xlsx files produced
 * by this toolchain use a custom non-standard structure (no shared strings,
 * inline strings for rich-text step cells), so we parse the raw XML directly
 * using JSZip (already a transitive dependency) instead of a heavyweight xlsx
 * library that may not handle this format.
 *
 * Cell types observed:
 *   t="str"       → plain string in <v>
 *   t="n"         → number in <v>
 *   t="inlineStr" → rich text in <is><r><t> …</t></r></is>; concat all <t> runs
 *
 * ID writeback rewrites the xlsx XML in place (updates the ID cell on the
 * matching title row).
 */

import * as fs from 'fs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const JSZip = require('jszip');

import { LinkConfig, ParsedTest } from '../types';
import { parseTabularRows, TabularRow } from './tabular';

// ─── XML helpers ──────────────────────────────────────────────────────────────

/** Determine the namespace prefix used in this XML (may be "x:" or none). */
function detectNsPrefix(xml: string): string {
  const m = xml.match(/xmlns(?::(\w+))?="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"/);
  return m?.[1] ? `${m[1]}:` : '';
}

/** Extract the text value from a cell element string. */
function cellText(cellXml: string, nsPrefix: string): string {
  // inlineStr: <{ns}is> containing <{ns}r><{ns}t>…</…> runs
  const isMatch = cellXml.match(new RegExp(`<${nsPrefix}is>([\\s\\S]*?)<\\/${nsPrefix}is>`));
  if (isMatch) {
    const tRe = new RegExp(`<${nsPrefix}t[^>]*>([\\s\\S]*?)<\\/${nsPrefix}t>`, 'g');
    const parts: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = tRe.exec(isMatch[1])) !== null) {
      parts.push(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"'));
    }
    return parts.join('');
  }
  // plain value in <v>
  const vMatch = cellXml.match(new RegExp(`<${nsPrefix}v>([\\s\\S]*?)<\\/${nsPrefix}v>`));
  if (vMatch) {
    return vMatch[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  }
  return '';
}

/** Parse all rows from the sheet XML. Returns array of string-array rows. */
function parseSheetXml(xml: string): string[][] {
  const nsPrefix = detectNsPrefix(xml);
  const rowRe = new RegExp(`<${nsPrefix}row([^>]*)>([\\s\\S]*?)<\\/${nsPrefix}row>`, 'g');
  const cellRe = new RegExp(`<${nsPrefix}c([^>]*)>([\\s\\S]*?)<\\/${nsPrefix}c>`, 'g');

  const rows: string[][] = [];
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const rowContent = rowMatch[2];
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;

    while ((cellMatch = cellRe.exec(rowContent)) !== null) {
      cells.push(cellText(cellMatch[0], nsPrefix));
    }

    rows.push(cells);
  }

  return rows;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function parseExcelFile(
  filePath: string,
  tagPrefix: string,
  linkConfigs?: LinkConfig[]
): Promise<ParsedTest[]> {
  const buffer = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buffer);

  // Find the sheet XML — may be sheet.xml or sheet1.xml
  const sheetEntry =
    zip.file('xl/worksheets/sheet.xml') ??
    zip.file('xl/worksheets/sheet1.xml');

  if (!sheetEntry) throw new Error(`No worksheet found in ${filePath}`);

  const xml: string = await sheetEntry.async('string');
  // Strip BOM if present
  const cleanXml = xml.startsWith('\uFEFF') ? xml.slice(1) : xml;

  const rawRows = parseSheetXml(cleanXml);

  const rows: TabularRow[] = rawRows.map((cells, idx) => ({
    cells: cells.concat(Array(Math.max(0, 9 - cells.length)).fill('')),
    rowIndex: idx + 1, // 1-based
  }));

  return parseTabularRows(rows, filePath, tagPrefix, linkConfigs);
}

// ─── ID writeback ─────────────────────────────────────────────────────────────

/**
 * Write (or update) the TC ID in column A of the matching title row in an xlsx file.
 *
 * Strategy:
 *  1. Load the xlsx zip.
 *  2. Parse the sheet XML.
 *  3. Find the row matching the test title where ID is currently empty.
 *  4. Replace the empty ID cell XML with a numeric cell containing the new id.
 *  5. Repack the zip and write back.
 */
export async function writebackExcel(filePath: string, title: string, id: number): Promise<void> {
  const buffer = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buffer);

  const sheetKey =
    zip.file('xl/worksheets/sheet.xml') ? 'xl/worksheets/sheet.xml' :
    zip.file('xl/worksheets/sheet1.xml') ? 'xl/worksheets/sheet1.xml' :
    null;

  if (!sheetKey) throw new Error(`No worksheet found in ${filePath}`);

  let xml: string = await zip.file(sheetKey).async('string');
  const hasBom = xml.startsWith('\uFEFF');
  if (hasBom) xml = xml.slice(1);

  const nsPrefix = detectNsPrefix(xml);
  const TITLE_STRIP_RE = /^(Scenario Outline|Scenario)\s*:\s*/i;
  const normalise = (s: string) => s.replace(TITLE_STRIP_RE, '').trim();

  // Split into rows, find the matching one, and update its first cell
  const rowRe = new RegExp(`(<${nsPrefix}row[^>]*>)([\\s\\S]*?)(<\\/${nsPrefix}row>)`, 'g');

  let updated = false;
  const newXml = xml.replace(rowRe, (_full, open, content, close) => {
    if (updated) return open + content + close;

    // Extract cells from this row
    const cellRe = new RegExp(`<${nsPrefix}c([^>]*)>([\\s\\S]*?)<\\/${nsPrefix}c>`, 'g');
    const cellMatches = [...content.matchAll(cellRe)];
    if (cellMatches.length < 3) return open + content + close;

    const idCell    = cellText(cellMatches[0]?.[0] ?? '', nsPrefix);
    const titleCell = cellText(cellMatches[2]?.[0] ?? '', nsPrefix);
    const stepCell  = cellText(cellMatches[3]?.[0] ?? '', nsPrefix);

    // Match: no existing ID, has title, no step number, title matches
    if (!idCell && titleCell && !stepCell && normalise(titleCell) === title) {
      // Replace the first cell (empty string) with a numeric cell
      const firstCellFull = cellMatches[0]![0];
      const numericCell = firstCellFull
        .replace(new RegExp(`(<${nsPrefix}c)([^>]*t="str")`), `$1 t="n"`)
        .replace(new RegExp(`<${nsPrefix}v>[^<]*<\\/${nsPrefix}v>`), `<${nsPrefix}v>${id}</${nsPrefix}v>`);

      const newContent = content.replace(firstCellFull, numericCell);
      updated = true;
      return open + newContent + close;
    }

    return open + content + close;
  });

  zip.file(sheetKey, (hasBom ? '\uFEFF' : '') + newXml);

  const outBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });
  fs.writeFileSync(filePath, outBuffer);
}
