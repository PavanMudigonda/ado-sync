/**
 * .ai-workflow-manifest.json generator
 *
 * Produces a structured JSON manifest that gives AI agents (Claude Code, Copilot,
 * Cursor) the full context needed to drive the Planner → Generator → Push → CI →
 * Publish cycle for a given User Story — the materia "AI-assisted BDD" pattern.
 *
 * Command:  ado-sync generate --manifest --story-ids 1234
 * MCP tool: generate_manifest({ storyIds: [1234] })
 */

import * as fs from 'fs';
import * as path from 'path';

import { AzureClient } from '../azure/client';
import { getStoryContext, StoryContext } from '../azure/work-items';
import { SyncConfig } from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ManifestWorkflowStep {
  step:        number;
  action:      string;
  tool:        string;
  description: string;
  input?:      Record<string, unknown>;
}

export interface ManifestDocument {
  name:   string;
  source?: string;
  path?:  string;
  status: 'available' | 'pending' | 'generated';
}

export interface AiWorkflowManifest {
  /** Schema version */
  version:     '1.0';
  generatedAt: string;
  storyId:     number;
  title:       string;

  /** Planner context — everything needed to write a good spec */
  context: {
    storyUrl:             string;
    acceptanceCriteria:   string[];
    suggestedTags:        string[];
    suggestedActors:      string[];
    relatedTestCases:     number[];
  };

  /** Ordered steps the AI agent should follow */
  workflow: {
    steps: ManifestWorkflowStep[];
  };

  /** Documents the agent needs or will produce */
  requiredDocuments: ManifestDocument[];

  /** Human-readable checklist to validate before marking the story "done" */
  validationChecklist: string[];

  /** Key file paths for reference */
  outputPaths: {
    specFile:    string;
    manifest:    string;
    testResults: string;
  };
}

/** Resolved manifest format family — maps many local.type values to one of these. */
export type ManifestFormat = 'gherkin' | 'markdown' | 'playwright' | 'javascript';

export interface GenerateManifestOpts {
  storyIds:     number[];
  outputFolder?: string;
  /** Explicit format. When omitted, auto-detected from config.local.type. */
  format?:      ManifestFormat | 'reqnroll' | 'cypress' | 'jest' | 'detox' | 'testcafe';
  force?:       boolean;
  dryRun?:      boolean;
}

export interface GenerateManifestResult {
  action:    'created' | 'skipped';
  filePath:  string;
  storyId:   number;
  title:     string;
  manifest?: AiWorkflowManifest;
}

// ─── Main function ────────────────────────────────────────────────────────────

export async function generateManifests(
  config:    SyncConfig,
  configDir: string,
  opts:      GenerateManifestOpts,
): Promise<GenerateManifestResult[]> {
  if (!opts.storyIds.length) {
    throw new Error('--story-ids is required for --manifest');
  }

  const client = await AzureClient.create(config);
  const outputFolder = opts.outputFolder
    ? path.resolve(configDir, opts.outputFolder)
    : configDir;

  if (!opts.dryRun) {
    fs.mkdirSync(outputFolder, { recursive: true });
  }

  const format = resolveManifestFormat(opts.format, config.local.type);
  const specExt = specExtension(format, config.local.type);

  const results: GenerateManifestResult[] = [];

  for (const storyId of opts.storyIds) {
    const ctx = await getStoryContext(client, config.project, storyId, config.orgUrl);
    const manifest = buildManifest(ctx, outputFolder, specExt, format);
    const filePath = path.join(outputFolder, `.ai-workflow-manifest-${storyId}.json`);

    if (!opts.force && fs.existsSync(filePath)) {
      results.push({ action: 'skipped', filePath, storyId, title: ctx.title });
      continue;
    }

    if (!opts.dryRun) {
      fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2), 'utf8');
    }

    results.push({ action: 'created', filePath, storyId, title: ctx.title, manifest });
  }

  return results;
}

// ─── Manifest builder ─────────────────────────────────────────────────────────

function buildManifest(
  ctx:          StoryContext,
  outputFolder: string,
  specExt:      string,
  format:       string,
): AiWorkflowManifest {
  const slug      = toKebabCase(ctx.title) || `story-${ctx.storyId}`;
  const specFile  = path.join(outputFolder, `${ctx.storyId}-${slug}${specExt}`);
  const manifest  = path.join(outputFolder, `.ai-workflow-manifest-${ctx.storyId}.json`);

  const steps: ManifestWorkflowStep[] = [
    {
      step: 1, tool: 'validate_config', action: 'validate_config',
      description: 'Verify Azure DevOps connection, project, and test plan are reachable.',
    },
    {
      step: 2, tool: 'get_story_context', action: 'get_story_context',
      description: 'Fetch AC items, related test cases, and suggested tags for the story.',
      input: { storyId: ctx.storyId },
    },
    {
      step: 3, tool: 'generate_specs', action: 'generate_spec',
      description: `Write a ${format} spec skeleton from AC items. One Scenario per AC bullet.`,
      input: { storyIds: [ctx.storyId], format, dryRun: false },
    },
    {
      step: 4, tool: 'editor', action: 'fill_steps',
      description: 'Fill in the Given/When/Then steps. Apply suggested tags. Reference page objects.',
    },
    {
      step: 5, tool: 'push_specs', action: 'push_dry_run',
      description: 'Preview test case creation — verify titles and step count before committing.',
      input: { dryRun: true },
    },
    {
      step: 6, tool: 'push_specs', action: 'push_specs',
      description: 'Create test cases in Azure DevOps and write @tc:ID back into the spec file.',
      input: { dryRun: false },
    },
    {
      step: 7, tool: 'ci', action: 'run_tests',
      description: 'Run tests in CI. Collect CTRF or Playwright JSON results.',
    },
    {
      step: 8, tool: 'publish_test_results', action: 'publish_results',
      description: 'Publish results to ADO test run. File GitHub Issues for any failures.',
      input: { createIssuesOnFailure: true },
    },
  ];

  const requiredDocuments: ManifestDocument[] = [
    {
      name: `ADO User Story #${ctx.storyId}`,
      source: ctx.url,
      status: 'available',
    },
    {
      name: 'Spec file',
      path: specFile,
      status: ctx.relatedTestCases.length > 0 ? 'available' : 'pending',
    },
    {
      name: 'Test results',
      path: 'results/playwright.json',
      status: 'pending',
    },
  ];

  const validationChecklist: string[] = [
    `Spec covers all ${ctx.acItems.length} AC items (one Scenario per bullet)`,
    'Each Scenario has filled Given/When/Then steps',
    `Suggested tags applied: ${ctx.suggestedTags.join(', ') || '(none detected)'}`,
    'ado-sync push --dry-run shows 0 errors',
    'Test run pass rate ≥ 80%',
  ];

  if (ctx.relatedTestCases.length > 0) {
    validationChecklist.push(`Existing TCs verified: ${ctx.relatedTestCases.join(', ')}`);
  }

  return {
    version:     '1.0',
    generatedAt: new Date().toISOString(),
    storyId:     ctx.storyId,
    title:       ctx.title,
    context: {
      storyUrl:           ctx.url,
      acceptanceCriteria: ctx.acItems,
      suggestedTags:      ctx.suggestedTags,
      suggestedActors:    ctx.suggestedActors,
      relatedTestCases:   ctx.relatedTestCases,
    },
    workflow:            { steps },
    requiredDocuments,
    validationChecklist,
    outputPaths: {
      specFile,
      manifest,
      testResults: 'results/playwright.json',
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toKebabCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
