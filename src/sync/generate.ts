/**
 * generate — pull ADO User Stories + Acceptance Criteria and write local spec files.
 *
 * Supports two output formats:
 *   gherkin  → .feature file with Feature/Scenario skeleton
 *   markdown → .md file with heading + AC section
 */

import * as fs from 'fs';
import * as path from 'path';

import { AiGenerateOpts, generateSpecFromStory } from '../ai/generate-spec';
import { AzureClient } from '../azure/client';
import { AdoStory, fetchLinkedTestCaseIds, getWorkItemsByAreaPath, getWorkItemsByIds, getWorkItemsByQuery } from '../azure/work-items';
import { SyncConfig } from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────

export type GenerateFormat = 'gherkin' | 'markdown';

export { AiGenerateOpts };

export interface GenerateOpts {
  storyIds?: number[];
  query?: string;
  areaPath?: string;
  format?: GenerateFormat;
  outputFolder?: string;
  force?: boolean;
  dryRun?: boolean;
  /** When provided, AI generates the spec content instead of the template. */
  aiOpts?: AiGenerateOpts;
  /**
   * When true (default), inject @tc:<id> tags into generated files for stories
   * that already have linked Test Cases in Azure DevOps. Prevents the file from
   * appearing as a new untracked test on the next `status` run.
   */
  writebackTcTag?: boolean;
  onProgress?: (done: number, total: number, story: AdoStory) => void;
}

export interface GenerateResult {
  action: 'created' | 'skipped';
  filePath: string;
  storyId: number;
  title: string;
  /** First 20 lines of generated content — populated on dry-run when AI is active. */
  preview?: string;
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

// ─── @tc: tag injection ───────────────────────────────────────────────────────

/**
 * Inject @tc:<id> tags into spec content for each scenario found.
 * Replaces AI placeholder @tc:0000 tags first, then inserts for remaining scenarios.
 * For Gherkin: inserts "  @tc:XXXX" before each "  Scenario" / "  Scenario Outline" line.
 * For Markdown: appends " @tc:XXXX" to each "## Scenario:" or "### Test:" heading.
 */
function injectTcTags(
  content: string,
  format: GenerateFormat,
  tcIds: number[]
): string {
  if (!tcIds.length) return content;

  if (format === 'gherkin') {
    // First, strip AI placeholder @tc:0000 lines
    let result = content.replace(/^[ \t]*@tc:0+\s*\n/gm, '');

    let tcIndex = 0;
    // Insert @tc: tag before each Scenario / Scenario Outline line
    result = result.replace(/^([ \t]*)(Scenario(?: Outline)?:)/gm, (_match, indent, keyword) => {
      if (tcIndex < tcIds.length) {
        return `${indent}@tc:${tcIds[tcIndex++]}\n${indent}${keyword}`;
      }
      return `${indent}${keyword}`;
    });
    return result;
  } else {
    // Markdown: append @tc: to scenario/test headings
    // Strip AI placeholder @tc:0000 from headings first
    let result = content.replace(/(\s*@tc:0+)(\s*)$/gm, '$2');

    let tcIndex = 0;
    result = result.replace(/^(#{2,3}\s+(?:Scenario|Test):.*?)(\s*)$/gm, (_match, heading, tail) => {
      if (tcIndex < tcIds.length) {
        return `${heading} @tc:${tcIds[tcIndex++]}${tail}`;
      }
      return `${heading}${tail}`;
    });
    return result;
  }
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
  // Resolve AI opts: explicit opts take precedence, fall back to config.sync.ai
  const cfgAi = config.sync?.ai;
  let aiOpts = opts.aiOpts;
  if (!aiOpts && cfgAi?.provider && cfgAi.provider !== 'none' && cfgAi.provider !== 'heuristic') {
    aiOpts = {
      provider: cfgAi.provider as AiGenerateOpts['provider'],
      model:    cfgAi.model,
      apiKey:   cfgAi.apiKey,
      baseUrl:  cfgAi.baseUrl,
      region:   cfgAi.region,
    };
  }

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

  // Fetch linked TC IDs for writeback (default: true)
  const writebackTcTag = opts.writebackTcTag ?? true;
  let linkedTcMap = new Map<number, number[]>();
  if (writebackTcTag) {
    try {
      linkedTcMap = await fetchLinkedTestCaseIds(client, stories.map((s) => s.id));
    } catch {
      // Non-fatal — proceed without TC tag writeback
    }
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

    // Generate content (AI or template)
    let content = '';
    if (aiOpts) {
      content = await generateSpecFromStory(story, resolvedFormat, aiOpts);
    }
    if (!content) {
      content = buildContent(story, resolvedFormat);
    }

    // Inject @tc: tags for already-linked test cases
    const linkedTcIds = linkedTcMap.get(story.id) ?? [];
    if (linkedTcIds.length) {
      content = injectTcTags(content, resolvedFormat, linkedTcIds);
    }

    let preview: string | undefined;
    if (opts.dryRun) {
      // On dry-run with AI active, capture first 20 lines as preview
      if (aiOpts) {
        preview = content.split('\n').slice(0, 20).join('\n');
      }
    } else {
      fs.writeFileSync(filePath, content, 'utf8');
    }

    results.push({ action: 'created', filePath, storyId: story.id, title: story.title, preview });
    done++;
    opts.onProgress?.(done, stories.length, story);
  }

  return results;
}
