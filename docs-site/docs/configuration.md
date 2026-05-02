# Configuration reference

Config files can be JSON (`.json`) or YAML (`.yml` / `.yaml`). Run `ado-sync init` to generate a template.

---

## Full example (JSON)

```json
{
  "orgUrl": "https://dev.azure.com/YOUR_ORG",
  "project": "YOUR_PROJECT",
  "configurationKey": "my-repo-smoke",
  "syncTarget": {
    "mode": "tagged"
  },

  "auth": {
    "type": "pat",
    "token": "$AZURE_DEVOPS_TOKEN"
  },

  "testPlan": {
    "id": 1234,
    "suiteId": 5678,
    "hierarchy": {
      "mode": "byFolder",
      "rootSuite": "Generated Specs",
      "cleanupEmptySuites": true
    },
    "suiteRouting": [
      { "tags": "@smoke", "suite": "Smoke" },
      { "tags": "@regression", "suite": "Regression" },
      { "suite": "General" }
    ]
  },

  "local": {
    "type": "gherkin",
    "include": "specs/**/*.feature",
    "exclude": [],
    "condition": "@done and not @wip"
  },

  "toolSettings": {
    "parentConfig": "../base-ado-sync.json",
    "outputLevel": "normal"
  },

  "sync": {
    "tagPrefix": "tc",
    "titleField": "System.Title",
    "areaPath": "MyProject\\Team A",
    "iterationPath": "MyProject\\Sprint 1",
    "disableLocalChanges": false,
    "conflictAction": "overwrite",
    "links": [
      { "prefix": "story", "relationship": "System.LinkTypes.Related" },
      { "prefix": "bug",   "relationship": "System.LinkTypes.Related" }
    ],
    "state": {
      "setValueOnChangeTo": "Design",
      "condition": "@active"
    },
    "fieldUpdates": {
      "System.AreaPath": {
        "conditionalValue": {
          "@smoke": "MyProject\\Smoke",
          "otherwise": "MyProject\\Regression"
        }
      },
      "Custom.Priority": {
        "condition": "@priority:*",
        "value": "{1}",
        "update": "onCreate"
      }
    },
    "format": {
      "prefixTitle": true,
      "prefixBackgroundSteps": true,
      "useExpectedResult": false,
      "syncDataTableAsText": false,
      "showParameterListStep": "whenUnusedParameters"
    },
    "attachments": {
      "enabled": true,
      "tagPrefixes": ["wireframe", "spec"],
      "baseFolder": "specs/attachments"
    },
    "pull": {
      "enableCreatingNewLocalTestCases": false,
      "targetFolder": "specs/pulled"
    },
    "ai": {
      "provider": "heuristic",
      "contextFile": "./docs/ai-context.md",
      "writebackDocComment": false
    }
  },

  "customizations": {
    "fieldDefaults": {
      "enabled": true,
      "defaultValues": {
        "System.State": "Design",
        "Custom.AutomationStatus": "Planned"
      }
    },
    "ignoreTestCaseTags": {
      "enabled": true,
      "tags": ["reviewed", "ado-*"]
    },
    "tagTextMapTransformation": {
      "enabled": true,
      "textMap": { "_": " " }
    }
  }
}
```

---

## Top-level fields

### `orgUrl`

Azure DevOps organisation URL. Format: `https://dev.azure.com/YOUR_ORG`.

---

### `project`

Azure DevOps project name.

---

### `configurationKey`

*(Optional)* A unique string identifying this config within the ADO project. Used to prevent conflicts when multiple ado-sync configs push into the same Test Plan (e.g. `"smoke-suite"`, `"regression-suite"`). When set, ID writeback tags are namespaced so that one config's tags don't collide with another's.

When `syncTarget.mode` is `tagged`, `configurationKey` also provides the default ownership tag. For example, `"Smoke Suite"` becomes the Azure tag `ado-sync-owner:smoke_suite` unless you override it with `syncTarget.tag`.

---

### `syncTarget`

*(Optional)* Defines which remote Azure DevOps test cases this config owns. If omitted, ado-sync keeps the existing suite-scoped behavior.

| Field | Default | Description |
|-------|---------|-------------|
| `mode` | `"suite"` | Ownership mode: `"suite"` · `"tagged"` · `"query"` |
| `suiteId` | `testPlan.suiteId` or plan root | Optional explicit suite scope for `"suite"` and `"tagged"` modes. |
| `tag` | derived from `configurationKey` | Optional explicit Azure tag for `"tagged"` mode. |
| `wiql` | *(required for `"query"`)* | WIQL query used to select owned remote test cases. |

#### `syncTarget.mode: "suite"`

Uses the configured suite or plan root as the remote ownership boundary. This matches ado-sync's historical behavior.

```json
{
  "syncTarget": {
    "mode": "suite",
    "suiteId": 5678
  }
}
```

#### `syncTarget.mode: "tagged"`

Scopes remote enumeration to test cases carrying an ownership tag. On create and update, ado-sync ensures that ownership tag is present on the Azure test case.

```json
{
  "configurationKey": "my-repo-smoke",
  "syncTarget": {
    "mode": "tagged"
  }
}
```

With the config above, ado-sync derives the Azure tag `ado-sync-owner:my_repo_smoke` automatically.

To use an explicit Azure tag instead of the derived one:

```json
{
  "syncTarget": {
    "mode": "tagged",
    "tag": "ado-sync-owner:shared-smoke"
  }
}
```

`tagged` mode requires either `configurationKey` or `syncTarget.tag`.

#### `syncTarget.mode: "query"`

Scopes remote enumeration to the work items returned by a WIQL query. Only Azure DevOps `Test Case` work items returned by the query are considered.

```json
{
  "syncTarget": {
    "mode": "query",
    "wiql": "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'Test Case' AND [System.AreaPath] UNDER 'MyProject\\Smoke'"
  }
}
```

When used with `testPlans`, the same query ownership scope is applied independently to each effective per-plan sync run.

---

### `auth`

| Field | Description |
|-------|-------------|
| `type` | `"pat"` · `"accessToken"` · `"managedIdentity"` |
| `token` | PAT or access token value. Prefix with `$` to read from an environment variable (e.g. `"$AZURE_DEVOPS_TOKEN"`). |
| `applicationIdURI` | Required only when `type` is `"managedIdentity"`. |

**PAT permissions required:** Test Management (Read & Write), Work Items (Read & Write).

---

### `testPlan`

| Field | Default | Description |
|-------|---------|-------------|
| `id` | *(required)* | ID of the Azure DevOps Test Plan. |
| `suiteId` | plan root | ID of the Test Suite within the plan. Defaults to the plan's root suite. |
| `hierarchy` | *(none)* | Declarative hierarchy generation for this plan. `{"mode":"byFolder"}` mirrors folders. `{"mode":"byFile"}` mirrors folders and adds a suite per spec file. `{"mode":"byTag","tagPrefix":"suite"}` uses the first matching tag value like `@suite:mobile/auth` as the generated suite path. `{"mode":"byLevels","levels":[{"source":"folder","index":0},{"source":"tag","tagPrefix":"suite"}]}` builds the path from explicit folder/file/tag rules. Optional `rootSuite` anchors the generated tree under a named child suite. Optional `cleanupEmptySuites: true` prunes empty generated suites left behind by hierarchy-managed moves and safe full-scope stale-branch cleanup. |
| `suiteMapping` | `"flat"` | `"flat"` — all TCs go into one suite. `"byFolder"` — folder hierarchy mirrored as nested child suites. `"byFile"` — each spec file gets its own child suite named after the file. |
| `suiteRouting` | *(none)* | Tag-condition-based primary suite routing. Routes are evaluated in order; first match wins. See [Multi-suite routing](advanced.md#multi-suite-routing). |

`testPlan.hierarchy` is the preferred form for generated suite trees. `suiteMapping` remains supported as a compatibility shortcut for the legacy flat, folder, and file modes.

---

### `testPlans` (multi-plan)

Use `testPlans` instead of `testPlan` to sync one repo against multiple Test Plans in a single config.

```json
{
  "testPlans": [
    {
      "id": 1001,
      "suiteId": 2001,
      "include": "specs/smoke/**/*.feature",
      "hierarchy": { "mode": "byFolder", "rootSuite": "Smoke Specs", "cleanupEmptySuites": true },
      "suiteRouting": [
        { "tags": "@critical", "suite": "Critical" },
        { "suite": "Smoke" }
      ]
    },
    { "id": 1002, "suiteId": 2002, "include": "specs/regression/**/*.feature", "suiteMapping": "byFile" }
  ]
}
```

| Field | Description |
|-------|-------------|
| `id` | Test Plan ID |
| `suiteId` | *(Optional)* Target suite ID |
| `hierarchy` | *(Optional)* Declarative hierarchy generation for this plan entry. Overrides base `testPlan.hierarchy`. Supports `byFolder`, `byFile`, `byTag`, and `byLevels`, plus `cleanupEmptySuites` for opt-in pruning of empty generated suites. |
| `suiteMapping` | *(Optional)* `"flat"`, `"byFolder"`, or `"byFile"` |
| `include` | *(Optional)* Override `local.include` for this plan |
| `exclude` | *(Optional)* Override `local.exclude` for this plan |
| `suiteRouting` | *(Optional)* Per-plan tag-based primary suite routing (overrides base `testPlan.suiteRouting`) |
| `suiteConditions` | *(Optional)* Per-plan additive suite conditions (overrides base `sync.suiteConditions`) |

---

### `local`

| Field | Default | Description |
|-------|---------|-------------|
| `type` | *(required)* | `"gherkin"` · `"markdown"` · `"csv"` · `"excel"` · `"csharp"` · `"java"` · `"python"` · `"javascript"` · `"playwright"` · `"robot"` |
| `include` | *(required)* | Glob pattern(s) relative to the config file. String or array. |
| `exclude` | *(none)* | Glob pattern(s) to exclude. String or array. |
| `condition` | *(none)* | Tag expression filter applied before `--tags`. Only scenarios matching this expression are included in sync. e.g. `"@done and not (@ignored or @planned)"` |

---

### `toolSettings`

| Field | Default | Description |
|-------|---------|-------------|
| `parentConfig` | *(none)* | Relative path to a parent config file. Child values override parent values (deep merge). Circular references are detected and rejected. |
| `ignoreParentConfig` | `false` | When `true`, the `parentConfig` reference is ignored. Useful to opt a child config out of inheritance temporarily. |
| `outputLevel` | `"normal"` | `"normal"` — show all results per-line. `"quiet"` — suppress `skipped` lines, show only actionable results. `"verbose"` — show extra suite-preview lines. `"diagnostic"` — show richer troubleshooting detail across push, pull, status, validate, stale, coverage, trend, ac-gate, and publish-test-results, including changed fields, suite previews, resolved publish inputs, validate context, stale-detection scope, coverage inputs, trend controls, and AC-gate scope. |

---

### `sync`

| Field | Default | Description |
|-------|---------|-------------|
| `tagPrefix` | `"tc"` | Prefix used in ID tags (`@tc:12345`). |
| `titleField` | `"System.Title"` | Azure DevOps field used as the test case title. |
| `areaPath` | *(none)* | Area path for newly created Test Cases. |
| `iterationPath` | *(none)* | Iteration path for newly created Test Cases. |
| `disableLocalChanges` | `false` | When `true`, no local files are modified (no ID writeback, no pull apply). Use in CI. |
| `conflictAction` | `"overwrite"` | `"overwrite"` · `"skip"` · `"fail"` — see [Conflict detection](advanced.md#conflict-detection). |
| `links` | `[]` | Work item link configs — see [Work item linking](spec-formats.md#work-item-linking). |
| `state` | *(none)* | Set TC State field on change — see [State configuration](advanced.md#state-configuration). |
| `fieldUpdates` | *(none)* | Custom field update rules — see [Field updates](advanced.md#field-updates). |
| `format` | *(none)* | TC content formatting options — see [Format configuration](advanced.md#format-configuration). |
| `attachments` | *(none)* | File attachment sync — see [Attachments](advanced.md#attachments). |
| `pull` | *(none)* | Pull-specific options — see [Pull configuration](advanced.md#pull-configuration). |
| `suiteConditions` | *(none)* | Per-tag additive suite routing rules. |
| `ai` | *(none)* | AI provider config for auto-summarization, generate context, and failure analysis — see [AI auto-summary](advanced.md#ai-auto-summary-for-code-tests). Fields: `provider`, `model`, `baseUrl`, `apiKey`, `contextFile`, `analyzeFailures`, `writebackDocComment`. |

---

### `customizations`

Controls tag transformations applied before push. See [Customizations](advanced.md#customizations).

| Field | Description |
|-------|-------------|
| `fieldDefaults` | Default field values applied only on create. |
| `ignoreTestCaseTags` | Preserve certain Azure-side tags from being removed on push. |
| `tagTextMapTransformation` | Character/substring replacements applied to tags before push. |

---

### `publishTestResults`

Configuration for the `publish-test-results` command. See [Publishing test results](publish-test-results.md#configuration).

---

## YAML example

```yaml
orgUrl: https://dev.azure.com/my-org
project: MyProject
configurationKey: my-repo-smoke

syncTarget:
  mode: tagged

auth:
  type: pat
  token: $AZURE_DEVOPS_TOKEN

testPlan:
  id: 1234
  suiteId: 5678
  suiteMapping: byFolder
  suiteRouting:
    - tags: "@smoke"
      suite: Smoke
    - suite: General

local:
  type: gherkin
  include: specs/**/*.feature
  exclude:
    - specs/archive/**
  condition: "@done and not @wip"

toolSettings:
  outputLevel: quiet

sync:
  tagPrefix: tc
  areaPath: "MyProject\\QA Team"
  conflictAction: skip
  links:
    - prefix: story
      relationship: System.LinkTypes.Related
  format:
    prefixTitle: true
    useExpectedResult: false
  ai:
    provider: heuristic
    # contextFile: ./docs/ai-context.md
```

---

## Hierarchical config

Use `toolSettings.parentConfig` to share common settings across multiple config files.

```
repo/
  ado-sync-base.json       ← org, project, auth, shared sync settings
  smoke/
    ado-sync.json          ← testPlan.id: 1001, local.include: specs/smoke/**
  regression/
    ado-sync.json          ← testPlan.id: 1002, local.include: specs/regression/**
```

Child config:
```json
{
  "toolSettings": { "parentConfig": "../ado-sync-base.json" },
  "testPlan": { "id": 1002, "suiteId": 3001 },
  "local": { "type": "gherkin", "include": "specs/regression/**/*.feature" }
}
```

Child values override parent values using a deep merge (arrays are replaced, not concatenated). Circular references are detected and throw an error.

Set `toolSettings.ignoreParentConfig: true` in any child to opt out of inheritance for that config without editing the parent.

---

## JSONC support

Config files can use the `.jsonc` extension (or plain `.json`) with JavaScript-style comments and trailing commas:

```jsonc
{
  // Organization settings
  "orgUrl": "https://dev.azure.com/myorg",
  "project": "MyProject",
  "auth": {
    "type": "pat",
    "token": "$ADO_PAT", // expanded from environment
  }
}
```

Auto-detected config filenames: `ado-sync.json`, `ado-sync.jsonc`, `ado-sync.yml`, `ado-sync.yaml`.

---

## Personal config overlays

Place a `.ado-sync.local.json` (or `.local.jsonc`, `.local.yml`, `.local.yaml`) file next to your main config to override values without modifying the shared file. This overlay is deep-merged on top of the resolved config.

```
repo/
  ado-sync.json              ← shared, committed
  .ado-sync.local.json       ← personal (add to .gitignore)
```

Example overlay:
```json
{
  "auth": { "token": "$MY_PERSONAL_PAT" }
}
```

---

## Remote profiles (extends)

Reference a shared profile from `~/.config/ado-sync/profiles/` to inherit org-level connection settings:

```json
{
  "extends": "acme-corp",
  "testPlan": { "id": 1234 },
  "local": { "type": "gherkin", "include": "specs/**/*.feature" }
}
```

Profile file at `~/.config/ado-sync/profiles/acme-corp.json`:
```json
{
  "orgUrl": "https://dev.azure.com/acme",
  "project": "Engineering",
  "auth": { "type": "pat", "token": "$ADO_PAT" }
}
```

Profile values serve as the lowest-priority base layer (profile < parent < child < overlay < env vars < CLI flags).

---

## Staleness policies

Configure per-plan staleness policies to automatically detect and limit pruning of stale test case memberships:

```jsonc
{
  "testPlans": [{
    "id": 1234,
    "hierarchy": { "mode": "byFolder" },
    "stalenessPolicy": {
      "maxAge": "30d",
      "pruneBranches": ["merged", "deleted"],
      "maxPruneCount": 50
    }
  }]
}
```

| Field | Description |
|-------|-------------|
| `maxAge` | Duration (e.g. `30d`, `24h`, `7w`) after which unsynced TCs are considered stale |
| `pruneBranches` | Branch states to consider for pruning |
| `maxPruneCount` | Safety cap — if more TCs would be pruned, abort with an error |

---

## Automation classification rules

Replace the blanket `sync.markAutomated` toggle with fine-grained rules:

```jsonc
{
  "publishTestResults": {
    "automationRules": [
      { "match": { "tags": ["@manual", "@exploratory"] }, "classification": "manual" },
      { "match": { "path": "tests/regression/**" }, "classification": "automated", "destinations": ["Regression Suite", "Nightly Suite"] },
      { "match": { "default": true }, "classification": "automated" }
    ]
  }
}
```

Rules are evaluated top-to-bottom; first match wins.

---

## Multi-destination publishing

Route test results to multiple suites simultaneously:

```jsonc
{
  "publishTestResults": {
    "destinations": [
      { "suite": "Regression Suite", "testPlan": 1234 },
      { "suite": "Nightly Suite", "testPlan": 1234 }
    ]
  }
}
```

When `destinations` is set, it takes precedence over the legacy single `testSuite` field.

---

## Extensions

Register extensions for custom parsers, routing policies, or result ingestion:

```jsonc
{
  "extensions": [
    {
      "name": "robot-framework-parser",
      "type": "parser",
      "package": "@acme/ado-sync-robot",
      "filePatterns": ["**/*.robot"]
    },
    {
      "name": "service-catalog-router",
      "type": "routing-policy",
      "package": "@acme/ado-sync-catalog-router"
    }
  ]
}
```

Extension types: `parser`, `routing-policy`, `result-ingestion`, `field-transform`.

Validate with `ado-sync extensions validate`.
