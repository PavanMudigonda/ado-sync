/**
 * generate — pull ADO User Stories + Acceptance Criteria and write local spec files.
 *
 * Supports two output formats:
 *   gherkin  → .feature file with Feature/Scenario skeleton
 *   markdown → .md file with heading + AC section
 */

import * as fs from 'fs';
import * as path from 'path';

import { AzureClient } from '../azure/client';
import { AdoStory, getWorkItemsByAreaPath, getWorkItemsByIds, getWorkItemsByQuery } from '../azure/work-items';
import { SyncConfig } from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────

export type GenerateFormat = 'gherkin' | 'markdown';

export interface GenerateOpts {
  storyIds?: number[];
  query?: string;
  areaPath?: string;
  format?: GenerateFormat;
  outputFolder?: string;
  force?: boolean;
  dryRun?: boolean;
  onProgress?: (done: number, total: number, story: AdoStory) => void;
}

export interface GenerateResult {
  action: 'created' | 'skipped';
  filePath: string;
  storyId: number;
  title: string;
}

// ─── Filename helpers ─────────────────────────────────────────────────────────

function toKebabCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function specFilename(story: AdoStory, format: GenerateFormat): string {
  const slug = toKebabCase(story.title) || `story-${story.id}`;
  const ext = format === 'gherkin' ? '.feature' : '.md';
  return `${story.id}-${slug}${ext}`;
}

// ─── Template builders ────────────────────────────────────────────────────────

function buildGherkinContent(story: AdoStory): string {
  const lines: string[] = [];

  lines.push(`Feature: ${story.title}`);
  if (story.description) {
    lines.push('');
    for (const line of story.description.split('\n')) {
      lines.push(`  ${line}`);
    }
  }
  lines.push('');

  if (story.acceptanceCriteria) {
    lines.push('  # Acceptance Criteria:');
    for (const line of story.acceptanceCriteria.split('\n')) {
      lines.push(`  # ${line}`);
    }
    lines.push('');
  }

  // Extract first AC line as scenario title, fall back to placeholder
  const firstAcLine = story.acceptanceCriteria
    ?.split('\n')
    .map((l) => l.replace(/^[-*#\s]+/, '').trim())
    .find((l) => l.length > 0);
  const scenarioTitle = firstAcLine ?? `${story.title} works correctly`;

  lines.push(`  Scenario: ${scenarioTitle}`);
  lines.push('    Given ');
  lines.push('    When ');
  lines.push('    Then ');
  lines.push('');

  return lines.join('\n');
}

function buildMarkdownContent(story: AdoStory): string {
  const lines: string[] = [];

  lines.push(`# ${story.title}`);
  lines.push('');

  if (story.workItemType || story.state) {
    const meta: string[] = [];
    if (story.workItemType) meta.push(`**Type:** ${story.workItemType}`);
    if (story.state) meta.push(`**State:** ${story.state}`);
    lines.push(meta.join('  '));
    lines.push('');
  }

  if (story.description) {
    lines.push(story.description);
    lines.push('');
  }

  if (story.acceptanceCriteria) {
    lines.push('## Acceptance Criteria');
    lines.push('');
    lines.push(story.acceptanceCriteria);
    lines.push('');
  }

  // Extract first AC line as test title
  const firstAcLine = story.acceptanceCriteria
    ?.split('\n')
    .map((l) => l.replace(/^[-*#\s]+/, '').trim())
    .find((l) => l.length > 0);
  const testTitle = firstAcLine ?? `${story.title} works correctly`;

  lines.push(`### Test: ${testTitle}`);
  lines.push('');

  return lines.join('\n');
}

function buildContent(story: AdoStory, format: GenerateFormat): string {
  return format === 'gherkin'
    ? buildGherkinContent(story)
    : buildMarkdownContent(story);
}

// ─── Main function ────────────────────────────────────────────────────────────

export async function generateSpecs(
  config: SyncConfig,
  configDir: string,
  opts: GenerateOpts = {}
): Promise<GenerateResult[]> {
  const client = await AzureClient.create(config);

  // Resolve format: option → config local.type coerced → markdown
  const resolvedFormat: GenerateFormat = opts.format
    ?? (['gherkin', 'reqnroll'].includes(config.local.type) ? 'gherkin' : 'markdown');

  // Resolve output folder
  const outputFolder = opts.outputFolder
    ?? (config.sync?.pull?.targetFolder
      ? path.resolve(configDir, config.sync.pull.targetFolder)
      : configDir);

  // Fetch stories
  let stories: AdoStory[] = [];

  if (opts.storyIds?.length) {
    stories = await getWorkItemsByIds(client, config.project, opts.storyIds);
  } else if (opts.query) {
    stories = await getWorkItemsByQuery(client, config.project, opts.query);
  } else if (opts.areaPath) {
    stories = await getWorkItemsByAreaPath(client, config.project, opts.areaPath);
  } else {
    throw new Error(
      'Provide at least one of: --story-ids, --query, or --area-path'
    );
  }

  if (!stories.length) {
    return [];
  }

  if (!opts.dryRun) {
    fs.mkdirSync(outputFolder, { recursive: true });
  }

  const results: GenerateResult[] = [];
  let done = 0;

  for (const story of stories) {
    opts.onProgress?.(done, stories.length, story);

    const filename = specFilename(story, resolvedFormat);
    const filePath = path.join(outputFolder, filename);

    if (!opts.force && fs.existsSync(filePath)) {
      results.push({ action: 'skipped', filePath, storyId: story.id, title: story.title });
      done++;
      opts.onProgress?.(done, stories.length, story);
      continue;
    }

    if (!opts.dryRun) {
      const content = buildContent(story, resolvedFormat);
      fs.writeFileSync(filePath, content, 'utf8');
    }

    results.push({ action: 'created', filePath, storyId: story.id, title: story.title });
    done++;
    opts.onProgress?.(done, stories.length, story);
  }

  return results;
}
