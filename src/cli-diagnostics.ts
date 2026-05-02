export interface ValidateDiagnostics {
  authType: string;
  localType: string;
  syncTargetMode: string;
  planIds: number[];
  overrideCount: number;
}

export interface DiagnosticItem {
  label: string;
  value: string;
}

export function getValidateDiagnosticItems(details: ValidateDiagnostics): DiagnosticItem[] {
  return [
    { label: 'Auth type', value: details.authType },
    { label: 'Local type', value: details.localType },
    { label: 'Sync target', value: details.syncTargetMode },
    { label: details.planIds.length === 1 ? 'Plan ID' : 'Plan IDs', value: details.planIds.join(', ') },
    { label: 'Overrides', value: String(details.overrideCount) },
  ];
}

export interface StaleDiagnostics {
  syncTargetMode: string;
  planIds: number[];
  markerPrefix: string;
  ownershipTag?: string;
  tagExpression?: string;
  staleCount: number;
  retireState?: string;
  dryRun: boolean;
  overrideCount: number;
}

export function getStaleDiagnosticItems(details: StaleDiagnostics): DiagnosticItem[] {
  return [
    { label: 'Sync target', value: details.syncTargetMode },
    { label: details.planIds.length === 1 ? 'Plan ID' : 'Plan IDs', value: details.planIds.join(', ') },
    { label: 'Marker prefix', value: details.markerPrefix },
    { label: 'Ownership tag', value: details.ownershipTag ?? 'none' },
    { label: 'Tag filter', value: details.tagExpression ?? 'none' },
    { label: 'Stale candidates', value: String(details.staleCount) },
    { label: 'Retire state', value: details.retireState ?? 'disabled' },
    { label: 'Dry run', value: details.dryRun ? 'yes' : 'no' },
    { label: 'Overrides', value: String(details.overrideCount) },
  ];
}

export interface CoverageDiagnostics {
  localType: string;
  syncTargetMode: string;
  tagExpression?: string;
  totalLocalSpecs: number;
  linkedSpecs: number;
  unlinkedSpecs: number;
  storiesReferenced: number;
  storiesCovered: number;
  storyPrefix: string;
  failBelow?: number;
  overrideCount: number;
}

export function getCoverageDiagnosticItems(details: CoverageDiagnostics): DiagnosticItem[] {
  return [
    { label: 'Local type', value: details.localType },
    { label: 'Sync target', value: details.syncTargetMode },
    { label: 'Tag filter', value: details.tagExpression ?? 'none' },
    { label: 'Total specs', value: String(details.totalLocalSpecs) },
    { label: 'Linked specs', value: String(details.linkedSpecs) },
    { label: 'Unlinked specs', value: String(details.unlinkedSpecs) },
    { label: 'Story prefix', value: details.storyPrefix },
    { label: 'Stories referenced', value: String(details.storiesReferenced) },
    { label: 'Stories covered', value: String(details.storiesCovered) },
    { label: 'Fail-below gate', value: details.failBelow === undefined ? 'disabled' : `${details.failBelow}%` },
    { label: 'Overrides', value: String(details.overrideCount) },
  ];
}

export interface TrendDiagnostics {
  days: number;
  maxRuns: number;
  topN: number;
  runNameFilter?: string;
  webhookType?: string;
  failOnFlaky: boolean;
  failBelow?: number;
  runsAnalyzed: number;
  totalResults: number;
  flakyCount: number;
  failingCount: number;
  overrideCount: number;
}

export function getTrendDiagnosticItems(details: TrendDiagnostics): DiagnosticItem[] {
  return [
    { label: 'Days', value: String(details.days) },
    { label: 'Max runs', value: String(details.maxRuns) },
    { label: 'Top-N', value: String(details.topN) },
    { label: 'Run-name filter', value: details.runNameFilter ?? 'none' },
    { label: 'Webhook', value: details.webhookType ?? 'disabled' },
    { label: 'Fail on flaky', value: details.failOnFlaky ? 'yes' : 'no' },
    { label: 'Fail-below gate', value: details.failBelow === undefined ? 'disabled' : `${details.failBelow}%` },
    { label: 'Runs analyzed', value: String(details.runsAnalyzed) },
    { label: 'Results analyzed', value: String(details.totalResults) },
    { label: 'Flaky tests', value: String(details.flakyCount) },
    { label: 'Top failing tests', value: String(details.failingCount) },
    { label: 'Overrides', value: String(details.overrideCount) },
  ];
}

export interface AcGateDiagnostics {
  selectorMode: 'story-ids' | 'query' | 'area-path' | 'default-states';
  selectorValue: string;
  states?: string;
  failMode: 'all-failures' | 'no-ac-only';
  totalStories: number;
  passed: number;
  failed: number;
  noAc: number;
  noTc: number;
  overrideCount: number;
}

export function getAcGateDiagnosticItems(details: AcGateDiagnostics): DiagnosticItem[] {
  return [
    { label: 'Selector mode', value: details.selectorMode },
    { label: 'Selector value', value: details.selectorValue },
    { label: 'States', value: details.states ?? 'n/a' },
    { label: 'Fail mode', value: details.failMode },
    { label: 'Stories selected', value: String(details.totalStories) },
    { label: 'Passed', value: String(details.passed) },
    { label: 'Failed', value: String(details.failed) },
    { label: 'Missing AC', value: String(details.noAc) },
    { label: 'Missing TCs', value: String(details.noTc) },
    { label: 'Overrides', value: String(details.overrideCount) },
  ];
}