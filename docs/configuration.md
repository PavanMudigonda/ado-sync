# Configuration reference

Config files can be JSON (`.json`) or YAML (`.yml` / `.yaml`). Run `ado-sync init` to generate a template.

---

## Full example (JSON)

```json
{
  "orgUrl": "https://dev.azure.com/YOUR_ORG",
  "project": "YOUR_PROJECT",
  "configurationKey": "my-repo-smoke",

  "auth": {
    "type": "pat",
    "token": "$AZURE_DEVOPS_TOKEN"
  },

  "testPlan": {
    "id": 1234,
    "suiteId": 5678,
    "suiteMapping": "flat",
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
      "contextFile": "./docs/ai-context.md"
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
| `suiteMapping` | `"flat"` | `"flat"` — all TCs go into one suite. `"byFolder"` — folder hierarchy mirrored as nested child suites. `"byFile"` — each spec file gets its own child suite named after the file. |
| `suiteRouting` | *(none)* | Tag-condition-based primary suite routing. Routes are evaluated in order; first match wins. See [Multi-suite routing](advanced.md#multi-suite-routing). |

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
| `outputLevel` | `"normal"` | `"normal"` — show all results per-line. `"quiet"` — suppress `skipped` lines, show only actionable results. `"verbose"` — reserved for future detailed output. |

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
| `ai` | *(none)* | AI provider config for auto-summarization and failure analysis — see [AI auto-summary](advanced.md#ai-auto-summary-for-code-tests). Fields: `provider`, `model`, `baseUrl`, `apiKey`, `contextFile`, `analyzeFailures`. |

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
