/**
 * Excel (.xlsx) test spec parser.
 *
 * Reads the Azure DevOps / SpecSync xlsx export format.
 *
 * Cell types handled:
 *   t="s"        → shared string; <v> holds an index into xl/sharedStrings.xml
 *   t="str"      → formula-result string in <v>
 *   t="n" / none → number in <v>
 *   t="inlineStr"→ rich text in <is><r><t>…</t></r></is>; concat all <t> runs
 *
 * Rows in xlsx are sparse — empty cells are omitted. We restore correct column
 * positions using the cell reference attribute (r="C5" → col index 2).
 *
 * ID writeback rewrites the xlsx XML in place (updates or inserts the ID cell
 * on the matching title row).
 */

import * as fs from 'fs';
import JSZip from 'jszip';

import { LinkConfig, ParsedTest } from '../types';
import { parseTabularRows, TabularRow } from './tabular';

// ─── XML helpers ──────────────────────────────────────────────────────────────

/** Determine the namespace prefix used in this XML (may be "x:" or none). */
function detectNsPrefix(xml: string): string {
  const m = xml.match(/xmlns(?::(\w+))?="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"/);
  return m?.[1] ? `${m[1]}:` : '';
}

/** Unescape XML entities. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Parse xl/sharedStrings.xml into a lookup array.
 * Each <si> element is one entry; rich-text runs (<r><t>…</t></r>) are concatenated.
 */
function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const siRe = /<si[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    const parts: string[] = [];
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(m[1])) !== null) {
      parts.push(unescapeXml(tm[1]));
    }
    strings.push(parts.join(''));
  }
  return strings;
}

/** Convert column letter(s) to 0-based index: A→0, B→1, Z→25, AA→26. */
function colLetterToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

/**
 * Extract the text value from a single <c> element, resolving shared strings.
 * cellXml: the full <c …>…</c> XML string.
 */
function cellValue(cellXml: string, nsPrefix: string, sharedStrings: string[]): string {
  // inlineStr: <ns:is> containing <ns:r><ns:t>…</ns:t></ns:r> runs
  const isMatch = cellXml.match(new RegExp(`<${nsPrefix}is>([\\s\\S]*?)<\\/${nsPrefix}is>`));
  if (isMatch) {
    const tRe = new RegExp(`<${nsPrefix}t[^>]*>([\\s\\S]*?)<\\/${nsPrefix}t>`, 'g');
    const parts: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = tRe.exec(isMatch[1])) !== null) {
      parts.push(unescapeXml(m[1]));
    }
    return parts.join('');
  }

  const vMatch = cellXml.match(new RegExp(`<${nsPrefix}v>([\\s\\S]*?)<\\/${nsPrefix}v>`));
  if (!vMatch) return '';

  // Shared string: t="s"
  if (/\bt="s"/.test(cellXml)) {
    const idx = parseInt(vMatch[1], 10);
    return sharedStrings[idx] ?? '';
  }

  return unescapeXml(vMatch[1]);
}

/**
 * Parse all rows from the sheet XML into string[][] with correct column positions.
 * Uses the cell reference attribute (r="C5") to fill sparse rows correctly.
 */
function parseSheetXml(xml: string, sharedStrings: string[]): string[][] {
  const nsPrefix = detectNsPrefix(xml);
  const rowRe = new RegExp(`<${nsPrefix}row([^>]*)>([\\s\\S]*?)<\\/${nsPrefix}row>`, 'g');
  const cellRe = new RegExp(`<${nsPrefix}c([^>]*)>([\\s\\S]*?)<\\/${nsPrefix}c>`, 'g');

  const rows: string[][] = [];
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const rowContent = rowMatch[2];
    const cellData: Array<{ colIdx: number; value: string }> = [];
    let cellMatch: RegExpExecArray | null;

    while ((cellMatch = cellRe.exec(rowContent)) !== null) {
      const attrs = cellMatch[1];
      // r="C5" → extract column letters "C"
      const refMatch = attrs.match(/\br="([A-Z]+)\d+"/i);
      const colIdx = refMatch ? colLetterToIndex(refMatch[1]) : cellData.length;
      const value = cellValue(cellMatch[0], nsPrefix, sharedStrings);
      cellData.push({ colIdx, value });
    }

    if (cellData.length === 0) continue; // skip fully empty rows

    // Build dense row array: fill gaps with empty strings
    const maxColIdx = Math.max(...cellData.map((c) => c.colIdx));
    const row = new Array<string>(maxColIdx + 1).fill('');
    for (const { colIdx, value } of cellData) {
      row[colIdx] = value;
    }
    rows.push(row);
  }

  return rows;
}

// ─── Worksheet discovery ──────────────────────────────────────────────────────

/**
 * Locate the first worksheet file inside an xlsx ZIP.
 *
 * Strategy (in order):
 *  1. Try common names: sheet.xml, sheet1.xml (case-insensitive).
 *  2. Read xl/_rels/workbook.xml.rels to find the relationship-mapped path.
 *  3. Fall back to any file under xl/worksheets/.
 *
 * Returns the ZIP entry key (e.g. "xl/worksheets/sheet1.xml") or null.
 */
async function findFirstSheetPath(zip: JSZip): Promise<string | null> {
  // Fast path: common names used by ADO exports and most tools
  for (const candidate of [
    'xl/worksheets/sheet.xml',
    'xl/worksheets/sheet1.xml',
    'xl/worksheets/Sheet1.xml',
  ]) {
    if (zip.file(candidate)) return candidate;
  }

  // Read workbook relationships to find the actual sheet path
  const relsEntry = zip.file('xl/_rels/workbook.xml.rels');
  if (relsEntry) {
    const relsXml = await relsEntry.async('string');
    // Match the first Relationship of type worksheet
    const m = relsXml.match(/Type="[^"]*\/worksheet"[^>]*Target="([^"]+)"/);
    if (m) {
      // Target is relative to xl/; strip leading '../' or '/' if present
      const target = m[1].replace(/^\.\.\//, '').replace(/^\//, '');
      const fullPath = target.startsWith('xl/') ? target : `xl/${target}`;
      if (zip.file(fullPath)) return fullPath;
    }
  }

  // Last-resort: scan all files under xl/worksheets/
  const allFiles = Object.keys((zip as any).files as Record<string, unknown>);
  const sheetFile = allFiles.find(
    (f) => /^xl\/worksheets\/.+\.xml$/i.test(f) && !f.includes('_rels')
  );
  return sheetFile ?? null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function parseExcelFile(
  filePath: string,
  tagPrefix: string,
  linkConfigs?: LinkConfig[]
): Promise<ParsedTest[]> {
  const buffer = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buffer);

  // Load shared strings table (present in most xlsx files)
  const ssEntry = zip.file('xl/sharedStrings.xml');
  const sharedStrings = ssEntry
    ? parseSharedStrings(await ssEntry.async('string'))
    : [];

  // Find the worksheet XML (handles non-standard sheet naming)
  const sheetKey = await findFirstSheetPath(zip);
  const sheetEntry = sheetKey ? zip.file(sheetKey) : null;

  if (!sheetEntry) throw new Error(`No worksheet found in ${filePath}`);

  const xml: string = await sheetEntry.async('string');
  const cleanXml = xml.startsWith('\uFEFF') ? xml.slice(1) : xml;

  const rawRows = parseSheetXml(cleanXml, sharedStrings);

  const rows: TabularRow[] = rawRows.map((cells, idx) => ({
    cells: cells.concat(Array(Math.max(0, 9 - cells.length)).fill('')),
    rowIndex: idx + 1,
  }));

  return parseTabularRows(rows, filePath, tagPrefix, linkConfigs);
}

// ─── ID writeback ─────────────────────────────────────────────────────────────

/**
 * Write (or update) the TC ID in column A of the matching title row in an xlsx file.
 *
 * Strategy:
 *  1. Load the xlsx zip and shared strings.
 *  2. Find the row where col C (Title) matches and col D (Test Step) is empty.
 *  3. If col A cell exists, replace its value; if it's missing (sparse row),
 *     insert a new numeric cell at the start of the row.
 *  4. Repack and write.
 */
export async function writebackExcel(filePath: string, title: string, id: number): Promise<void> {
  const buffer = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buffer);

  const sheetKey = await findFirstSheetPath(zip);
  if (!sheetKey) throw new Error(`No worksheet found in ${filePath}`);

  const ssEntry = zip.file('xl/sharedStrings.xml');
  const sharedStrings = ssEntry ? parseSharedStrings(await ssEntry.async('string')) : [];

  let xml: string = await zip.file(sheetKey)!.async('string');
  const hasBom = xml.startsWith('\uFEFF');
  if (hasBom) xml = xml.slice(1);

  const nsPrefix = detectNsPrefix(xml);
  const TITLE_STRIP_RE = /^(Scenario Outline|Scenario)\s*:\s*/i;
  const normalise = (s: string) => s.replace(TITLE_STRIP_RE, '').trim();

  const rowRe = new RegExp(`(<${nsPrefix}row([^>]*)>)([\\s\\S]*?)(<\\/${nsPrefix}row>)`, 'g');

  let updated = false;
  const newXml = xml.replace(rowRe, (_full, open, rowAttrs, content, close) => {
    if (updated) return open + content + close;

    // Collect all cells with their column index
    const cellMatches = [...content.matchAll(
      new RegExp(`(<${nsPrefix}c([^>]*)>)([\\s\\S]*?)(<\\/${nsPrefix}c>)`, 'g')
    )];

    const getCellAtCol = (colLetter: string) => {
      const targetIdx = colLetterToIndex(colLetter);
      return cellMatches.find((m) => {
        const refMatch = (m[2] as string).match(/\br="([A-Z]+)\d+"/i);
        return refMatch ? colLetterToIndex(refMatch[1]) === targetIdx : false;
      });
    };

    const titleMatch = getCellAtCol('C');
    const stepMatch  = getCellAtCol('D');
    const idMatch    = getCellAtCol('A');

    const titleVal = titleMatch ? cellValue(titleMatch[0], nsPrefix, sharedStrings) : '';
    const stepVal  = stepMatch  ? cellValue(stepMatch[0],  nsPrefix, sharedStrings) : '';

    // Match title rows (non-empty title, no step number) by normalised title.
    // Do NOT guard on existing ID — allows updating the ID when a deleted TC is re-created.
    if (!titleVal || stepVal) return open + content + close;
    if (normalise(titleVal) !== title) return open + content + close;

    // Extract row number from the row's r attribute or first cell reference
    const rowNumMatch = rowAttrs.match(/\br="(\d+)"/);
    const rowNum = rowNumMatch ? rowNumMatch[1] : '1';

    const numericCellXml = `<${nsPrefix}c r="A${rowNum}" t="n"><${nsPrefix}v>${id}</${nsPrefix}v></${nsPrefix}c>`;

    let newContent: string;
    if (idMatch) {
      // Replace existing (empty) A cell
      newContent = content.replace(idMatch[0], numericCellXml);
    } else {
      // Insert new A cell at start of row content
      newContent = numericCellXml + content;
    }

    updated = true;
    return open + newContent + close;
  });

  zip.file(sheetKey, (hasBom ? '\uFEFF' : '') + newXml);

  const outBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(filePath, outBuffer);
}
