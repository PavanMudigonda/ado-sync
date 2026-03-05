/**
 * Shared types for azure-test-sync
 */

// ─── Config ──────────────────────────────────────────────────────────────────

export type AuthType = 'pat' | 'accessToken' | 'managedIdentity';

export interface LinkConfig {
  /** Tag prefix to match, e.g. 'story', 'bug' */
  prefix: string;
  /** ADO relation type. Default: 'System.LinkTypes.Related' */
  relationship?: string;
  /** Optional: restrict to a specific work item type */
  workItemType?: string;
}

export interface TestPlanEntry {
  id: number;
  suiteId?: number;
  /** 'flat' (default) or 'byFolder' to mirror folder structure as nested suites */
  suiteMapping?: 'flat' | 'byFolder';
  /** Override local.include for this plan */
  include?: string | string[];
  /** Override local.exclude for this plan */
  exclude?: string | string[];
}

export interface SyncConfig {
  /** Azure DevOps organisation URL, e.g. https://dev.azure.com/myorg */
  orgUrl: string;
  /** Azure DevOps project name */
  project: string;
  /** Authentication */
  auth: {
    type: AuthType;
    /** Personal Access Token (or env var name prefixed with $) */
    token?: string;
    /** Required when type === 'managedIdentity' */
    applicationIdURI?: string;
  };
  /** Target test plan / suite (single-plan mode) */
  testPlan: {
    id: number;
    /** Root suite to create new test cases under. Defaults to plan root suite. */
    suiteId?: number;
    /** 'flat' (default) or 'byFolder' to mirror folder structure as nested suites */
    suiteMapping?: 'flat' | 'byFolder';
  };
  /** Multi-plan mode: if present, overrides testPlan for each entry */
  testPlans?: TestPlanEntry[];
  /** Local spec sources */
  local: {
    /** 'gherkin' for .feature files, 'markdown' for .md spec files */
    type: 'gherkin' | 'markdown' | 'csv' | 'excel';
    /** Glob pattern(s) relative to config file location */
    include: string | string[];
    /** Glob pattern(s) to exclude */
    exclude?: string | string[];
  };
  /** Sync behaviour */
  sync?: {
    /** Prefix used in tags/comments to store the Azure test case ID. Default: 'tc' */
    tagPrefix?: string;
    /** Field name in Azure used as test title. Default: 'System.Title' */
    titleField?: string;
    /** Default area path for new test cases */
    areaPath?: string;
    /** Default iteration path for new test cases */
    iterationPath?: string;
    /**
     * When true, no local files are modified (no ID writeback, no pull apply).
     * Useful for CI pipelines that should not commit file changes.
     */
    disableLocalChanges?: boolean;
    /**
     * How to handle conflicts (remote changed since last sync AND local also differs).
     * 'overwrite' (default): push local version to Azure.
     * 'skip': emit a conflict result and leave both sides unchanged.
     * 'fail': throw an error listing all conflicts.
     */
    conflictAction?: 'overwrite' | 'skip' | 'fail';
    /**
     * When true, marks every pushed test case as Automated by setting
     * Microsoft.VSTS.TCM.AutomationStatus = 'Automated' plus the related
     * AutomatedTestName / AutomatedTestStorage / AutomatedTestId / AutomatedTestType fields.
     * The AutomatedTestName is derived from the file basename + scenario title.
     * Default: false.
     */
    markAutomated?: boolean;
    /**
     * Work item link configurations. Tags matching a configured prefix
     * (e.g. @story:123) will create/maintain ADO work item relations.
     */
    links?: LinkConfig[];
  };
}

// ─── Parsed local test ───────────────────────────────────────────────────────

export interface ParsedStep {
  keyword: string; // Given / When / Then / And / But / *
  text: string;
  expected?: string; // Used by markdown steps that have an expected result inline
}

export interface ParsedTest {
  /** Absolute path to the local file */
  filePath: string;
  /** Title of the test (Scenario title / Markdown heading) */
  title: string;
  /** Optional description / background text */
  description?: string;
  /** Steps */
  steps: ParsedStep[];
  /** Tags collected from the file (Gherkin tags or markdown metadata) */
  tags: string[];
  /** Azure DevOps Test Case ID if already synced, otherwise undefined */
  azureId?: number;
  /** Line number in the file where the scenario / heading starts (1-based) */
  line: number;
  /**
   * Present for Scenario Outlines. Contains the examples table so Azure can
   * create a parametrized test case instead of one TC per example row.
   */
  outlineParameters?: {
    headers: string[];
    rows: string[][];
  };
  /**
   * Work item link references extracted from tags matching sync.links config.
   * e.g. @story:123 → { prefix: 'story', id: 123 }
   */
  linkRefs?: Array<{ prefix: string; id: number }>;
}

// ─── Azure Test Case (normalised) ────────────────────────────────────────────

export interface AzureTestCase {
  id: number;
  title: string;
  description?: string;
  steps: AzureStep[];
  tags: string[];
  /** ISO timestamp of last change in Azure */
  changedDate?: string;
  areaPath?: string;
  iterationPath?: string;
}

export interface AzureStep {
  action: string;
  expected: string;
}

// ─── Sync result ─────────────────────────────────────────────────────────────

export type SyncAction = 'created' | 'updated' | 'skipped' | 'conflict' | 'pulled' | 'removed' | 'error';

export interface SyncResult {
  action: SyncAction;
  filePath: string;
  title: string;
  azureId?: number;
  detail?: string;
}
