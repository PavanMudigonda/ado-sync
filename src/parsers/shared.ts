/**
 * Shared parser utilities used by both gherkin.ts and markdown.ts.
 */

import * as path from 'path';

/**
 * Extract auto-tags from directory segments that start with '@'.
 *
 * Given  /project/specs/@smoke/@regression/login.feature
 * returns ['smoke', 'regression']
 */
export function extractPathTags(filePath: string): string[] {
  const segments = filePath.split(path.sep);
  const tags: string[] = [];
  // Walk directory segments (not the filename itself)
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const matches = seg.match(/@[^\s@/\\]+/g);
    if (matches) {
      tags.push(...matches.map((t) => (t.startsWith('@') ? t.slice(1) : t)));
    }
  }
  return tags;
}

/**
 * Parse link references from a list of tags given a set of configured link prefixes.
 * e.g. tags=['story:123','smoke'], prefixes=['story'] → [{ prefix:'story', id:123 }]
 */
export function extractLinkRefs(
  tags: string[],
  linkConfigs: Array<{ prefix: string }> | undefined
): Array<{ prefix: string; id: number }> {
  if (!linkConfigs?.length) return [];
  const refs: Array<{ prefix: string; id: number }> = [];
  for (const cfg of linkConfigs) {
    const pfx = cfg.prefix + ':';
    for (const tag of tags) {
      if (tag.startsWith(pfx)) {
        const n = parseInt(tag.slice(pfx.length), 10);
        if (!isNaN(n)) refs.push({ prefix: cfg.prefix, id: n });
      }
    }
  }
  return refs;
}
