/**
 * Shared types for azure-test-sync
 */

// ─── Config ──────────────────────────────────────────────────────────────────

export type AuthType = 'pat' | 'accessToken' | 'managedIdentity';

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
  /** Target test plan / suite */
  testPlan: {
    id: number;
    /** Root suite to create new test cases under. Defaults to plan root suite. */
    suiteId?: number;
  };
  /** Local spec sources */
  local: {
    /** 'gherkin' for .feature files, 'markdown' for .md spec files */
    type: 'gherkin' | 'markdown';
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

export type SyncAction = 'created' | 'updated' | 'skipped' | 'conflict' | 'pulled' | 'error';

export interface SyncResult {
  action: SyncAction;
  filePath: string;
  title: string;
  azureId?: number;
  detail?: string;
}
