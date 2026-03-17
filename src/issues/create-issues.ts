/**
 * Create GitHub Issues or ADO Bugs for failed test results.
 *
 * Guards applied in order before any issue is filed:
 *   1. Failure-rate threshold  — if >N% fail → one environment-failure issue
 *   2. Error clustering        — same error message → one cluster issue per group
 *   3. Hard cap                — stop after maxIssues; file one overflow summary
 *   4. Dedup                   — skip if an open issue for the same TC already exists
 */

import { ParsedResult } from '../sync/publish-results';
import { CreateIssuesConfig, SyncConfig } from '../types';
import { createAdoBug, findOpenAdoBug } from './ado-bugs';
import { createGitHubIssue, findOpenGitHubIssueByLabel } from './github';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RunInfo {
  runId?:   number;
  runUrl?:  string;
  buildId?: number;
  /** Total results in the run (passed + failed + other) — used for threshold. */
  totalResults: number;
}

export type IssueAction = 'created' | 'skipped' | 'suppressed';

export interface IssueFilingResult {
  action:  IssueAction;
  title:   string;
  url?:    string;
  reason?: string;
}

export interface CreateIssuesResult {
  mode:         'per-test' | 'cluster' | 'environment' | 'dry-run';
  issued:       IssueFilingResult[];
  totalFailed:  number;
  suppressed:   number;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function createIssuesFromResults(
  results:     ParsedResult[],
  config:      SyncConfig,
  issueConfig: CreateIssuesConfig,
  runInfo:     RunInfo,
  dryRun = false,
): Promise<CreateIssuesResult> {
  const failed = results.filter((r) => r.outcome === 'Failed');
  const totalFailed    = failed.length;
  const totalResults   = runInfo.totalResults;

  const threshold      = issueConfig.threshold      ?? 20;
  const maxIssues      = issueConfig.maxIssues       ?? 50;
  const clusterByError = issueConfig.clusterByError  !== false;
  const dedupEnabled   = issueConfig.dedupByTestCase !== false;
  const provider       = issueConfig.provider        ?? 'github';

  const issued: IssueFilingResult[] = [];
  let suppressed = 0;

  if (totalFailed === 0) {
    return { mode: 'per-test', issued, totalFailed: 0, suppressed: 0 };
  }

  // ── Guard 1: Failure-rate threshold ─────────────────────────────────────────
  const failureRate = totalResults > 0 ? (totalFailed / totalResults) * 100 : 100;
  if (failureRate > threshold) {
    const title = `[ENV FAILURE] ${totalFailed}/${totalResults} tests failed (${Math.round(failureRate)}%)`;
    if (dryRun) {
      return { mode: 'environment', issued: [{ action: 'created', title, reason: 'dry-run' }], totalFailed, suppressed: totalFailed - 1 };
    }
    const body = buildEnvFailureBody(failed, runInfo);
    const url = await fileIssue(provider, config, issueConfig, title, body, ['test-failure', 'environment-failure']);
    return { mode: 'environment', issued: [{ action: 'created', url, title }], totalFailed, suppressed: totalFailed - 1 };
  }

  // ── Guard 2: Error clustering ────────────────────────────────────────────────
  const batches = clusterByError ? clusterByErrorSignature(failed) : failed.map((t) => [t]);
  const mode: 'per-test' | 'cluster' = batches.some((b) => b.length > 1) ? 'cluster' : 'per-test';

  for (const batch of batches) {
    // ── Guard 3: Hard cap ──────────────────────────────────────────────────────
    if (issued.filter((i) => i.action === 'created').length >= maxIssues) {
      suppressed += batch.length;
      continue;
    }

    const isCluster = batch.length > 1;
    const first     = batch[0];
    const title     = isCluster
      ? `[CLUSTER] ${errorSignature(first.errorMessage)} (${batch.length} tests)`
      : `[FAILED] ${first.testName}`;

    // ── Guard 4: Dedup ─────────────────────────────────────────────────────────
    if (dedupEnabled && !isCluster && first.testCaseId !== undefined) {
      const existing = await checkDuplicate(provider, config, issueConfig, first);
      if (existing) {
        issued.push({ action: 'skipped', title, reason: `open issue exists: ${existing}` });
        continue;
      }
    }

    if (dryRun) {
      issued.push({ action: 'created', title, reason: 'dry-run' });
      continue;
    }

    const labels = isCluster ? [...(issueConfig.labels ?? ['test-failure']), 'error-cluster']
                             : buildLabels(issueConfig.labels, first.testCaseId);
    const body   = isCluster
      ? buildClusterBody(batch, runInfo)
      : buildTestFailureBody(first, runInfo, config.orgUrl, config.project);

    const url = await fileIssue(provider, config, issueConfig, title, body, labels, isCluster ? undefined : first);
    issued.push({ action: 'created', url, title });
  }

  // ── Guard 3 overflow summary ─────────────────────────────────────────────────
  if (suppressed > 0 && !dryRun) {
    const title = `[OVERFLOW] ${suppressed} additional failures suppressed (cap: ${maxIssues})`;
    const body  = [
      `**${issued.filter((i) => i.action === 'created').length}** issues were filed for this run.`,
      `An additional **${suppressed}** failures were suppressed to stay within the \`maxIssues\` limit of ${maxIssues}.`,
      '',
      runInfo.runUrl ? `[View full test run](${runInfo.runUrl})` : '',
      '',
      'Consider investigating whether this is an environment-level failure.',
    ].join('\n');
    const url = await fileIssue(provider, config, issueConfig, title, body, ['test-failure', 'overflow']);
    issued.push({ action: 'created', url, title });
  }

  return { mode, issued, totalFailed, suppressed };
}

// ─── Clustering ───────────────────────────────────────────────────────────────

/** Returns a short human-readable fingerprint of an error message. */
function errorSignature(msg?: string): string {
  if (!msg) return 'unknown error';
  // Take first non-empty line, strip timestamps/numbers, cap length
  const first = msg.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? msg;
  return first.replace(/\d+/g, 'N').slice(0, 80);
}

/** Group failures by error signature. Clusters with >1 member go first. */
function clusterByErrorSignature(failed: ParsedResult[]): ParsedResult[][] {
  const map = new Map<string, ParsedResult[]>();
  for (const r of failed) {
    const key = errorSignature(r.errorMessage);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  // Largest clusters first so we use the cap budget on the most impactful groups
  return [...map.values()].sort((a, b) => b.length - a.length);
}

// ─── Dedup ────────────────────────────────────────────────────────────────────

async function checkDuplicate(
  provider:    string,
  config:      SyncConfig,
  issueConfig: CreateIssuesConfig,
  result:      ParsedResult,
): Promise<string | null> {
  const tcId = result.testCaseId!;
  if (provider === 'github') {
    const token = resolveToken(issueConfig.token);
    if (!token || !issueConfig.repo) return null;
    const existing = await findOpenGitHubIssueByLabel(issueConfig.repo, token, `tc:${tcId}`).catch(() => null);
    return existing ? existing.html_url : null;
  } else {
    const existingId = await findOpenAdoBug(config, `[FAILED] ${result.testName}`).catch(() => null);
    return existingId ? `${config.orgUrl}/${config.project}/_workitems/edit/${existingId}` : null;
  }
}

// ─── Issue filing ─────────────────────────────────────────────────────────────

async function fileIssue(
  provider:    string,
  config:      SyncConfig,
  issueConfig: CreateIssuesConfig,
  title:       string,
  body:        string,
  labels:      string[],
  result?:     ParsedResult,
): Promise<string> {
  if (provider === 'github') {
    const token = resolveToken(issueConfig.token);
    if (!token)            throw new Error('GitHub token is required (--github-token or createIssuesOnFailure.token)');
    if (!issueConfig.repo) throw new Error('GitHub repo is required (--github-repo or createIssuesOnFailure.repo)');
    const issue = await createGitHubIssue({
      repo: issueConfig.repo, token, title, body, labels,
      assignees: issueConfig.assignees,
    });
    return issue.html_url;
  } else {
    const bug = await createAdoBug(config, {
      title, body,
      areaPath:   issueConfig.areaPath,
      assignTo:   issueConfig.assignTo,
      testCaseId: result?.testCaseId,
    });
    return bug.url;
  }
}

function buildLabels(base: string[] | undefined, tcId?: number): string[] {
  const labels = [...(base ?? ['test-failure'])];
  if (tcId !== undefined) labels.push(`tc:${tcId}`);
  return labels;
}

/** Resolve $ENV_VAR references in token strings. */
function resolveToken(token?: string): string | undefined {
  if (!token) return token;
  if (token.startsWith('$')) return process.env[token.slice(1)];
  return token;
}

// ─── Issue body builders ──────────────────────────────────────────────────────

function buildTestFailureBody(result: ParsedResult, runInfo: RunInfo, orgUrl: string, project: string): string {
  const tcLink = result.testCaseId
    ? `[#${result.testCaseId}](${orgUrl.replace(/\/$/, '')}/${project}/_testManagement?testCaseId=${result.testCaseId})`
    : '—';
  const runLink   = runInfo.runUrl  ? `[View run](${runInfo.runUrl})`         : '—';
  const buildLink = runInfo.buildId ? `#${runInfo.buildId}`                   : '—';

  const lines: string[] = [
    `## Test failure: ${result.testName}`,
    '',
    '| Field | Value |',
    '|---|---|',
    `| ADO Test Case | ${tcLink} |`,
    `| Build | ${buildLink} |`,
    `| Run | ${runLink} |`,
    '',
  ];

  if (result.errorMessage) {
    lines.push('### Error', '```', result.errorMessage.trim(), '```', '');
  }
  if (result.stackTrace) {
    lines.push('### Stack trace', '```', result.stackTrace.trim(), '```', '');
  }

  lines.push('---', '_Filed automatically by [ado-sync](https://github.com/PavanMudigonda/ado-sync)_');
  return lines.join('\n');
}

function buildClusterBody(batch: ParsedResult[], runInfo: RunInfo): string {
  const runLink = runInfo.runUrl ? `[View run](${runInfo.runUrl})` : '—';
  const sample  = batch[0];
  const names   = batch.slice(0, 20).map((r) => `- ${r.testName}`).join('\n');
  const overflow = batch.length > 20 ? `\n_… and ${batch.length - 20} more_` : '';

  const lines: string[] = [
    `## Error cluster: ${errorSignature(sample.errorMessage)}`,
    '',
    `**${batch.length} tests failed with the same error.** Run: ${runLink}`,
    '',
    '### Affected tests',
    names + overflow,
    '',
  ];

  if (sample.errorMessage) {
    lines.push('### Error', '```', sample.errorMessage.trim(), '```', '');
  }
  if (sample.stackTrace) {
    lines.push('### Stack trace (first failure)', '```', sample.stackTrace.trim(), '```', '');
  }

  lines.push('---', '_Filed automatically by [ado-sync](https://github.com/PavanMudigonda/ado-sync)_');
  return lines.join('\n');
}

function buildEnvFailureBody(failed: ParsedResult[], runInfo: RunInfo): string {
  const runLink = runInfo.runUrl ? `[View run](${runInfo.runUrl})` : '—';
  const sample  = failed[0];
  const names   = failed.slice(0, 10).map((r) => `- ${r.testName}`).join('\n');
  const overflow = failed.length > 10 ? `\n_… and ${failed.length - 10} more_` : '';

  const lines: string[] = [
    `## Environment failure: ${failed.length} tests failed`,
    '',
    `More than the configured threshold of tests failed in a single run. This likely indicates an **infrastructure or environment issue** rather than individual test failures.`,
    '',
    `**Run:** ${runLink}`,
    '',
    '### Sample failures',
    names + overflow,
    '',
  ];

  if (sample?.errorMessage) {
    lines.push('### Sample error', '```', sample.errorMessage.trim(), '```', '');
  }

  lines.push('---', '_Filed automatically by [ado-sync](https://github.com/PavanMudigonda/ado-sync)_');
  return lines.join('\n');
}
