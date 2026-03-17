/**
 * Trend analysis over historical ADO test runs.
 *
 * Queries the Azure DevOps Test API for past runs, aggregates pass/fail counts
 * per Test Case, and flags flaky tests (tests that both passed and failed
 * across recent runs).
 *
 * Also supports posting a Markdown summary to a Slack incoming webhook,
 * Microsoft Teams webhook, or a generic HTTP endpoint.
 */

import * as https from 'https';
import * as url from 'url';

import { SyncConfig } from '../types';
import { AzureClient } from './client';

// ─── Public types ──────────────────────────────────────────────────────────────

export interface TestCaseTrend {
  testCaseId?: number;
  testName: string;
  /** Total executions across all sampled runs */
  totalRuns: number;
  passed: number;
  failed: number;
  /** Percentage of runs that passed (0–100) */
  passRate: number;
  /** True when the test both passed and failed across the sampled runs */
  isFlaky: boolean;
  /** The most recent outcome */
  lastOutcome: 'Passed' | 'Failed' | 'Inconclusive' | 'NotExecuted' | string;
}

export interface TrendReport {
  /** Period covered (ISO dates) */
  fromDate: string;
  toDate: string;
  /** Number of test runs sampled */
  runsAnalyzed: number;
  totalResults: number;
  totalPassed: number;
  totalFailed: number;
  /** Overall pass rate across all results */
  overallPassRate: number;
  /** Tests that both passed and failed */
  flakyTests: TestCaseTrend[];
  /** Top N most-failing tests */
  topFailingTests: TestCaseTrend[];
  allTests: TestCaseTrend[];
}

export interface TrendOpts {
  /** Look back this many days (default: 30) */
  days?: number;
  /** Maximum runs to sample (default: 50) */
  maxRuns?: number;
  /** How many top-failing tests to surface (default: 10) */
  topN?: number;
  /** Only consider runs whose name contains this string */
  runNameFilter?: string;
}

// ─── Main entry point ──────────────────────────────────────────────────────────

export async function trendReport(
  config: SyncConfig,
  opts: TrendOpts = {},
): Promise<TrendReport> {
  const days    = opts.days    ?? 30;
  const maxRuns = opts.maxRuns ?? 50;
  const topN    = opts.topN    ?? 10;

  const toDate   = new Date();
  const fromDate = new Date(toDate.getTime() - days * 24 * 60 * 60 * 1000);

  const client  = await AzureClient.create(config);
  const testApi = await client.getTestApi();

  // Fetch runs in the date window — ADO returns newest-first
  const runs: any[] = (await (testApi as any).getTestRuns(config.project, undefined, undefined, undefined, undefined, undefined, undefined, fromDate.toISOString(), toDate.toISOString()) ?? []);

  const filtered = runs
    .filter((r: any) => !opts.runNameFilter || (r.name ?? '').includes(opts.runNameFilter))
    .slice(0, maxRuns);

  // Aggregate per test name
  const byTest = new Map<string, { tcId?: number; passes: number; fails: number; outcomes: string[] }>();

  for (const run of filtered) {
    const runId = run.id as number;
    let skip = 0;
    const PAGE = 1000;

    while (true) {
      const batch: any[] = (await (testApi as any).getTestResults(config.project, runId, undefined, skip, PAGE) ?? []);
      if (!batch.length) break;

      for (const r of batch) {
        const name = r.testCaseTitle ?? r.automatedTestName ?? 'Unknown';
        if (!byTest.has(name)) byTest.set(name, { tcId: r.testCase?.id ? parseInt(r.testCase.id, 10) : undefined, passes: 0, fails: 0, outcomes: [] });
        const entry = byTest.get(name)!;
        const outcome: string = r.outcome ?? 'NotExecuted';
        entry.outcomes.push(outcome);
        if (outcome === 'Passed') entry.passes++;
        else if (outcome === 'Failed') entry.fails++;
      }

      if (batch.length < PAGE) break;
      skip += PAGE;
    }
  }

  const allTests: TestCaseTrend[] = [];
  for (const [name, data] of byTest) {
    const total    = data.passes + data.fails + (data.outcomes.length - data.passes - data.fails);
    const passRate = total > 0 ? Math.round((data.passes / total) * 100) : 100;
    const isFlaky  = data.passes > 0 && data.fails > 0;
    const lastOutcome = data.outcomes[data.outcomes.length - 1] ?? 'NotExecuted';
    allTests.push({
      testName: name,
      testCaseId: data.tcId,
      totalRuns: total,
      passed: data.passes,
      failed: data.fails,
      passRate,
      isFlaky,
      lastOutcome,
    });
  }

  const flakyTests      = allTests.filter((t) => t.isFlaky).sort((a, b) => a.passRate - b.passRate);
  const topFailingTests = [...allTests].sort((a, b) => b.failed - a.failed).filter((t) => t.failed > 0).slice(0, topN);

  const totalResults = allTests.reduce((s, t) => s + t.totalRuns, 0);
  const totalPassed  = allTests.reduce((s, t) => s + t.passed,    0);
  const totalFailed  = allTests.reduce((s, t) => s + t.failed,    0);
  const overallPassRate = totalResults > 0 ? Math.round((totalPassed / totalResults) * 100) : 100;

  return {
    fromDate: fromDate.toISOString().split('T')[0],
    toDate:   toDate.toISOString().split('T')[0],
    runsAnalyzed: filtered.length,
    totalResults,
    totalPassed,
    totalFailed,
    overallPassRate,
    flakyTests,
    topFailingTests,
    allTests,
  };
}

// ─── Webhook posting ───────────────────────────────────────────────────────────

export interface WebhookPayload {
  /** 'slack' wraps in Slack blocks, 'teams' in AdaptiveCard, 'generic' sends raw JSON */
  type: 'slack' | 'teams' | 'generic';
  webhookUrl: string;
}

export async function postTrendToWebhook(report: TrendReport, webhook: WebhookPayload): Promise<void> {
  let body: string;

  if (webhook.type === 'slack') {
    body = buildSlackPayload(report);
  } else if (webhook.type === 'teams') {
    body = buildTeamsPayload(report);
  } else {
    body = JSON.stringify(report);
  }

  await httpPost(webhook.webhookUrl, body);
}

// ─── Markdown summary ─────────────────────────────────────────────────────────

export function buildMarkdownSummary(report: TrendReport): string {
  const passIcon = report.overallPassRate >= 90 ? '✅' : report.overallPassRate >= 70 ? '⚠️' : '❌';
  const lines: string[] = [
    `## ${passIcon} Test Trend Report — ${report.fromDate} → ${report.toDate}`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Runs analysed | ${report.runsAnalyzed} |`,
    `| Total results | ${report.totalResults} |`,
    `| Overall pass rate | **${report.overallPassRate}%** |`,
    `| Total passed | ${report.totalPassed} |`,
    `| Total failed | ${report.totalFailed} |`,
    `| Flaky tests | ${report.flakyTests.length} |`,
    '',
  ];

  if (report.flakyTests.length > 0) {
    lines.push('### 🔀 Flaky Tests (passed AND failed in the period)');
    lines.push('');
    lines.push('| Test | Pass rate | Passes | Fails |');
    lines.push('|------|-----------|--------|-------|');
    for (const t of report.flakyTests.slice(0, 15)) {
      const idStr = t.testCaseId ? `[#${t.testCaseId}] ` : '';
      lines.push(`| ${idStr}${t.testName.slice(0, 60)} | ${t.passRate}% | ${t.passed} | ${t.failed} |`);
    }
    if (report.flakyTests.length > 15) lines.push(`| _…and ${report.flakyTests.length - 15} more_ | | | |`);
    lines.push('');
  }

  if (report.topFailingTests.length > 0) {
    lines.push('### ❌ Top Failing Tests');
    lines.push('');
    lines.push('| Test | Failures | Pass rate |');
    lines.push('|------|----------|-----------|');
    for (const t of report.topFailingTests) {
      const idStr = t.testCaseId ? `[#${t.testCaseId}] ` : '';
      lines.push(`| ${idStr}${t.testName.slice(0, 60)} | ${t.failed} | ${t.passRate}% |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('_Generated by [ado-sync](https://github.com/PavanMudigonda/ado-sync)_');
  return lines.join('\n');
}

// ─── Slack payload ────────────────────────────────────────────────────────────

function buildSlackPayload(report: TrendReport): string {
  const passIcon = report.overallPassRate >= 90 ? ':white_check_mark:' : report.overallPassRate >= 70 ? ':warning:' : ':x:';
  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${passIcon} Test Trend — ${report.fromDate} to ${report.toDate}` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Runs analysed*\n${report.runsAnalyzed}` },
        { type: 'mrkdwn', text: `*Overall pass rate*\n${report.overallPassRate}%` },
        { type: 'mrkdwn', text: `*Passed*\n${report.totalPassed}` },
        { type: 'mrkdwn', text: `*Failed*\n${report.totalFailed}` },
        { type: 'mrkdwn', text: `*Flaky tests*\n${report.flakyTests.length}` },
      ],
    },
  ];

  if (report.flakyTests.length > 0) {
    const flakyText = report.flakyTests.slice(0, 5)
      .map((t) => `• ${t.testName.slice(0, 60)}  (${t.passRate}% pass rate)`)
      .join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*:twisted_rightwards_arrows: Top flaky tests*\n${flakyText}${report.flakyTests.length > 5 ? `\n_…and ${report.flakyTests.length - 5} more_` : ''}` },
    });
  }

  if (report.topFailingTests.length > 0) {
    const failText = report.topFailingTests.slice(0, 5)
      .map((t) => `• ${t.testName.slice(0, 60)}  (${t.failed} failures)`)
      .join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*:x: Top failing tests*\n${failText}` },
    });
  }

  return JSON.stringify({ blocks });
}

// ─── Teams payload ─────────────────────────────────────────────────────────────

function buildTeamsPayload(report: TrendReport): string {
  const passIcon = report.overallPassRate >= 90 ? '✅' : report.overallPassRate >= 70 ? '⚠️' : '❌';
  const card = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          {
            type: 'TextBlock',
            size: 'Large',
            weight: 'Bolder',
            text: `${passIcon} Test Trend — ${report.fromDate} to ${report.toDate}`,
          },
          {
            type: 'FactSet',
            facts: [
              { title: 'Runs analysed',     value: String(report.runsAnalyzed) },
              { title: 'Overall pass rate', value: `${report.overallPassRate}%` },
              { title: 'Passed',            value: String(report.totalPassed) },
              { title: 'Failed',            value: String(report.totalFailed) },
              { title: 'Flaky tests',       value: String(report.flakyTests.length) },
            ],
          },
          ...(report.topFailingTests.length > 0 ? [{
            type: 'TextBlock',
            text: '**Top Failing Tests**',
            wrap: true,
          }, {
            type: 'TextBlock',
            text: report.topFailingTests.slice(0, 5).map((t) => `- ${t.testName.slice(0, 70)} (${t.failed} failures)`).join('\n'),
            wrap: true,
          }] : []),
        ],
      },
    }],
  };
  return JSON.stringify(card);
}

// ─── HTTP helper ───────────────────────────────────────────────────────────────

function httpPost(webhookUrl: string, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(webhookUrl);
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      if ((res.statusCode ?? 200) >= 400) {
        reject(new Error(`Webhook returned HTTP ${res.statusCode}`));
      } else {
        res.resume();
        resolve();
      }
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
