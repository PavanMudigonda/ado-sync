/**
 * Fetch Azure DevOps User Stories (or any work item type) with their
 * Acceptance Criteria and Description fields, for use by the `generate` command.
 */

import { AzureClient } from './client';

export interface AdoStory {
  id: number;
  title: string;
  /** System.Description — HTML stripped */
  description?: string;
  /** Microsoft.VSTS.Common.AcceptanceCriteria — HTML stripped */
  acceptanceCriteria?: string;
  state?: string;
  /** Semicolon-separated ADO tags split into an array */
  tags?: string[];
  workItemType?: string;
}

const FIELDS = [
  'System.Id',
  'System.Title',
  'System.Description',
  'Microsoft.VSTS.Common.AcceptanceCriteria',
  'System.State',
  'System.Tags',
  'System.WorkItemType',
];

/** Strip HTML tags and normalise whitespace. */
function stripHtml(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || undefined;
}

function mapWorkItem(wi: any): AdoStory {
  const f = wi.fields ?? {};
  const rawTags: string = f['System.Tags'] ?? '';
  const tags = rawTags
    ? rawTags.split(';').map((t: string) => t.trim()).filter(Boolean)
    : undefined;

  return {
    id: wi.id,
    title: f['System.Title'] ?? `Work Item ${wi.id}`,
    description: stripHtml(f['System.Description']),
    acceptanceCriteria: stripHtml(f['Microsoft.VSTS.Common.AcceptanceCriteria']),
    state: f['System.State'],
    tags: tags?.length ? tags : undefined,
    workItemType: f['System.WorkItemType'],
  };
}

/**
 * Fetch work items by explicit IDs.
 * Batches in groups of 200 (ADO limit per call).
 */
export async function getWorkItemsByIds(
  client: AzureClient,
  _project: string,
  ids: number[]
): Promise<AdoStory[]> {
  if (!ids.length) return [];
  const witApi = await client.getWitApi();

  const BATCH = 200;
  const results: AdoStory[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const items = await witApi.getWorkItems(batch, FIELDS);
    for (const wi of items ?? []) {
      if (wi) results.push(mapWorkItem(wi));
    }
  }
  return results;
}

/**
 * Fetch work items using a WIQL query string.
 * The query should be a valid WIQL SELECT statement, e.g.:
 *   "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'User Story'"
 */
export async function getWorkItemsByQuery(
  client: AzureClient,
  project: string,
  wiql: string
): Promise<AdoStory[]> {
  const witApi = await client.getWitApi();
  const queryResult = await witApi.queryByWiql({ query: wiql }, { project });
  const ids = (queryResult.workItems ?? []).map((ref: any) => ref.id as number).filter(Boolean);
  return getWorkItemsByIds(client, project, ids);
}

/**
 * Fetch User Stories under a specific area path.
 */
export async function getWorkItemsByAreaPath(
  client: AzureClient,
  project: string,
  areaPath: string,
  workItemType = 'User Story'
): Promise<AdoStory[]> {
  const wiql =
    `SELECT [System.Id] FROM WorkItems ` +
    `WHERE [System.TeamProject] = '${project.replace(/'/g, "''")}' ` +
    `AND [System.WorkItemType] = '${workItemType}' ` +
    `AND [System.AreaPath] UNDER '${areaPath.replace(/'/g, "''")}'` +
    ` ORDER BY [System.Id]`;
  return getWorkItemsByQuery(client, project, wiql);
}
