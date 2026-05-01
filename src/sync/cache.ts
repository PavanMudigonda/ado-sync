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
  /** SHA-256 hash of the remote description at last sync. Used to detect Azure-side changes. */
  remoteDescriptionHash?: string;
  /** ISO changedDate from Azure at time of last sync */
  changedDate: string;
  filePath: string;
  /** Last resolved generated suite path key for hierarchy-managed configs. */
  suitePathKey?: string;
}

export interface SyncCache {
  [tcId: number]: CacheEntry;
  /** Persisted suite name→id map. Key format: "{planId}:{suiteName}" */
  _suites?: Record<string, number>;
}

export function loadCache(configDir: string): SyncCache {
  const cachePath = path.join(configDir, CACHE_FILENAME);
  if (!fs.existsSync(cachePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8')) as SyncCache;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [warn] Corrupt cache file ${cachePath} — starting fresh: ${msg}`);
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
