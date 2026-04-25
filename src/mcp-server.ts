#!/usr/bin/env node

/**
 * ado-sync MCP Server
 *
 * Exposes ado-sync operations as MCP tools so AI agents (Claude Code,
 * GitHub Copilot Agent Mode, Cursor) can call them directly during
 * agentic workflows — no manual CLI invocation required.
 *
 * Tools exposed:
 *   validate_config        — check config + Azure connectivity
 *   get_test_cases         — list test cases in a suite
 *   get_test_case          — fetch a single test case by ID
 *   create_test_case       — create a test case from a spec description
 *   push_specs             — push local spec files to Azure DevOps
 *   pull_specs             — pull Azure DevOps changes to local files
 *   status                 — show diff between local and Azure
 *   generate_specs         — generate local spec files from ADO User Stories
 *   get_work_items         — fetch ADO User Stories by ID, WIQL query, or area path
 *   publish_test_results   — publish test results to Azure DevOps
 *   create_issue           — file a GitHub Issue or ADO Bug for a test failure
 *   get_story_context      — planner-agent feed: AC items, suggested tags, linked TCs
 *   generate_manifest      — write .ai-workflow-manifest-{id}.json for a story
 *   find_tagged_items      — find work items where a tag was added in the last N hours/days (exact timestamp)
 *
 * Usage (register in .claude/settings.json or .vscode/mcp.json):
 *
 *   "ado-sync": {
 *     "command": "node",
 *     "args": ["./dist/mcp-server.js"],
 *     "env": { "AZURE_DEVOPS_TOKEN": "..." }
 *   }
 *
 * Config file: resolves ado-sync.json / ado-sync.yml from the working
 * directory by default. Override with ADO_SYNC_CONFIG env var.
 */

// Suppress DEP0169 (url.parse) from azure-devops-node-api internals.
process.on('warning', (warning) => {
  if ((warning as NodeJS.ErrnoException).code === 'DEP0169') return;
  process.stderr.write(`[node:warning] ${warning.name}: ${warning.message}\n`);
});

import 'dotenv/config';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as path from 'path';
import { z } from 'zod';

import { detectAiEnvironment } from './ai/summarizer';
import { AzureClient } from './azure/client';
import { getTestCase, getTestCasesInSuite } from './azure/test-cases';
import { findStoriesByTagAddedSince, getStoryContext, getWorkItemsByAreaPath, getWorkItemsByIds, getWorkItemsByQuery } from './azure/work-items';
import { applyOverrides, loadConfig, resolveConfigPath } from './config';
import { createIssuesFromResults } from './issues/create-issues';
import { pull, push, status } from './sync/engine';
import { generateSpecs } from './sync/generate';
import { generateManifests } from './sync/manifest';
import { publishTestResults } from './sync/publish-results';

// ─── Config resolution ────────────────────────────────────────────────────────

/** Resolve $ENV_VAR references to their actual values. */
function resolveEnvRef(value?: string): string | undefined {
  if (!value) return undefined;
  if (!value.startsWith('$')) return value;
  return process.env[value.slice(1)] ?? value;
}

function resolveConfig(configPath?: string, overrides?: string[]) {
  const resolved = resolveConfigPath(configPath ?? process.env.ADO_SYNC_CONFIG);
  const config = loadConfig(resolved);
  if (overrides?.length) applyOverrides(config, overrides);
  // Resolve AI API key env var references that loadConfig doesn't handle
  if (config.sync?.ai?.apiKey) {
    config.sync.ai.apiKey = resolveEnvRef(config.sync.ai.apiKey);
  }
  // MCP server is always called by an AI agent — auto-detect available
  // provider/key when no explicit AI config is set so users don't need to
  // configure --ai-provider or --ai-key separately.
  // First try detectAiEnvironment() for API-key-backed providers; if that
  // returns nothing, default to heuristic (MCP ⟹ always inside an AI agent).
  if (!config.sync?.ai?.provider) {
    const detected = detectAiEnvironment() ?? { provider: 'heuristic' as const };
    if (!config.sync) config.sync = {} as any;
    if (!config.sync!.ai) config.sync!.ai = {} as any;
    config.sync!.ai!.provider = detected.provider;
    if ('apiKey' in detected && detected.apiKey) config.sync!.ai!.apiKey = detected.apiKey;
  }
  return { config, configDir: path.dirname(resolved), configPath: resolved };
}

/** Wrap an MCP tool handler with try/catch so exceptions produce structured error responses. */
function safeHandler<T>(handler: (args: T) => Promise<any>): (args: T) => Promise<any> {
  return async (args: T) => {
    try {
      return await handler(args);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
    }
  };
}

// ─── Server setup ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'ado-sync',
  version: '1.0.0',
}, {
  instructions:
    'Tools for bidirectional sync between local test specs and Azure DevOps Test Cases. ' +
    'Most tools load config from ado-sync.json in the working directory (or ADO_SYNC_CONFIG env var). ' +
    'Always call validate_config first to confirm connectivity before running other tools.',
});

// ─── Tool: validate_config ────────────────────────────────────────────────────

server.tool(
  'validate_config',
  'Validate the ado-sync config file and verify Azure DevOps connectivity. ' +
  'Returns a checklist of passed/failed steps.',
  {
    configPath: z.string().optional().describe('Path to config file (default: ado-sync.json in cwd)'),
  },
  async ({ configPath }) => {
    const checks: Array<{ label: string; ok: boolean; detail?: string }> = [];

    let cfg: ReturnType<typeof resolveConfig> | undefined;

    // Step 1: load config
    try {
      cfg = resolveConfig(configPath);
      checks.push({ label: 'Config loaded', ok: true, detail: cfg.configPath });
    } catch (err: unknown) {
      checks.push({ label: 'Config loaded', ok: false, detail: err instanceof Error ? err.message : String(err) });
      return { content: [{ type: 'text', text: formatChecks(checks) }] };
    }

    const { config } = cfg;

    // Step 2: Azure connection
    let client: AzureClient | undefined;
    try {
      client = await AzureClient.create(config);
      checks.push({ label: 'Azure connection', ok: true, detail: config.orgUrl });
    } catch (err: unknown) {
      checks.push({ label: 'Azure connection', ok: false, detail: err instanceof Error ? err.message : String(err) });
      return { content: [{ type: 'text', text: formatChecks(checks) }] };
    }

    // Step 3: project
    try {
      const coreApi = await client.getCoreApi();
      const proj = await coreApi.getProject(config.project);
      checks.push({ label: `Project "${config.project}"`, ok: !!proj?.id, detail: proj?.id ? 'found' : 'not found' });
    } catch (err: unknown) {
      checks.push({ label: `Project "${config.project}"`, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }

    // Step 4: test plans
    const planApi = await client.getTestPlanApi();
    const planIds = config.testPlans?.map(p => p.id) ?? [config.testPlan.id];
    for (const id of planIds) {
      try {
        const plan = await planApi.getTestPlanById(config.project, id);
        checks.push({ label: `Test Plan #${id}`, ok: !!plan?.id, detail: plan?.name ?? 'not found' });
      } catch (err: unknown) {
        checks.push({ label: `Test Plan #${id}`, ok: false, detail: err instanceof Error ? err.message : String(err) });
      }
    }

    return { content: [{ type: 'text', text: formatChecks(checks) }] };
  }
);

function formatChecks(checks: Array<{ label: string; ok: boolean; detail?: string }>): string {
  const lines = checks.map(c => `${c.ok ? '✓' : '✗'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
  const allOk = checks.every(c => c.ok);
  lines.push('');
  lines.push(allOk ? 'All checks passed.' : 'Some checks failed. See above for details.');
  return lines.join('\n');
}

// ─── Tool: get_test_cases ─────────────────────────────────────────────────────

server.tool(
  'get_test_cases',
  'List all test cases in a Azure DevOps test suite. Returns id, title, tags, and step count.',
  {
    suiteId: z.number().int().positive().optional().describe('Suite ID (defaults to plan root suite)'),
    configPath: z.string().optional().describe('Path to ado-sync config file'),
  },
  safeHandler(async ({ suiteId, configPath }) => {
    const { config } = resolveConfig(configPath);
    const client = await AzureClient.create(config);
    const tcs = await getTestCasesInSuite(client, config, suiteId);
    const summary = tcs.map(tc => ({
      id: tc.id,
      title: tc.title,
      tags: tc.tags,
      stepCount: tc.steps.length,
      changedDate: tc.changedDate,
    }));
    return {
      content: [{
        type: 'text',
        text: `Found ${tcs.length} test case(s).\n\n${JSON.stringify(summary, null, 2)}`,
      }],
    };
  })
);

// ─── Tool: get_test_case ──────────────────────────────────────────────────────

server.tool(
  'get_test_case',
  'Fetch a single Azure DevOps test case by ID. Returns full details including steps.',
  {
    id: z.number().int().positive().describe('Azure DevOps Test Case work item ID'),
    configPath: z.string().optional().describe('Path to ado-sync config file'),
  },
  safeHandler(async ({ id, configPath }) => {
    const { config } = resolveConfig(configPath);
    const client = await AzureClient.create(config);
    const tc = await getTestCase(client, id, config.sync?.titleField ?? 'System.Title');
    if (!tc) {
      return { content: [{ type: 'text', text: `Test case #${id} not found.` }] };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(tc, null, 2),
      }],
    };
  })
);

// ─── Tool: push_specs ─────────────────────────────────────────────────────────

server.tool(
  'push_specs',
  'Push local test spec files to Azure DevOps — creates new test cases or updates existing ones. ' +
  'Use dry_run=true to preview changes without modifying anything.',
  {
    dryRun: z.boolean().optional().default(false).describe('Preview changes without modifying Azure DevOps'),
    tags: z.string().optional().describe('Cucumber tag expression filter, e.g. "@smoke and not @wip"'),
    configPath: z.string().optional().describe('Path to ado-sync config file'),
    configOverrides: z.array(z.string()).optional().describe('Config overrides, e.g. ["sync.tagPrefix=tc"]'),
  },
  safeHandler(async ({ dryRun, tags, configPath, configOverrides }) => {
    const { config, configDir } = resolveConfig(configPath, configOverrides);
    const results = await push(config, configDir, { dryRun, tags });
    return { content: [{ type: 'text', text: formatSyncResults(results, dryRun) }] };
  })
);

// ─── Tool: pull_specs ─────────────────────────────────────────────────────────

server.tool(
  'pull_specs',
  'Pull Azure DevOps test case changes into local spec files. ' +
  'Use dry_run=true to preview changes without writing files.',
  {
    dryRun: z.boolean().optional().default(false).describe('Preview changes without writing local files'),
    tags: z.string().optional().describe('Cucumber tag expression filter'),
    configPath: z.string().optional().describe('Path to ado-sync config file'),
    configOverrides: z.array(z.string()).optional().describe('Config overrides'),
  },
  safeHandler(async ({ dryRun, tags, configPath, configOverrides }) => {
    const { config, configDir } = resolveConfig(configPath, configOverrides);
    const results = await pull(config, configDir, { dryRun, tags });
    return { content: [{ type: 'text', text: formatSyncResults(results, dryRun) }] };
  })
);

// ─── Tool: status ─────────────────────────────────────────────────────────────

server.tool(
  'status',
  'Show the diff between local spec files and Azure DevOps test cases without making any changes. ' +
  'Returns which tests would be created, updated, or skipped.',
  {
    tags: z.string().optional().describe('Cucumber tag expression filter'),
    configPath: z.string().optional().describe('Path to ado-sync config file'),
    configOverrides: z.array(z.string()).optional().describe('Config overrides'),
  },
  safeHandler(async ({ tags, configPath, configOverrides }) => {
    const { config, configDir } = resolveConfig(configPath, configOverrides);
    const results = await status(config, configDir, { tags });
    return { content: [{ type: 'text', text: formatSyncResults(results, true) }] };
  })
);

// ─── Tool: generate_specs ────────────────────────────────────────────────────

server.tool(
  'generate_specs',
  'Generate local spec files (.feature or .md) from Azure DevOps User Stories. ' +
  'Pulls the story title, description, and acceptance criteria to scaffold the spec file. ' +
  'Optionally uses AI to generate realistic steps from the story content. ' +
  'Provide story_ids, a WIQL query, or an area_path.',
  {
    storyIds: z.array(z.number().int().positive()).optional().describe('ADO work item IDs to generate specs for'),
    query: z.string().optional().describe('WIQL query string to select stories'),
    areaPath: z.string().optional().describe('Area path — generates specs for all User Stories under it'),
    format: z.enum(['gherkin', 'markdown']).optional().describe('Output format (default: based on config local.type)'),
    outputFolder: z.string().optional().describe('Folder to write spec files (default: config pull.targetFolder or config dir)'),
    force: z.boolean().optional().default(false).describe('Overwrite existing spec files'),
    dryRun: z.boolean().optional().default(false).describe('Preview without writing files'),
    aiProvider: z.enum(['local', 'ollama', 'openai', 'anthropic', 'huggingface', 'bedrock', 'azureai', 'github', 'azureinference', 'heuristic']).optional()
      .describe('AI provider for generating spec content from the story description and AC. Auto-detected from environment when omitted.'),
    aiModel: z.string().optional().describe('Model name/path/id for the AI provider'),
    aiKey: z.string().optional().describe('API key for the AI provider ($ENV_VAR reference supported)'),
    aiUrl: z.string().optional().describe('Base URL override for the AI provider endpoint'),
    aiRegion: z.string().optional().describe('AWS region for bedrock provider (default: us-east-1)'),
    configPath: z.string().optional().describe('Path to ado-sync config file'),
    configOverrides: z.array(z.string()).optional().describe('Config overrides'),
  },
  safeHandler(async ({ storyIds, query, areaPath, format, outputFolder, force, dryRun,
          aiProvider, aiModel, aiKey, aiUrl, aiRegion, configPath, configOverrides }) => {
    const { config, configDir } = resolveConfig(configPath, configOverrides);

    // AI opts: prefer explicit params, fall back to config.sync.ai
    const cfgAi = config.sync?.ai;
    const resolvedProvider = aiProvider ?? cfgAi?.provider;
    const aiOpts = resolvedProvider && resolvedProvider !== 'none'
      ? {
          provider: resolvedProvider as import('./ai/generate-spec').AiGenerateProvider,
          model:   aiModel   ?? cfgAi?.model,
          apiKey:  resolveEnvRef(aiKey ?? cfgAi?.apiKey),
          baseUrl: aiUrl     ?? cfgAi?.baseUrl,
          region:  aiRegion  ?? cfgAi?.region,
        }
      : undefined;

    const results = await generateSpecs(config, configDir, {
      storyIds,
      query,
      areaPath,
      format,
      outputFolder,
      force,
      dryRun,
      aiOpts,
    });

    if (!results.length) {
      return { content: [{ type: 'text', text: 'No stories found matching the provided criteria.' }] };
    }

    const created = results.filter(r => r.action === 'created');
    const skipped = results.filter(r => r.action === 'skipped');
    const lines: string[] = [
      `${dryRun ? '[dry-run] ' : ''}Generated ${created.length} spec file(s), skipped ${skipped.length}.`,
      '',
      ...created.map(r => [
        `+ [#${r.storyId}] ${r.title}\n  → ${r.filePath}`,
        ...(r.preview ? [`\n--- preview (first 20 lines) ---\n${r.preview}\n---`] : []),
      ].join('')),
      ...skipped.map(r => `= [#${r.storyId}] ${r.title} (already exists)`),
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── Tool: get_work_items ─────────────────────────────────────────────────────

server.tool(
  'get_work_items',
  'Fetch Azure DevOps work items (User Stories, Bugs, etc.) with their title, description, ' +
  'acceptance criteria, state, and tags. Useful for understanding what needs to be tested before generating specs.',
  {
    ids: z.array(z.number().int().positive()).optional().describe('Work item IDs to fetch'),
    query: z.string().optional().describe('WIQL query to select work items'),
    areaPath: z.string().optional().describe('Fetch all User Stories under this area path'),
    workItemType: z.string().optional().default('User Story').describe('Work item type for area path query (default: "User Story")'),
    configPath: z.string().optional().describe('Path to ado-sync config file'),
  },
  safeHandler(async ({ ids, query, areaPath, workItemType, configPath }) => {
    const { config } = resolveConfig(configPath);
    const client = await AzureClient.create(config);

    let stories;
    if (ids?.length) {
      stories = await getWorkItemsByIds(client, config.project, ids);
    } else if (query) {
      stories = await getWorkItemsByQuery(client, config.project, query);
    } else if (areaPath) {
      stories = await getWorkItemsByAreaPath(client, config.project, areaPath, workItemType);
    } else {
      return { content: [{ type: 'text', text: 'Provide at least one of: ids, query, or areaPath.' }] };
    }

    if (!stories.length) {
      return { content: [{ type: 'text', text: 'No work items found.' }] };
    }

    return {
      content: [{
        type: 'text',
        text: `Found ${stories.length} work item(s).\n\n${JSON.stringify(stories, null, 2)}`,
      }],
    };
  })
);

// ─── Tool: publish_test_results ───────────────────────────────────────────────

server.tool(
  'publish_test_results',
  'Publish test results from result files (TRX, JUnit XML, Cucumber JSON, Playwright JSON) to Azure DevOps. ' +
  'Links results to existing test cases by ID or automated test name.',
  {
    resultFiles: z.array(z.string()).optional().describe('Paths to result files'),
    resultFormat: z.string().optional().describe('Format: trx, junit, nunitXml, cucumberJson, playwrightJson, ctrfJson'),
    runName: z.string().optional().describe('Name for the test run in Azure DevOps'),
    buildId: z.number().int().positive().optional().describe('Build ID to associate with the run'),
    attachmentsFolder: z.string().optional().describe('Folder with screenshots/videos to attach'),
    dryRun: z.boolean().optional().default(false).describe('Parse results without publishing'),
    createIssuesOnFailure: z.boolean().optional().describe('File GitHub Issues or ADO Bugs for failed tests'),
    issueProvider: z.enum(['github', 'ado']).optional().describe('Issue provider: github (default) or ado'),
    githubRepo: z.string().optional().describe('GitHub repository "owner/repo" to file issues in'),
    githubToken: z.string().optional().describe('GitHub token or $ENV_VAR reference'),
    bugThreshold: z.number().optional().describe('Failure % threshold for env-failure mode (default: 20)'),
    maxIssues: z.number().optional().describe('Hard cap on issues per run (default: 50)'),
    configPath: z.string().optional().describe('Path to ado-sync config file'),
    configOverrides: z.array(z.string()).optional().describe('Config overrides'),
  },
  safeHandler(async ({ resultFiles, resultFormat, runName, buildId, attachmentsFolder, dryRun,
           createIssuesOnFailure, issueProvider, githubRepo, githubToken, bugThreshold, maxIssues,
           configPath, configOverrides }) => {
    const { config, configDir } = resolveConfig(configPath, configOverrides);
    const result = await publishTestResults(config, configDir, {
      dryRun,
      resultFiles,
      resultFormat,
      runName,
      buildId,
      attachmentsFolder,
      createIssuesOnFailure,
      issueOverrides: {
        ...(issueProvider && { provider:  issueProvider }),
        ...(githubRepo    && { repo:      githubRepo }),
        ...(githubToken   && { token:     resolveEnvRef(githubToken) }),
        ...(bugThreshold  && { threshold: bugThreshold }),
        ...(maxIssues     && { maxIssues }),
      },
    });

    const lines: string[] = [
      `${dryRun ? '[dry-run] ' : ''}Test results processed.`,
      `  Total:  ${result.totalResults}`,
      `  Passed: ${result.passed}`,
      `  Failed: ${result.failed}`,
      `  Other:  ${result.other}`,
    ];
    if (result.runId) {
      lines.push(`  Run ID: ${result.runId}`);
      lines.push(`  URL:    ${result.runUrl}`);
    }
    if (result.issuesSummary) {
      const s = result.issuesSummary;
      lines.push(`  Issues mode: ${s.mode}  |  Filed: ${s.issued.filter((i) => i.action === 'created').length}  |  Suppressed: ${s.suppressed}`);
      for (const issue of s.issued) {
        lines.push(`    ${issue.action === 'created' ? '+' : '='} ${issue.title}${issue.url ? ' → ' + issue.url : ''}`);
      }
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── Tool: create_issue ───────────────────────────────────────────────────────

server.tool(
  'create_issue',
  'File a GitHub Issue or ADO Bug for a test failure. ' +
  'Intended for use by healer agents after publish_test_results — provides the issue URL to chain into a fix PR workflow.',
  {
    title:         z.string().describe('Issue title (e.g. "[FAILED] Login with valid credentials")'),
    body:          z.string().describe('Issue body in Markdown — include error message, stack trace, and ADO TC link'),
    provider:      z.enum(['github', 'ado']).optional().default('github').describe('Issue provider'),
    githubRepo:    z.string().optional().describe('GitHub repository "owner/repo"'),
    githubToken:   z.string().optional().describe('GitHub token or $ENV_VAR reference'),
    labels:        z.array(z.string()).optional().describe('Labels to apply (GitHub only)'),
    assignees:     z.array(z.string()).optional().describe('GitHub assignees (logins)'),
    testCaseId:    z.number().int().positive().optional().describe('ADO Test Case ID to link the bug to (ADO provider)'),
    areaPath:      z.string().optional().describe('ADO area path for the Bug work item'),
    configPath:    z.string().optional().describe('Path to ado-sync config file'),
    configOverrides: z.array(z.string()).optional().describe('Config overrides'),
  },
  safeHandler(async ({ title, body, provider, githubRepo, githubToken, labels, assignees, testCaseId, areaPath, configPath, configOverrides }) => {
    const { config } = resolveConfig(configPath, configOverrides);

    // Build a minimal CreateIssuesConfig and reuse createIssuesFromResults with a
    // synthetic single-failure result list so all guard/dedup logic is bypassed (threshold=0).
    const issueConfig = {
      provider:      provider ?? 'github' as const,
      repo:          githubRepo,
      token:         resolveEnvRef(githubToken),
      labels:        labels ?? ['test-failure'],
      assignees,
      areaPath,
      threshold:     0,  // bypass threshold guard for explicit single-issue creation
      maxIssues:     1,
      clusterByError: false,
      dedupByTestCase: false,
    };

    const syntheticResult = {
      testName:     title,
      outcome:      'Failed',
      durationMs:   0,
      errorMessage: body,
      testCaseId,
    };

    const summary = await createIssuesFromResults(
      [syntheticResult],
      config,
      issueConfig,
      { totalResults: 1 },
    );

    const created = summary.issued.find((i) => i.action === 'created');
    if (created?.url) {
      return { content: [{ type: 'text', text: `Issue created: ${created.url}` }] };
    }
    const skipped = summary.issued.find((i) => i.action === 'skipped');
    return { content: [{ type: 'text', text: `Issue skipped: ${skipped?.reason ?? 'unknown reason'}` }] };
  })
);

// ─── Tool: get_story_context ──────────────────────────────────────────────────

server.tool(
  'get_story_context',
  'Return a planner-agent-optimised view of an ADO User Story: ' +
  'AC items as a bullet list, inferred test tags (@smoke, @auth…), extracted actors, ' +
  'and IDs of any Test Cases already linked via TestedBy relation. ' +
  'Use this before generate_specs to give the spec writer full context.',
  {
    storyId:         z.number().int().positive().describe('ADO work item ID of the User Story'),
    configPath:      z.string().optional().describe('Path to ado-sync config file'),
    configOverrides: z.array(z.string()).optional().describe('Config overrides'),
  },
  safeHandler(async ({ storyId, configPath, configOverrides }) => {
    const { config } = resolveConfig(configPath, configOverrides);
    const client = await AzureClient.create(config);
    const ctx = await getStoryContext(client, config.project, storyId, config.orgUrl);

    const lines: string[] = [
      `Story #${ctx.storyId}: ${ctx.title}`,
      `State: ${ctx.state ?? 'unknown'}`,
      `URL:   ${ctx.url}`,
      '',
    ];

    if (ctx.acItems.length) {
      lines.push('Acceptance Criteria:');
      ctx.acItems.forEach((item, i) => lines.push(`  ${i + 1}. ${item}`));
      lines.push('');
    }

    lines.push(`Suggested tags:  ${ctx.suggestedTags.join('  ') || '(none)'}`);
    lines.push(`Actors:          ${ctx.suggestedActors.join(', ') || '(none detected)'}`);
    lines.push(`Linked TCs:      ${ctx.relatedTestCases.length ? ctx.relatedTestCases.map((id) => `#${id}`).join(', ') : 'none yet'}`);

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      // Also return structured JSON so agents can parse it without text parsing
      _structured: ctx,
    };
  })
);

// ─── Tool: generate_manifest ──────────────────────────────────────────────────

server.tool(
  'generate_manifest',
  'Write a .ai-workflow-manifest-{id}.json file for one or more ADO User Stories. ' +
  'The manifest contains the ordered workflow steps, AC items, suggested tags, ' +
  'required documents checklist, and validation steps — giving any AI agent the ' +
  'structured context needed to drive the full Planner → Generator → Push → CI → Publish cycle.',
  {
    storyIds:        z.array(z.number().int().positive()).describe('ADO work item IDs to generate manifests for'),
    outputFolder:    z.string().optional().describe('Where to write manifest files (default: config dir)'),
    format:          z.enum(['gherkin', 'markdown']).optional().describe('Spec format to reference in the manifest'),
    force:           z.boolean().optional().default(false).describe('Overwrite existing manifest files'),
    dryRun:          z.boolean().optional().default(false).describe('Return manifest JSON without writing files'),
    configPath:      z.string().optional().describe('Path to ado-sync config file'),
    configOverrides: z.array(z.string()).optional().describe('Config overrides'),
  },
  safeHandler(async ({ storyIds, outputFolder, format, force, dryRun, configPath, configOverrides }) => {
    const { config, configDir } = resolveConfig(configPath, configOverrides);
    const results = await generateManifests(config, configDir, {
      storyIds,
      outputFolder,
      format,
      force: force ?? false,
      dryRun: dryRun ?? false,
    });

    const lines: string[] = [`${dryRun ? '[dry-run] ' : ''}Manifests processed:`];
    for (const r of results) {
      lines.push(`  ${r.action === 'created' ? '+' : '='} [#${r.storyId}] ${r.filePath} — ${r.title}`);
      if (r.manifest) {
        lines.push(`      AC items: ${r.manifest.context.acceptanceCriteria.length}`);
        lines.push(`      Tags:     ${r.manifest.context.suggestedTags.join(' ') || '(none)'}`);
        lines.push(`      Linked TCs: ${r.manifest.context.relatedTestCases.length ? r.manifest.context.relatedTestCases.join(', ') : 'none'}`);
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── Tool: find_tagged_items ──────────────────────────────────────────────────

server.tool(
  'find_tagged_items',
  'Find Azure DevOps work items (User Stories, Bugs, etc.) where a specific tag was added ' +
  'within the last N hours or days. Uses the revisions API to find the exact date and time ' +
  'when the tag first appeared on each item — not just when the item was last changed. ' +
  'Returns id, title, state, current tags, exact tagAddedAt timestamp, revision number, ' +
  'the user who added the tag, and a direct URL to the work item.',
  {
    tag:             z.string().describe('The tag to search for, e.g. "regression" or "sprint-42"'),
    hours:           z.number().positive().optional().describe('Return items where the tag was added in the last N hours'),
    days:            z.number().positive().optional().describe('Return items where the tag was added in the last N days (mutually exclusive with hours)'),
    workItemType:    z.string().optional().default('User Story').describe('Work item type to search (default: "User Story")'),
    configPath:      z.string().optional().describe('Path to ado-sync config file'),
    configOverrides: z.array(z.string()).optional().describe('Config overrides'),
  },
  safeHandler(async ({ tag, hours, days, workItemType, configPath, configOverrides }) => {
    if (!hours && !days) {
      return { content: [{ type: 'text', text: 'Provide either hours or days to define the time window.' }] };
    }

    const windowHours = hours ?? (days! * 24);
    const since = new Date(Date.now() - windowHours * 3600 * 1000);

    const { config } = resolveConfig(configPath, configOverrides);
    const client = await AzureClient.create(config);

    const results = await findStoriesByTagAddedSince(
      client,
      config.project,
      tag,
      since,
      config.orgUrl,
      workItemType,
    );

    if (!results.length) {
      const windowLabel = hours ? `${hours} hour(s)` : `${days} day(s)`;
      return {
        content: [{
          type: 'text',
          text: `No ${workItemType} items found where tag "${tag}" was added in the last ${windowLabel}.`,
        }],
      };
    }

    const lines: string[] = [
      `Found ${results.length} item(s) where tag "${tag}" was added since ${since.toISOString()}:`,
      '',
    ];

    for (const r of results) {
      lines.push(`#${r.id} — ${r.title}`);
      lines.push(`  State:        ${r.state ?? 'unknown'}`);
      lines.push(`  Tag added at: ${r.tagAddedAt}`);
      lines.push(`  Added by:     ${r.tagAddedBy ?? 'unknown'}`);
      lines.push(`  Revision:     ${r.tagAddedRevision}`);
      lines.push(`  Current tags: ${r.currentTags.join(', ') || '(none)'}`);
      lines.push(`  URL:          ${r.url}`);
      lines.push('');
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  })
);

// ─── Shared output helpers ────────────────────────────────────────────────────

function formatSyncResults(results: Array<{ action: string; filePath: string; title: string; azureId?: number; detail?: string; changedFields?: string[] }>, dryRun?: boolean): string {
  const counts: Record<string, number> = {};
  const lines: string[] = [];

  for (const r of results) {
    counts[r.action] = (counts[r.action] ?? 0) + 1;
    const id = r.azureId ? ` [#${r.azureId}]` : '';
    const detail = r.detail ? ` — ${r.detail}` : '';
    const fields = r.changedFields?.length ? ` (${r.changedFields.join(', ')})` : '';

    const symbols: Record<string, string> = {
      created: '+', updated: '~', pulled: '↓', skipped: '=',
      conflict: '!', removed: '−', error: '✗',
    };
    lines.push(`${symbols[r.action] ?? '?'} ${r.title}${id}${fields}${detail}`);
  }

  lines.push('');
  const summary = Object.entries(counts)
    .map(([action, n]) => `${n} ${action}`)
    .join('  ');
  lines.push((dryRun ? '[dry-run] ' : '') + (summary || 'Nothing to sync.'));
  return lines.join('\n');
}

// ─── Start server ─────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[ado-sync mcp] fatal: ${msg}\n`);
  process.exit(1);
});
