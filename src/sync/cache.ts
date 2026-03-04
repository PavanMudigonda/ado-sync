/**
 * Local state cache (.ado-sync-state.json).
 *
 * Stores the last-synced state of each Azure Test Case, enabling:
 *   - Conflict detection: remote was changed since we last pushed
 *   - Faster status checks: skip Azure API call when nothing changed
 *
 * Commit this file to version control so all team members and CI
 * share the same last-synced state.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { AzureStep, ParsedStep } from '../types';

const CACHE_FILENAME = '.ado-sync-state.json';

export interface CacheEntry {
  title: string;
  stepsHash: string;
  descriptionHash: string;
  /** ISO changedDate from Azure at time of last sync */
  changedDate: string;
  filePath: string;
}

export type SyncCache = Record<number, CacheEntry>;

export function loadCache(configDir: string): SyncCache {
  const cachePath = path.join(configDir, CACHE_FILENAME);
  if (!fs.existsSync(cachePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8')) as SyncCache;
  } catch {
    return {};
  }
}

export function saveCache(configDir: string, cache: SyncCache): void {
  const cachePath = path.join(configDir, CACHE_FILENAME);
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
}

export function hashSteps(steps: ParsedStep[] | AzureStep[]): string {
  const text = steps
    .map((s) => {
      if ('keyword' in s) {
        return `${s.keyword} ${s.text}|${s.expected ?? ''}`;
      }
      return `${s.action}|${s.expected}`;
    })
    .join('\n');
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function hashString(s: string | undefined): string {
  return crypto.createHash('sha256').update(s ?? '').digest('hex');
}
