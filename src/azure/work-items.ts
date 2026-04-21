/**
 * Fetch Azure DevOps User Stories (or any work item type) with their
 * Acceptance Criteria and Description fields, for use by the `generate` command.
 *
 * Also exposes getStoryContext() — a richer, planner-agent-optimised view that
 * adds related Test Case IDs, bullet-formatted AC items, suggested tags, and
 * extracted actors (user roles) parsed from the Acceptance Criteria text.
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
  
  let text = html;
  let previous: string;
  do {
    previous = text;
    text = text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<li>/gi, '- ')
      .replace(/<[^>]+>/g, '');
  } while (text !== previous);

  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
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
 * Fetch the IDs of Test Cases already linked (TestedBy relation) to the given story IDs.
 * Returns a Map of storyId → TC ID array. Stories with no linked TCs are absent from the map.
 * Uses WorkItemExpand.Relations (=1) to include relations in a single batched call.
 */
export async function fetchLinkedTestCaseIds(
  client: AzureClient,
  storyIds: number[]
): Promise<Map<number, number[]>> {
  if (!storyIds.length) return new Map();
  const witApi = await client.getWitApi();
  const result = new Map<number, number[]>();

  const BATCH = 200;
  for (let i = 0; i < storyIds.length; i += BATCH) {
    const batch = storyIds.slice(i, i + BATCH);
    // WorkItemExpand.Relations = 1
    const items = await witApi.getWorkItems(batch, undefined, undefined, 1 as any);
    for (const wi of items ?? []) {
      if (!wi) continue;
      const relations: any[] = wi.relations ?? [];
      const tcIds = relations
        .filter((r) => typeof r.rel === 'string' && r.rel.includes('TestedBy'))
        .map((r) => {
          const m = (r.url ?? '').match(/\/(\d+)$/);
          return m ? parseInt(m[1], 10) : NaN;
        })
        .filter((id) => !isNaN(id));
      if (tcIds.length && wi.id != null) result.set(wi.id, tcIds);
    }
  }
  return result;
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

// ─── Story context (planner agent feed) ──────────────────────────────────────

export interface StoryContext {
  storyId: number;
  title: string;
  description?: string;
  /** Raw AC text — HTML stripped */
  acceptanceCriteria?: string;
  /** AC split into individual bullet items, stripped of list markers */
  acItems: string[];
  state?: string;
  adoTags?: string[];
  /** Inferred test tags from AC/title keywords: @smoke, @regression, @auth, etc. */
  suggestedTags: string[];
  /** User roles / actors extracted from AC text (e.g. "admin", "guest user") */
  suggestedActors: string[];
  /** ADO Test Case IDs already linked to this story via TestedBy relation */
  relatedTestCases: number[];
  /** Direct URL to the work item in Azure DevOps */
  url: string;
}

/**
 * Return a planner-agent-optimised view of a single User Story.
 * Includes related TC IDs (already written), suggested tags, and extracted actors.
 */
export async function getStoryContext(
  client: AzureClient,
  project: string,
  storyId: number,
  orgUrl: string,
): Promise<StoryContext> {
  const witApi = await client.getWitApi();

  // Fetch with relations expanded (4 = WorkItemExpand.Relations)
  const wi = await (witApi as any).getWorkItem(storyId, undefined, undefined, 4);
  const f  = wi?.fields ?? {};

  const rawTitle = f['System.Title'] ?? `Work Item ${storyId}`;
  const rawDesc  = f['System.Description'];
  const rawAc    = f['Microsoft.VSTS.Common.AcceptanceCriteria'];
  const rawTags  = f['System.Tags'] ?? '';

  const description        = stripHtml(rawDesc);
  const acceptanceCriteria = stripHtml(rawAc);

  // AC bullet items — split on newlines, strip list markers, drop blank lines
  const acItems = (acceptanceCriteria ?? '')
    .split('\n')
    .map((l) => l.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((l) => l.length > 0);

  const adoTags = rawTags
    ? rawTags.split(';').map((t: string) => t.trim()).filter(Boolean)
    : [];

  // Extract related TC IDs from relations
  const relations: any[] = wi?.relations ?? [];
  const relatedTestCases = relations
    .filter((r) => typeof r.rel === 'string' && r.rel.includes('TestedBy'))
    .map((r) => {
      const match = (r.url ?? '').match(/\/(\d+)$/);
      return match ? parseInt(match[1], 10) : NaN;
    })
    .filter((id) => !isNaN(id));

  const searchText = [rawTitle, acceptanceCriteria ?? '', description ?? ''].join(' ').toLowerCase();
  const suggestedTags   = inferTags(searchText);
  const suggestedActors = extractActors(acceptanceCriteria ?? '');

  const url = `${orgUrl.replace(/\/$/, '')}/${project}/_workitems/edit/${storyId}`;

  return {
    storyId,
    title: rawTitle,
    description,
    acceptanceCriteria,
    acItems,
    state: f['System.State'],
    adoTags: adoTags.length ? adoTags : undefined,
    suggestedTags,
    suggestedActors,
    relatedTestCases,
    url,
  };
}

// ─── Tag inference ────────────────────────────────────────────────────────────

const TAG_RULES: Array<{ patterns: RegExp; tag: string }> = [
  { patterns: /\bsmoke\b/,                                       tag: '@smoke' },
  { patterns: /\bregression\b/,                                  tag: '@regression' },
  { patterns: /\b(login|sign[- ]?in|sign[- ]?out|log[- ]?out|auth(entication|oriz)?)\b/, tag: '@auth' },
  { patterns: /\b(payment|checkout|billing|invoice|refund)\b/,  tag: '@payment' },
  { patterns: /\b(performance|load test|speed|latency)\b/,      tag: '@performance' },
  { patterns: /\bmobile\b/,                                      tag: '@mobile' },
  { patterns: /\b(api|endpoint|rest|graphql|webhook)\b/,        tag: '@api' },
  { patterns: /\b(security|permission|role|access control)\b/,  tag: '@security' },
  { patterns: /\b(search|filter|sort)\b/,                       tag: '@search' },
  { patterns: /\b(upload|download|file|attachment)\b/,          tag: '@files' },
  { patterns: /\b(notification|email|sms|alert)\b/,             tag: '@notifications' },
  { patterns: /\b(report|export|csv|excel|pdf)\b/,              tag: '@reporting' },
  { patterns: /\bcritical\b/,                                    tag: '@critical' },
  { patterns: /\bwip\b/,                                        tag: '@wip' },
];

function inferTags(text: string): string[] {
  return TAG_RULES
    .filter((r) => r.patterns.test(text))
    .map((r) => r.tag);
}

// ─── Actor extraction ─────────────────────────────────────────────────────────

function extractActors(ac: string): string[] {
  const found = new Set<string>();

  // "As a <actor>" / "As an <actor>"
  for (const m of ac.matchAll(/\bas an?\s+([a-z][a-z\s]{1,25}?)(?:,|\.|I |can |should |must )/gi)) {
    const actor = m[1].trim().replace(/\s+/g, ' ');
    if (actor) found.add(actor);
  }
  // "the <actor> can/should/must"
  for (const m of ac.matchAll(/\bthe\s+([a-z][a-z\s]{1,20}?)\s+(?:can|should|must|is able to)\b/gi)) {
    const actor = m[1].trim().replace(/\s+/g, ' ');
    if (actor && actor.split(' ').length <= 3) found.add(actor);
  }

  // Deduplicate substrings (e.g. "admin" vs "admin user" — keep longer)
  const actors = [...found];
  return actors.filter((a) => !actors.some((b) => b !== a && b.includes(a)));
}

// ─── AC validation gate ───────────────────────────────────────────────────────

export type AcGateOutcome = 'pass' | 'no-ac' | 'no-tc';

export interface AcGateResult {
  storyId: number;
  title: string;
  state?: string;
  url: string;
  outcome: AcGateOutcome;
  /** Number of AC items found */
  acCount: number;
  /** Test Case IDs already linked to this story */
  linkedTcs: number[];
}

export interface AcGateReport {
  passed: AcGateResult[];
  failed: AcGateResult[];
  /** Exit code: 0 when all pass, 1 when any fail */
  exitCode: 0 | 1;
}

/**
 * Validate that each story in `storyIds` has:
 *   - at least one AC item
 *   - at least one linked Test Case
 *
 * Returns a report with per-story outcomes and an overall exitCode.
 */
export async function acGate(
  client: AzureClient,
  project: string,
  storyIds: number[],
  orgUrl: string,
): Promise<AcGateReport> {
  const witApi = await client.getWitApi();
  const passed: AcGateResult[] = [];
  const failed: AcGateResult[] = [];

  for (const id of storyIds) {
    // Expand relations (4 = WorkItemExpand.Relations)
    const wi = await (witApi as any).getWorkItem(id, undefined, undefined, 4);
    const f   = wi?.fields ?? {};

    const rawAc    = f['Microsoft.VSTS.Common.AcceptanceCriteria'];
    const rawTitle = f['System.Title'] ?? `Work Item ${id}`;
    const state    = f['System.State'];

    const acText = stripHtml(rawAc) ?? '';
    const acItems = acText
      .split('\n')
      .map((l: string) => l.replace(/^[-*•\d.)\s]+/, '').trim())
      .filter((l: string) => l.length > 0);

    const relations: any[] = wi?.relations ?? [];
    const linkedTcs = relations
      .filter((r) => typeof r.rel === 'string' && r.rel.includes('TestedBy'))
      .map((r) => {
        const m = (r.url ?? '').match(/\/(\d+)$/);
        return m ? parseInt(m[1], 10) : NaN;
      })
      .filter((tcId: number) => !isNaN(tcId));

    const url = `${orgUrl.replace(/\/$/, '')}/${project}/_workitems/edit/${id}`;

    let outcome: AcGateOutcome;
    if (acItems.length === 0) {
      outcome = 'no-ac';
    } else if (linkedTcs.length === 0) {
      outcome = 'no-tc';
    } else {
      outcome = 'pass';
    }

    const result: AcGateResult = { storyId: id, title: rawTitle, state, url, outcome, acCount: acItems.length, linkedTcs };
    if (outcome === 'pass') {
      passed.push(result);
    } else {
      failed.push(result);
    }
  }

  return { passed, failed, exitCode: failed.length > 0 ? 1 : 0 };
}

// ─── Tag-added-since query ────────────────────────────────────────────────────

export interface TagAddedResult {
  id: number;
  title: string;
  state?: string;
  currentTags: string[];
  /** The exact ISO timestamp when the tag was first added to this work item. */
  tagAddedAt: string;
  /** Revision number where the tag appeared for the first time. */
  tagAddedRevision: number;
  /** Display name of the user who added the tag (if available). */
  tagAddedBy?: string;
  url: string;
}

/**
 * Find work items of a given type that currently contain `tag` AND where
 * the tag was added within the specified time window.
 *
 * Strategy:
 *  1. WIQL to fetch all work items of `workItemType` that contain `tag`
 *     and were changed on/after `since` (pre-filter to limit revision fetches).
 *  2. For each candidate, page through revisions to find the first revision
 *     where `tag` appeared in System.Tags.
 *  3. Return only those items where that revision's ChangedDate >= `since`.
 */
export async function findStoriesByTagAddedSince(
  client: AzureClient,
  project: string,
  tag: string,
  since: Date,
  orgUrl: string,
  workItemType: string | string[] = 'User Story',
): Promise<TagAddedResult[]> {
  const witApi = await client.getWitApi();

  // Normalise to array, trim whitespace
  const types = (Array.isArray(workItemType) ? workItemType : workItemType.split(','))
    .map((t) => t.trim())
    .filter(Boolean);

  // Escape single quotes for WIQL
  const safeProject = project.replace(/'/g, "''");
  const safeTag     = tag.replace(/'/g, "''");
  // WIQL only supports date precision (no time component) — truncate to YYYY-MM-DD.
  // We still filter by exact time when scanning revisions below.
  const sinceDate = since.toISOString().slice(0, 10);

  // Build type filter: single type uses =, multiple uses IN (...)
  const typeFilter = types.length === 1
    ? `[System.WorkItemType] = '${types[0].replace(/'/g, "''")}'`
    : `[System.WorkItemType] IN (${types.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ')})`;

  // Pre-filter: only work items that have the tag AND were changed recently.
  // This avoids fetching revisions for every item in the project.
  const wiql =
    `SELECT [System.Id] FROM WorkItems ` +
    `WHERE [System.TeamProject] = '${safeProject}' ` +
    `AND ${typeFilter} ` +
    `AND [System.Tags] CONTAINS '${safeTag}' ` +
    `AND [System.ChangedDate] >= '${sinceDate}' ` +
    `ORDER BY [System.ChangedDate] DESC`;

  const queryResult = await witApi.queryByWiql({ query: wiql }, { project });
  const ids = (queryResult.workItems ?? []).map((ref: any) => ref.id as number).filter(Boolean);

  if (!ids.length) return [];

  // Fetch current field values for all candidates in one batch call
  const fieldsNeeded = ['System.Id', 'System.Title', 'System.State', 'System.Tags'];
  const BATCH = 200;
  const currentItems: Map<number, any> = new Map();
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const wis = await witApi.getWorkItems(batch, fieldsNeeded);
    for (const wi of wis ?? []) {
      if (wi?.id) currentItems.set(wi.id, wi.fields);
    }
  }

  const normaliseTag = (t: string) => t.toLowerCase().trim();
  const targetTag = normaliseTag(tag);

  const hasTag = (rawTags: string | undefined): boolean => {
    if (!rawTags) return false;
    return rawTags.split(/[;,]/).some((t) => normaliseTag(t) === targetTag);
  };

  const results: TagAddedResult[] = [];

  for (const id of ids) {
    // Fetch all revisions for this work item (paged if needed)
    let revisions: any[] = [];
    try {
      // getRevisions returns up to 200; use $top + $skip for more
      let skip = 0;
      const PAGE = 200;
      while (true) {
        const page = await (witApi as any).getRevisions(id, PAGE, skip);
        if (!page?.length) break;
        revisions.push(...page);
        if (page.length < PAGE) break;
        skip += PAGE;
      }
    } catch {
      continue;
    }

    // Walk revisions in order to find the first one where the tag appeared
    let firstAddedRevision: any | undefined;
    for (let i = 0; i < revisions.length; i++) {
      const rev = revisions[i];
      const prevTags: string = revisions[i - 1]?.fields?.['System.Tags'] ?? '';
      const curTags: string  = rev.fields?.['System.Tags'] ?? '';
      if (hasTag(curTags) && !hasTag(prevTags)) {
        firstAddedRevision = rev;
        break;
      }
    }

    if (!firstAddedRevision) continue;

    const tagAddedAt: string = firstAddedRevision.fields?.['System.ChangedDate'] ?? '';
    if (!tagAddedAt) continue;

    const addedDate = new Date(tagAddedAt);
    if (addedDate < since) continue;

    const f = currentItems.get(id) ?? {};
    const rawTags: string = f['System.Tags'] ?? '';
    const currentTags = rawTags.split(/[;,]/).map((t: string) => t.trim()).filter(Boolean);

    const changedBy: string | undefined =
      firstAddedRevision.fields?.['System.ChangedBy']?.displayName ??
      firstAddedRevision.fields?.['System.ChangedBy'] ??
      undefined;

    results.push({
      id,
      title: f['System.Title'] ?? `Work Item ${id}`,
      state: f['System.State'],
      currentTags,
      tagAddedAt,
      tagAddedRevision: firstAddedRevision.rev ?? 0,
      tagAddedBy: typeof changedBy === 'string' ? changedBy : undefined,
      url: `${orgUrl.replace(/\/$/, '')}/${project}/_workitems/edit/${id}`,
    });
  }

  // Sort by tagAddedAt descending (most recent first)
  results.sort((a, b) => b.tagAddedAt.localeCompare(a.tagAddedAt));
  return results;
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
