/**
 * Create Azure DevOps Bug work items for test failures.
 */

import { AzureClient } from '../azure/client';
import { SyncConfig } from '../types';

export interface AdoBugOptions {
  title: string;
  /** Repro steps in Markdown — converted to HTML for the ADO field */
  body: string;
  areaPath?: string;
  assignTo?: string;
  /** ADO Test Case ID to link via TestedBy-Reverse relation */
  testCaseId?: number;
}

export interface AdoBugResult {
  id: number;
  url: string;
}

export async function createAdoBug(config: SyncConfig, opts: AdoBugOptions): Promise<AdoBugResult> {
  const client = await AzureClient.create(config);
  const witApi = await client.getWitApi();

  const patch: any[] = [
    { op: 'add', path: '/fields/System.Title',                  value: opts.title },
    { op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: mdToHtml(opts.body) },
    { op: 'add', path: '/fields/System.Tags',                   value: 'ado-sync;test-failure' },
  ];

  if (opts.areaPath) {
    patch.push({ op: 'add', path: '/fields/System.AreaPath',   value: opts.areaPath });
  }
  if (opts.assignTo) {
    patch.push({ op: 'add', path: '/fields/System.AssignedTo', value: opts.assignTo });
  }

  const wi = await witApi.createWorkItem(null as any, patch, config.project, 'Bug');
  const id = wi.id!;

  // Link to TC after creation (separate patch — avoids relation validation issues on create)
  if (opts.testCaseId) {
    const tcUrl = `${config.orgUrl.replace(/\/$/, '')}/_apis/wit/workItems/${opts.testCaseId}`;
    const linkPatch: any[] = [{ op: 'add', path: '/relations/-', value: { rel: 'Microsoft.VSTS.Common.TestedBy-Reverse', url: tcUrl } }];
    await witApi.updateWorkItem(null as any, linkPatch, id);
  }

  const url = (wi as any)._links?.html?.href ?? `${config.orgUrl.replace(/\/$/, '')}/${config.project}/_workitems/edit/${id}`;
  return { id, url };
}

/**
 * Find an open Bug whose title matches exactly — used for dedup.
 * Returns the bug ID if found, null otherwise.
 */
export async function findOpenAdoBug(config: SyncConfig, title: string): Promise<number | null> {
  const client = await AzureClient.create(config);
  const witApi = await client.getWitApi();

  const escaped = escapeWiql(title);
  const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'Bug' AND [System.State] NOT IN ('Closed','Resolved','Done') AND [System.Title] = '${escaped}' AND [System.TeamProject] = '${escapeWiql(config.project)}'`;
  const result = await witApi.queryByWiql({ query: wiql }, { project: config.project });
  return result.workItems?.[0]?.id ?? null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Escape a string for safe interpolation into a WIQL single-quoted literal. */
function escapeWiql(value: string): string {
  return value.replace(/'/g, "''");
}

function mdToHtml(md: string): string {
  return md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/```[\s\S]*?```/g, (m) => `<pre><code>${m.slice(3, -3).trim()}</code></pre>`)
    .replace(/\n/g, '<br>');
}
