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

export interface SuiteCondition {
  /** Name of the static suite to add matching TCs to (created if absent). */
  suite: string;
  /**
   * Tag expression filter using Gherkin tag syntax (e.g. '@smoke and not @wip').
   * When omitted, all test cases match this condition.
   */
  tags?: string;
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

// ─── State configuration ─────────────────────────────────────────────────────

export interface StateConfig {
  /** Set the TC State field to this value when the scenario has changed. e.g. "Design" */
  setValueOnChangeTo?: string;
  /** Optional tag expression to limit which scenarios trigger the state change. */
  condition?: string;
}

// ─── Field update configuration ──────────────────────────────────────────────

export type FieldUpdateEvent = 'always' | 'onCreate' | 'onChange';

export interface FieldUpdateValue {
  /** The value to set. May contain placeholders like {scenario-name}, {feature-name}. */
  value?: string;
  /** When to apply the update. Default: 'always'. */
  update?: FieldUpdateEvent;
  /** Tag expression condition. Update only when this condition matches. */
  condition?: string;
  /** Whether to remove matching tags from the tags list. Default: true. */
  removeMatchingTags?: boolean;
  /** Switch-style conditional values. Keys are tag expressions, values are field values. */
  conditionalValue?: Record<string, string>;
}

/** Each key is a field name/reference, value is either a simple string or an update specifier. */
export type FieldUpdates = Record<string, string | FieldUpdateValue>;

// ─── Customizations configuration ────────────────────────────────────────────

export interface FieldDefaultsConfig {
  enabled: boolean;
  /** Field reference name → default value. Applied only on create. */
  defaultValues: Record<string, string>;
}

export interface IgnoreTestCaseTagsConfig {
  enabled: boolean;
  /** Tag names or patterns with trailing wildcard. e.g. ["mytag", "ado-tag*"] */
  tags: string[];
}

export interface TagTextMapConfig {
  enabled: boolean;
  /** Character/substring replacements applied to tags before push. e.g. { "_": " " } */
  textMap: Record<string, string>;
}

export interface CustomizationsConfig {
  fieldDefaults?: FieldDefaultsConfig;
  ignoreTestCaseTags?: IgnoreTestCaseTagsConfig;
  tagTextMapTransformation?: TagTextMapConfig;
}

// ─── Format configuration ────────────────────────────────────────────────────

export interface FormatConfig {
  /** When true, Then steps are put in the Expected Result column. Default: false. */
  useExpectedResult?: boolean;
  /** Value to use when a step action is empty. Default: undefined (blank). */
  emptyActionValue?: string;
  /** Value to use when step expected result is empty. Default: undefined (blank). */
  emptyExpectedResultValue?: string;
  /** When true, data tables are synced as plain text instead of sub-steps. Default: false. */
  syncDataTableAsText?: boolean;
  /** When true, background steps get a "Background:" prefix. Default: true. */
  prefixBackgroundSteps?: boolean;
  /** When true, TC title gets "Scenario:" or "Scenario Outline:" prefix. Default: true. */
  prefixTitle?: boolean;
  /** Control parameter list step: 'whenUnusedParameters' | 'always' | 'never'. Default: 'whenUnusedParameters'. */
  showParameterListStep?: 'whenUnusedParameters' | 'always' | 'never';
}

// ─── Attachment configuration ────────────────────────────────────────────────

export interface AttachmentsConfig {
  enabled: boolean;
  /** Additional tag prefixes beyond the default 'attachment'. e.g. ['wireframe','specification'] */
  tagPrefixes?: string[];
  /** Base folder for attached files (relative to config dir). When omitted, relative to feature file. */
  baseFolder?: string;
}

// ─── Pull configuration ──────────────────────────────────────────────────────

export interface PullConfig {
  enabled?: boolean;
  /** When true, pull creates new local test case files for TCs not yet linked. */
  enableCreatingNewLocalTestCases?: boolean;
  /** Folder for newly created local files (relative to config dir). Defaults to '.'. */
  targetFolder?: string;
}

// ─── Publish test results configuration ──────────────────────────────────────

export interface TestResultSource {
  /** Path to test result file (relative to config dir or absolute). */
  value: string;
  /** Format of the result file. e.g. 'trx', 'junit', 'cucumberJson'. */
  format?: string;
}

export interface PublishTestResultsConfig {
  testResult?: {
    sources: TestResultSource[];
  };
  /** Map inconclusive test outcomes to another value (e.g. 'Failed', 'NotExecuted'). */
  treatInconclusiveAs?: string;
  /** How to handle flaky tests. Default: 'lastAttemptOutcome'. */
  flakyTestOutcome?: 'lastAttemptOutcome' | 'firstAttemptOutcome' | 'worstOutcome';
  testConfiguration?: {
    name?: string;
    id?: number;
  };
  testSuite?: {
    name?: string;
    id?: number;
    testPlan?: string;
  };
  testRunSettings?: {
    name?: string;
    comment?: string;
    runType?: 'Automated' | 'Manual';
  };
  testResultSettings?: {
    comment?: string;
  };
  /** Controls which attachments are published for passing tests. */
  publishAttachmentsForPassingTests?: 'none' | 'files' | 'all';
}

// ─── Tool settings configuration ─────────────────────────────────────────────

export interface ToolSettings {
  licensePath?: string;
  disableStats?: boolean;
  outputLevel?: 'normal' | 'verbose' | 'quiet';
  /** Path to a parent config file for hierarchical configuration. */
  parentConfig?: string;
  ignoreParentConfig?: boolean;
}

// ─── Main config ─────────────────────────────────────────────────────────────

export interface SyncConfig {
  /** Azure DevOps organisation URL, e.g. https://dev.azure.com/myorg */
  orgUrl: string;
  /** Azure DevOps project name */
  project: string;
  /** A unique identifier for this config within the ADO project. Prevents multi-config conflicts. */
  configurationKey?: string;
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
    /**
     * Tag expression condition to filter which scenarios are included in sync.
     * e.g. "@done and not (@ignored or @planned)"
     */
    condition?: string;
  };
  /** Tool settings */
  toolSettings?: ToolSettings;
  /** Customizations */
  customizations?: CustomizationsConfig;
  /** Publish test results configuration */
  publishTestResults?: PublishTestResultsConfig;
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
    /**
     * Condition-based suite assignment. Each entry specifies a static suite name
     * and an optional tag filter. Matching test cases are added to that suite after
     * being created or updated. Suites are created automatically if they don't exist.
     *
     * Example:
     *   suiteConditions:
     *     - suite: "Smoke Tests"
     *       tags: "@smoke"
     *     - suite: "All Tests"
     */
    suiteConditions?: SuiteCondition[];
    /** State field configuration: set TC state when scenario changes. */
    state?: StateConfig;
    /** Field update rules applied on push. Keys are field names/references. */
    fieldUpdates?: FieldUpdates;
    /** Format configuration for how test case content is structured. */
    format?: FormatConfig;
    /** Attachment sync configuration: attach files to TCs via tags. */
    attachments?: AttachmentsConfig;
    /** Pull-specific configuration. */
    pull?: PullConfig;
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
  /**
   * Attachment file references extracted from tags matching attachment config.
   * e.g. @attachment:screen.png → { prefix: 'attachment', filePath: 'screen.png' }
   */
  attachmentRefs?: Array<{ prefix: string; filePath: string }>;
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
