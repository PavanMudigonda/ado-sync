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

/**
 * Extract attachment file references from tags.
 * Default prefix is 'attachment'. Additional prefixes can be configured.
 * e.g. tags=['attachment:screen.png', 'wireframe:mock.pdf'], prefixes=['wireframe']
 * → [{ prefix:'attachment', filePath:'screen.png' }, { prefix:'wireframe', filePath:'mock.pdf' }]
 */
export function extractAttachmentRefs(
  tags: string[],
  attachmentPrefixes: string[]
): Array<{ prefix: string; filePath: string }> {
  if (!attachmentPrefixes.length) return [];
  const refs: Array<{ prefix: string; filePath: string }> = [];
  for (const prefix of attachmentPrefixes) {
    const pfx = prefix + ':';
    for (const tag of tags) {
      if (tag.startsWith(pfx)) {
        const fp = tag.slice(pfx.length);
        if (fp) refs.push({ prefix, filePath: fp });
      }
    }
  }
  return refs;
}

/**
 * Get the effective list of attachment tag prefixes from config.
 * Always includes 'attachment' as the default prefix when attachments are enabled.
 */
export function getAttachmentPrefixes(
  attachmentsConfig?: { enabled: boolean; tagPrefixes?: string[] }
): string[] {
  if (!attachmentsConfig?.enabled) return [];
  const prefixes = ['attachment'];
  if (attachmentsConfig.tagPrefixes?.length) {
    for (const p of attachmentsConfig.tagPrefixes) {
      if (!prefixes.includes(p)) prefixes.push(p);
    }
  }
  return prefixes;
}
