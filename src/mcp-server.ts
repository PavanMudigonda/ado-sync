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

// Suppress DEP0169 (url.parse) from azure-devops-node-api
const originalEmit = process.emit;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process as any).emit = function (event: string, ...args: any[]) {
  if (event === 'warning' && args[0]?.code === 'DEP0169') return false;
  return originalEmit.apply(process, [event, ...args] as any);
};

import 'dotenv/config';
import * as path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { AzureClient } from './azure/client';
import { getTestCase, getTestCasesInSuite } from './azure/test-cases';
import { getWorkItemsByAreaPath, getWorkItemsByIds, getWorkItemsByQuery } from './azure/work-items';
import { applyOverrides, loadConfig, resolveConfigPath } from './config';
import { generateSpecs } from './sync/generate';
import { pull, push, status } from './sync/engine';
import { publishTestResults } from './sync/publish-results';

// ─── Config resolution ────────────────────────────────────────────────────────

function resolveConfig(configPath?: string, overrides?: string[]) {
  const resolved = resolveConfigPath(configPath ?? process.env.ADO_SYNC_CONFIG);
  const config = loadConfig(resolved);
  if (overrides?.length) applyOverrides(config, overrides);
  return { config, configDir: path.dirname(resolved), configPath: resolved };
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
    } catch (err: any) {
      checks.push({ label: 'Config loaded', ok: false, detail: err.message });
      return { content: [{ type: 'text', text: formatChecks(checks) }] };
    }

    const { config } = cfg;

    // Step 2: Azure connection
    let client: AzureClient | undefined;
    try {
      client = await AzureClient.create(config);
      checks.push({ label: 'Azure connection', ok: true, detail: config.orgUrl });
    } catch (err: any) {
      checks.push({ label: 'Azure connection', ok: false, detail: err.message });
      return { content: [{ type: 'text', text: formatChecks(checks) }] };
    }

    // Step 3: project
    try {
      const coreApi = await client.getCoreApi();
      const proj = await coreApi.getProject(config.project);
      checks.push({ label: `Project "${config.project}"`, ok: !!proj?.id, detail: proj?.id ? 'found' : 'not found' });
    } catch (err: any) {
      checks.push({ label: `Project "${config.project}"`, ok: false, detail: err.message });
    }

    // Step 4: test plans
    const planApi = await client.getTestPlanApi();
    const planIds = config.testPlans?.map(p => p.id) ?? [config.testPlan.id];
    for (const id of planIds) {
      try {
        const plan = await planApi.getTestPlanById(config.project, id);
        checks.push({ label: `Test Plan #${id}`, ok: !!plan?.id, detail: plan?.name ?? 'not found' });
      } catch (err: any) {
        checks.push({ label: `Test Plan #${id}`, ok: false, detail: err.message });
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
    suiteId: z.number().optional().describe('Suite ID (defaults to plan root suite)'),
    configPath: z.string().optional().describe('Path to ado-sync config file'),
  },
  async ({ suiteId, configPath }) => {
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
  }
);

// ─── Tool: get_test_case ──────────────────────────────────────────────────────

server.tool(
  'get_test_case',
  'Fetch a single Azure DevOps test case by ID. Returns full details including steps.',
  {
    id: z.number().describe('Azure DevOps Test Case work item ID'),
    configPath: z.string().optional().describe('Path to ado-sync config file'),
  },
  async ({ id, configPath }) => {
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
  }
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
  async ({ dryRun, tags, configPath, configOverrides }) => {
    const { config, configDir } = resolveConfig(configPath, configOverrides);
    const results = await push(config, configDir, { dryRun, tags });
    return { content: [{ type: 'text', text: formatSyncResults(results, dryRun) }] };
  }
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
  async ({ dryRun, tags, configPath, configOverrides }) => {
    const { config, configDir } = resolveConfig(configPath, configOverrides);
    const results = await pull(config, configDir, { dryRun, tags });
    return { content: [{ type: 'text', text: formatSyncResults(results, dryRun) }] };
  }
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
  async ({ tags, configPath, configOverrides }) => {
    const { config, configDir } = resolveConfig(configPath, configOverrides);
    const results = await status(config, configDir, { tags });
    return { content: [{ type: 'text', text: formatSyncResults(results, true) }] };
  }
);

// ─── Tool: generate_specs ────────────────────────────────────────────────────

server.tool(
  'generate_specs',
  'Generate local spec files (.feature or .md) from Azure DevOps User Stories. ' +
  'Pulls the story title, description, and acceptance criteria to scaffold the spec file. ' +
  'Provide story_ids, a WIQL query, or an area_path.',
  {
    storyIds: z.array(z.number()).optional().describe('ADO work item IDs to generate specs for'),
    query: z.string().optional().describe('WIQL query string to select stories'),
    areaPath: z.string().optional().describe('Area path — generates specs for all User Stories under it'),
    format: z.enum(['gherkin', 'markdown']).optional().describe('Output format (default: based on config local.type)'),
    outputFolder: z.string().optional().describe('Folder to write spec files (default: config pull.targetFolder or config dir)'),
    force: z.boolean().optional().default(false).describe('Overwrite existing spec files'),
    dryRun: z.boolean().optional().default(false).describe('Preview without writing files'),
    configPath: z.string().optional().describe('Path to ado-sync config file'),
    configOverrides: z.array(z.string()).optional().describe('Config overrides'),
  },
  async ({ storyIds, query, areaPath, format, outputFolder, force, dryRun, configPath, configOverrides }) => {
    const { config, configDir } = resolveConfig(configPath, configOverrides);
    const results = await generateSpecs(config, configDir, {
      storyIds,
      query,
      areaPath,
      format,
      outputFolder,
      force,
      dryRun,
    });

    if (!results.length) {
      return { content: [{ type: 'text', text: 'No stories found matching the provided criteria.' }] };
    }

    const created = results.filter(r => r.action === 'created');
    const skipped = results.filter(r => r.action === 'skipped');
    const lines: string[] = [
      `${dryRun ? '[dry-run] ' : ''}Generated ${created.length} spec file(s), skipped ${skipped.length}.`,
      '',
      ...created.map(r => `+ [#${r.storyId}] ${r.title}\n  → ${r.filePath}`),
      ...skipped.map(r => `= [#${r.storyId}] ${r.title} (already exists)`),
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ─── Tool: get_work_items ─────────────────────────────────────────────────────

server.tool(
  'get_work_items',
  'Fetch Azure DevOps work items (User Stories, Bugs, etc.) with their title, description, ' +
  'acceptance criteria, state, and tags. Useful for understanding what needs to be tested before generating specs.',
  {
    ids: z.array(z.number()).optional().describe('Work item IDs to fetch'),
    query: z.string().optional().describe('WIQL query to select work items'),
    areaPath: z.string().optional().describe('Fetch all User Stories under this area path'),
    workItemType: z.string().optional().default('User Story').describe('Work item type for area path query (default: "User Story")'),
    configPath: z.string().optional().describe('Path to ado-sync config file'),
  },
  async ({ ids, query, areaPath, workItemType, configPath }) => {
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
  }
);

// ─── Tool: publish_test_results ───────────────────────────────────────────────

server.tool(
  'publish_test_results',
  'Publish test results from result files (TRX, JUnit XML, Cucumber JSON, Playwright JSON) to Azure DevOps. ' +
  'Links results to existing test cases by ID or automated test name.',
  {
    resultFiles: z.array(z.string()).optional().describe('Paths to result files'),
    resultFormat: z.string().optional().describe('Format: trx, junit, nunitXml, cucumberJson, playwrightJson'),
    runName: z.string().optional().describe('Name for the test run in Azure DevOps'),
    buildId: z.number().optional().describe('Build ID to associate with the run'),
    attachmentsFolder: z.string().optional().describe('Folder with screenshots/videos to attach'),
    dryRun: z.boolean().optional().default(false).describe('Parse results without publishing'),
    configPath: z.string().optional().describe('Path to ado-sync config file'),
    configOverrides: z.array(z.string()).optional().describe('Config overrides'),
  },
  async ({ resultFiles, resultFormat, runName, buildId, attachmentsFolder, dryRun, configPath, configOverrides }) => {
    const { config, configDir } = resolveConfig(configPath, configOverrides);
    const result = await publishTestResults(config, configDir, {
      dryRun,
      resultFiles,
      resultFormat,
      runName,
      buildId,
      attachmentsFolder,
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
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
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

main().catch((err) => {
  process.stderr.write(`[ado-sync mcp] fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
