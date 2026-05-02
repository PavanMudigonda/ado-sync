# Advanced configuration

---

## Format configuration

`sync.format` controls how test case content is structured when pushed to Azure DevOps.

| Field | Default | Description |
|-------|---------|-------------|
| `prefixTitle` | `true` | Prefix TC title with `"Scenario: "` or `"Scenario Outline: "`. Set `false` to use the raw scenario name. |
| `prefixBackgroundSteps` | `true` | Include Background steps in the TC steps list, prefixed with `"Background: "`. Set `false` to exclude them. |
| `useExpectedResult` | `false` | When `true`, `Then`/`Verify` steps are moved to the Expected Result column instead of the Action column. |
| `syncDataTableAsText` | `false` | When `true`, inline Gherkin data tables are appended to the step action as plain `\| cell \| cell \|` text instead of being handled as sub-steps. |
| `showParameterListStep` | `"whenUnusedParameters"` | Append a `Parameters: @p1@, @p2@, ...` step to parametrized TCs. `"always"` — always append. `"never"` — never append. `"whenUnusedParameters"` — append only when at least one parameter is not already referenced in a step. |
| `emptyActionValue` | *(blank)* | Value to use when a step action would be empty (e.g. when `useExpectedResult` moves a step to the expected column). |
| `emptyExpectedResultValue` | *(blank)* | Value to use when the expected result column would be empty. |

### Example

```json
{
  "sync": {
    "format": {
      "prefixTitle": false,
      "useExpectedResult": true,
      "showParameterListStep": "always",
      "emptyActionValue": "-"
    }
  }
}
```

---

## State configuration

`sync.state` sets the Azure Test Case `State` field whenever a scenario is created or updated.

| Field | Description |
|-------|-------------|
| `setValueOnChangeTo` | The state value to set, e.g. `"Design"`, `"Ready"`. |
| `condition` | *(Optional)* Tag expression. Only scenarios matching this expression trigger the state change. |

```json
{
  "sync": {
    "state": {
      "setValueOnChangeTo": "Design",
      "condition": "@active"
    }
  }
}
```

---

## Field updates

`sync.fieldUpdates` applies custom field values on push. Each key is an Azure DevOps field reference name (e.g. `"System.AreaPath"`) or display name.

### Simple value (always set)

```json
{
  "sync": {
    "fieldUpdates": {
      "Custom.AutomationStatus": "Automated",
      "System.AreaPath": "MyProject\\QA Team"
    }
  }
}
```

### Conditional value (switch by tag)

```json
{
  "sync": {
    "fieldUpdates": {
      "System.AreaPath": {
        "conditionalValue": {
          "@smoke":      "MyProject\\Smoke",
          "@regression": "MyProject\\Regression",
          "otherwise":   "MyProject\\General"
        }
      }
    }
  }
}
```

### Tag wildcard capture

Wildcard `*` captures the matched portion and exposes it as `{1}`, `{2}`, ... in the value.

```json
{
  "sync": {
    "fieldUpdates": {
      "Custom.Priority": {
        "condition": "@priority:*",
        "value": "{1}"
      }
    }
  }
}
```

With tag `@priority:high`, this sets `Custom.Priority` to `"high"`.

### Update event

Control when the update fires:

| `update` | Behaviour |
|----------|-----------|
| `"always"` *(default)* | Apply on every push (create and update). |
| `"onCreate"` | Apply only when the TC is being created for the first time. |
| `"onChange"` | Apply only when the TC already exists and is being updated. |

```json
{
  "sync": {
    "fieldUpdates": {
      "Custom.CreatedBySync": { "value": "true", "update": "onCreate" }
    }
  }
}
```

### Placeholders

Value strings support these placeholders:

| Placeholder | Resolves to |
|-------------|-------------|
| `{scenario-name}` | Scenario title |
| `{feature-name}` | File name without extension |
| `{feature-file}` | File name with extension |
| `{scenario-description}` | Scenario description text |
| `{1}`, `{2}`, … | Wildcard captures from the `condition` |

---

## Customizations

### Field defaults

Set default Azure field values applied only when a Test Case is **created** (not on updates).

```json
{
  "customizations": {
    "fieldDefaults": {
      "enabled": true,
      "defaultValues": {
        "System.State": "Design",
        "Custom.AutomationStatus": "Planned"
      }
    }
  }
}
```

### Ignore test case tags

Preserve Azure-side tags from being removed during push. Useful for tags managed by Azure DevOps workflows (e.g. `reviewed`, `approved`).

```json
{
  "customizations": {
    "ignoreTestCaseTags": {
      "enabled": true,
      "tags": ["reviewed", "ado-*"]
    }
  }
}
```

Patterns support a trailing `*` wildcard: `"ado-*"` matches any tag starting with `ado-`.

### Tag text map transformation

Apply character or substring replacements to tags before they are pushed to Azure DevOps.

```json
{
  "customizations": {
    "tagTextMapTransformation": {
      "enabled": true,
      "textMap": { "_": " " }
    }
  }
}
```

With this config, `@my_feature_tag` is stored in Azure as `my feature tag`.

---

## Attachments

Attach files to Test Cases via tags.

### Config

```json
{
  "sync": {
    "attachments": {
      "enabled": true,
      "tagPrefixes": ["wireframe", "spec"],
      "baseFolder": "specs/attachments"
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Enable attachment sync. |
| `tagPrefixes` | `[]` | Additional tag prefixes beyond the built-in `attachment`. |
| `baseFolder` | *(feature file dir)* | Base directory for resolving file paths. Relative to config file. |

### Usage

```gherkin
  @tc:1042 @attachment:screenshots/login.png @wireframe:mockups/login.fig
  Scenario: Login page
    ...
```

The default `attachment` prefix is always active when `enabled: true`. Additional prefixes are configured via `tagPrefixes`.

File paths support glob patterns: `@attachment:screenshots/*.png` attaches all matching files.

Files are uploaded to the Azure Work Item as attachments. Already-attached files (by name) are not re-uploaded.

---

## Pull configuration

### Pull-create: generate local files from Azure

When `sync.pull.enableCreatingNewLocalTestCases` is `true`, a `pull` run will create new local spec files for Azure Test Cases that have no local counterpart (i.e. they exist in the configured suite but have no `@tc:ID` anywhere in the local files).

```json
{
  "sync": {
    "pull": {
      "enableCreatingNewLocalTestCases": true,
      "targetFolder": "specs/pulled"
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enableCreatingNewLocalTestCases` | `false` | When `true`, `pull` creates local files for unlinked Azure TCs. |
| `targetFolder` | `.` (config dir) | Directory where new files are created. Relative to config file. |

Generated files use the format matching `local.type` (`.feature` for Gherkin, `.md` for Markdown). The `@tc:ID` tag is written into the file so subsequent pushes link back to the same TC.

---

## Suite hierarchy

By default, all Test Cases go into a single flat suite (`suiteMapping: "flat"`). For generated suite trees, prefer `testPlan.hierarchy`; the older `suiteMapping` setting remains available as a compatibility shortcut.

### Declarative hierarchy generation

Use `testPlan.hierarchy` when you want suite generation to read like a real configuration object instead of a single enum toggle.

```json
{
  "testPlan": {
    "id": 1234,
    "suiteId": 5678,
    "hierarchy": {
      "mode": "byFolder",
      "rootSuite": "Generated Specs"
    }
  }
}
```

`mode: "byFolder"` mirrors the relative folder path. `mode: "byFile"` mirrors folders and then adds one more suite named after the spec file. `mode: "byTag"` reads the first matching tag with the configured `tagPrefix` and treats the tag value as the generated suite path. `mode: "byLevels"` builds the path from explicit folder, file, and tag rules. When `rootSuite` is set, ado-sync creates that suite under `suiteId` or the plan root and anchors the generated tree beneath it.

Set `cleanupEmptySuites: true` when you want ado-sync to prune empty generated suites left behind by hierarchy-managed moves or by stale cached branches discovered during a safe full-scope push. This cleanup is opt-in because deleting suites is a stronger action than creating or reusing them.

### `byFolder` — mirror folder structure

```json
{
  "testPlan": {
    "id": 1234,
    "suiteId": 5678,
    "suiteMapping": "byFolder"
  }
}
```

```
specs/
  login/
    basic.feature    → suite "login"    → TC "Successful login"
  checkout/
    happy.feature    → suite "checkout" → TC "Add item and checkout"
```

### `byFile` — one suite per spec file

```json
{
  "testPlan": {
    "id": 1234,
    "suiteId": 5678,
    "suiteMapping": "byFile"
  }
}
```

```
specs/
  login/
    basic.feature    → suite "login / basic"    → TC "Successful login"
  checkout/
    happy.feature    → suite "checkout / happy" → TC "Add item and checkout"
```

With `byFile`, each spec file gets its own dedicated child suite named after the file (without extension). The folder hierarchy is still reflected as parent suites. All Test Cases from the same file land in the same leaf suite.

### `byTag` — derive the generated path from tags

```json
{
  "testPlan": {
    "id": 1234,
    "suiteId": 5678,
    "hierarchy": {
      "mode": "byTag",
      "tagPrefix": "suite",
      "rootSuite": "Generated Specs"
    }
  }
}
```

```
### Login case
@suite:mobile/auth

→ suite "Generated Specs / mobile / auth"
```

`byTag` uses the first tag that matches `tagPrefix:`. The tag value is split on `/` by default, so `@suite:mobile/auth` creates the path `mobile / auth`. Set `valueSeparator` when your tag values use a different delimiter.

### `byLevels` — build the path from explicit rules

```json
{
  "testPlan": {
    "id": 1234,
    "suiteId": 5678,
    "hierarchy": {
      "mode": "byLevels",
      "rootSuite": "Generated Specs",
      "levels": [
        { "source": "folder", "index": 1 },
        { "source": "tag", "tagPrefix": "suite" },
        { "source": "file" }
      ]
    }
  }
}
```

For a file at `specs/auth/login.md` with `<!-- tags: @suite:mobile -->`, the config above produces `Generated Specs / auth / mobile / login`.

Use `folder` rules to pick a specific relative directory segment by zero-based index, `tag` rules to append segments from a tag value, and `file` to append the spec file name without its extension.

Child suites are created automatically if they do not exist. The suite hierarchy is re-used across runs.

When a linked spec file or its hierarchy-driving tag changes to a different generated path, the next `push` adds the Test Case to the new generated suite and removes it from the previous generated suite membership. If `cleanupEmptySuites` is enabled, ado-sync also deletes empty generated suites left behind on the old branch. On safe full-scope runs, the same option also prunes empty stale generated branches recovered from cache entries for specs that are no longer present locally.

---

## Multi-suite routing

`testPlan.suiteRouting` routes each Test Case to a specific child suite based on its tags. This is separate from `suiteMapping` — it assigns a **primary suite** per test based on tag expressions evaluated in order. The first matching route wins.

```json
{
  "testPlan": {
    "id": 1234,
    "suiteId": 5678,
    "suiteRouting": [
      { "tags": "@smoke",      "suite": "Smoke" },
      { "tags": "@regression", "suite": "Regression" },
      { "suite": "General" }
    ]
  }
}
```

A route with no `tags` is a catch-all — it matches every test that didn't match an earlier route.

The `suite` value can be:
- A **string** — the named child suite is auto-created under `suiteId` if it doesn't exist.
- A **number** — the exact suite ID is used directly (must already exist).

If no route matches and no catch-all is defined, the test falls back to `suiteId`.

### Combining routing with multi-plan mode

Each `testPlans` entry can define its own `suiteRouting`, overriding any base routing:

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
    {
      "id": 1002,
      "suiteId": 2002,
      "include": "specs/regression/**/*.feature",
      "suiteMapping": "byFile"
    }
  ]
}
```

---

## Conflict detection

ado-sync uses a local state cache (`.ado-sync-state.json`) to detect conflicts — cases where **both** the local file and the Azure Test Case were changed since the last sync.

The `sync.conflictAction` setting controls what happens:

| Value | Behaviour |
|-------|-----------|
| `"overwrite"` *(default)* | Push local version to Azure, overwriting the remote change. |
| `"skip"` | Emit a `!` conflict result and leave both sides unchanged. |
| `"fail"` | Throw an error listing all conflicting scenarios and abort. |

```json
{ "sync": { "conflictAction": "skip" } }
```

**Commit `.ado-sync-state.json` to version control** so all team members and CI share the same last-synced state.

The cache also speeds up `push` — unchanged scenarios (same local hash + same Azure `changedDate`) are skipped without an API call.

To reset the cache: delete `.ado-sync-state.json`. The next push re-populates it from Azure.

---

## CI / build server mode

Set `sync.disableLocalChanges: true` to prevent ado-sync from writing back to local files:

- `push` — creates and updates Test Cases in Azure, but does **not** write ID tags to local files.
- `pull` — computes what would change but does **not** modify local files (behaves like `--dry-run`).

```json
{ "sync": { "disableLocalChanges": true } }
```

Or per-run via `--config-override`:

```bash
ado-sync push --config-override sync.disableLocalChanges=true
```

### GitHub Actions example

```yaml
- name: Sync test cases to Azure DevOps
  run: ado-sync push --config-override sync.disableLocalChanges=true
  env:
    AZURE_DEVOPS_TOKEN: ${{ secrets.AZURE_DEVOPS_TOKEN }}
```

---

## Removed scenario detection

When a scenario is deleted from a local file but its Test Case still exists in the Azure suite, ado-sync detects this on the next `push` and appends the tag `ado-sync:removed` to the Azure Test Case (without deleting it). A `−` removed line is printed in the output.

To completely remove the Test Case from Azure, delete it manually in Test Plans after reviewing.

---

## Glob-based scope filtering

Use `--include` to restrict operations to files matching a glob pattern relative to the config directory. Unlike `--source-file` (exact paths), `--include` uses glob syntax:

```bash
ado-sync push --include 'src/payments/**'
ado-sync status --include '**/*.feature' --include '**/*.spec.ts'
ado-sync watch --include 'tests/unit/**'
```

Multiple `--include` flags combine with OR logic. When combined with `--source-file`, both filters apply (AND).

---

## Environment variable overrides

ado-sync supports a systematic `ADO_SYNC_*` environment variable convention. Env vars override config file values but are themselves overridden by CLI flags.

Well-known aliases:

| Variable | Config path |
|----------|-------------|
| `ADO_SYNC_PAT` | `auth.token` |
| `ADO_SYNC_ORG` | `orgUrl` |
| `ADO_SYNC_PROJECT` | `project` |
| `ADO_SYNC_TEST_PLAN_ID` | `testPlan.id` |

Generic pattern: any `ADO_SYNC_` prefixed var maps to a nested config path via `__` (dot separator) and lowercasing. Values `"true"`/`"false"` are parsed as booleans; numeric strings become numbers.

```bash
ADO_SYNC_PAT="$TOKEN" ADO_SYNC_ORG="https://dev.azure.com/acme" ado-sync push
```

---

## Config resolution order

Values are resolved in this precedence order (highest wins):

1. CLI flags (`--pat-override`, `--org-override`, `--config-override`)
2. `ADO_SYNC_*` environment variables
3. Personal overlay (`.ado-sync.local.json`)
4. Child config (the file you point to with `-c`)
5. Parent config (`toolSettings.parentConfig`)
6. Remote profile (`"extends": "profile-name"`)

Use `ado-sync config show` to see the final resolved config.

---

## AI auto-summary for code tests

When pushing code-based test types (`java`, `csharp`, `python`, `javascript`, `playwright`), ado-sync reads each test function body and automatically generates a TC **title**, **description**, and numbered **steps**.

**What gets generated and when:**

| Test state | What AI generates |
|------------|------------------|
| No doc comment at all | Title + description + all steps |
| Has doc comment steps but no description | Description only (existing steps kept) |
| Has both steps and a description | Nothing — left unchanged |

Local source files are **never modified** by the AI summary feature — unless `sync.ai.writebackDocComment` is `true` (see [JSDoc writeback](#jsdoc-writeback-syncaiwritebackdoccomment) below).

### JSDoc writeback (`sync.ai.writebackDocComment`)

When `writebackDocComment: true` is set, ado-sync writes AI-generated steps back into the JS/TS source file as a JSDoc block above each `test()` call immediately after the first push. On subsequent pushes the parser reads the JSDoc back, so AI is not re-invoked and the steps remain stable even if the test body is edited.

**Why this matters:** Without writeback, AI re-reads the test body on every push and may produce slightly different phrasing each time — changing Azure Test Case steps unnecessarily. With writeback the steps are frozen in the source file on first push and never change unless you edit the JSDoc manually.

```json
{
  "sync": {
    "ai": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "apiKey": "$ANTHROPIC_API_KEY",
      "writebackDocComment": true
    }
  }
}
```

After the first `ado-sync push` the source file will contain:

```typescript
/**
 * User can log in with valid credentials
 * Description: Verifies the login form accepts a correct email/password pair
 * 1. Navigate to the login page
 * 2. Enter a valid email address
 * 3. Enter the matching password
 * 4. Click the Sign In button
 * 5. Check: The dashboard is displayed
 */
test('should log in with valid credentials', async ({ page }) => { ... });
```

**Rules:**
- Only applies to `javascript`, `playwright`, `puppeteer`, `cypress`, `detox`, and `xcuitest` framework types.
- Has no effect when `sync.disableLocalChanges: true`.
- If a JSDoc block already exists above a `test()` call it is replaced, not duplicated.
- Steps prefixed `Check:` map to Azure's **Expected Result** column when `sync.format.useExpectedResult: true`.
- You can populate JSDoc comments manually before the first push — the parser will read them and skip AI entirely.

**Recommended workflow for pre-populating existing specs:**
1. Write the JSDoc manually above each `test()` call (or use an LLM in your editor to batch-generate them).
2. Enable `writebackDocComment: true` in config.
3. Run `ado-sync push` — existing JSDoc is read, AI is skipped, steps are pushed to Azure.

### AI failure analysis

When `sync.ai.analyzeFailures: true` is set (and the provider is `ollama`, `docker`, `openai`, or `anthropic`), ado-sync uses the AI provider to generate a root-cause summary for failing test results during `publish-test-results`. The summary is attached as a comment on the Azure Test Run result.

```json
{
  "sync": {
    "ai": {
      "provider": "anthropic",
      "apiKey": "$ANTHROPIC_API_KEY",
      "analyzeFailures": true
    }
  }
}
```

The AI receives the test name, error message, and stack trace (if available) and returns a `rootCause` and `suggestion`. These are appended to the Azure test result comment for easy triage.

> `analyzeFailures` has no effect for the `heuristic` and `local` providers, which do not perform failure analysis.

---

### Providers

| Provider | Quality | Requires |
|----------|---------|---------|
| `local` *(default)* | Good–Excellent | A GGUF model file (see setup below) |
| `heuristic` | Basic | Nothing — zero dependencies, works offline |
| `ollama` | Good–Excellent | [Ollama](https://ollama.com) server running locally |
| `docker` | Good–Excellent | Docker Desktop with Model Runner enabled — `--ai-model ai/llama3.2`, no API key |
| `openai` | Excellent | OpenAI API key, or any OpenAI-compatible proxy (LiteLLM, Azure OpenAI, vLLM, etc.) |
| `anthropic` | Excellent | Anthropic API key |

> **No setup required to try it.** If no `--ai-model` is passed for `local`, it falls back to `heuristic` silently — so `ado-sync push` always works.

### CLI flags

| Flag | Description |
|------|-------------|
| `--ai-provider <p>` | Provider to use. Default: `local`. Pass `none` to disable entirely. |
| `--ai-model <m>` | For `local`: path to `.gguf` file. For `ollama`/`docker`/`openai`/`anthropic`: model name/tag. |
| `--ai-url <url>` | Base URL for `ollama`, `docker`, or an OpenAI-compatible endpoint. |
| `--ai-key <key>` | API key for `openai` or `anthropic`. Supports `$ENV_VAR` references. |
| `--ai-context <file>` | Path to a markdown file with domain context/instructions injected into the AI prompt. |

---

### Domain context file (`sync.ai.contextFile`)

You can provide a markdown file that gives the AI additional context about your application or team conventions. The file's content is injected into the prompt before the test code, so the AI can use it when writing titles, descriptions, and steps.

#### Config

```json
{
  "sync": {
    "ai": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "apiKey": "$ANTHROPIC_API_KEY",
      "contextFile": "./docs/ai-context.md"
    }
  }
}
```

```yaml
sync:
  ai:
    provider: anthropic
    model: claude-sonnet-4-6
    apiKey: $ANTHROPIC_API_KEY
    contextFile: ./docs/ai-context.md
```

The path is resolved relative to the config file directory. Absolute paths are also accepted.

#### CLI override

```bash
ado-sync push --ai-context ./docs/ai-context.md
```

The CLI flag takes precedence over `contextFile` in config.

#### What to put in the context file

The file is plain markdown — write whatever helps the AI produce better output for your domain. Common patterns:

```markdown
## Glossary
- "Checkout" means the 3-step payment flow (cart → shipping → payment)
- "PDP" means Product Detail Page
- "MFA" means multi-factor authentication via the Authenticator app

## Step writing style
- Start every action step with a verb: Click, Enter, Select, Navigate, Verify
- Use customer-facing button/field labels, not CSS selectors or test IDs
- Precondition steps ("Given the user is logged in") come before action steps
- End with at least one "Check:" verification step

## Out of scope
- Do not mention internal service names (e.g. auth-svc, cart-ms)
- Do not reference environment-specific URLs
```

#### Notes

- Context is injected for all LLM providers: `local`, `ollama`, `docker`, `openai`, `anthropic`.
- The `heuristic` provider does not use a prompt and ignores this setting.
- If the file cannot be read, a warning is printed and the push continues without it.

---

### Setting up the local provider (step by step)

`node-llama-cpp` is bundled with ado-sync — **no separate install needed**. You only need to download a model file once.

#### Step 1 — Choose a model size

All models use the `Q4_K_M` quantization (best balance of size and quality).

| Model | RAM needed | Quality | HF repo |
|-------|-----------|---------|---------|
| E2B | ~3.2 GB | Good | `google/gemma-4-e2b-it-GGUF` |
| **E4B** *(start here)* | ~5 GB | Better | `google/gemma-4-e4b-it-GGUF` |
| 26B A4B (MoE) | ~15.6 GB | Excellent local | `google/gemma-4-26b-a4b-it-GGUF` |
| 31B | ~17.4 GB | Best | `google/gemma-4-31b-it-GGUF` |

#### Step 2 — Download the model

**macOS / Linux:**
```bash
mkdir -p ~/.cache/ado-sync/models

# curl (no extra tools needed)
curl -L -o ~/.cache/ado-sync/models/gemma-4-e4b-it-Q4_K_M.gguf \
  "https://huggingface.co/google/gemma-4-e4b-it-GGUF/resolve/main/gemma-4-e4b-it-Q4_K_M.gguf"

# or huggingface-cli (shows a progress bar — useful for larger models)
pip install -U huggingface_hub
huggingface-cli download google/gemma-4-e4b-it-GGUF \
  gemma-4-e4b-it-Q4_K_M.gguf \
  --local-dir ~/.cache/ado-sync/models
```

**Windows (PowerShell):**
```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\ado-sync\models"

# Invoke-WebRequest
Invoke-WebRequest `
  -Uri "https://huggingface.co/google/gemma-4-e4b-it-GGUF/resolve/main/gemma-4-e4b-it-Q4_K_M.gguf" `
  -OutFile "$env:LOCALAPPDATA\ado-sync\models\gemma-4-e4b-it-Q4_K_M.gguf"

# or huggingface-cli (shows a progress bar)
pip install -U huggingface_hub
huggingface-cli download google/gemma-4-e4b-it-GGUF `
  gemma-4-e4b-it-Q4_K_M.gguf `
  --local-dir "$env:LOCALAPPDATA\ado-sync\models"
```

#### Step 3 — Push with the model

```bash
# macOS / Linux
ado-sync push --ai-model ~/.cache/ado-sync/models/gemma-4-e4b-it-Q4_K_M.gguf

# Windows
ado-sync push --ai-model "$env:LOCALAPPDATA\ado-sync\models\gemma-4-e4b-it-Q4_K_M.gguf"
```

The model is loaded once and reused for all tests in the run — no repeated loading overhead.

### Complete example — C# MSTest with local LLM

A full `ado-sync.yaml` for a C# MSTest project using a local GGUF model (no API key, no internet required at push time):

```yaml
orgUrl: https://dev.azure.com/your-org
project: YourProject
auth:
  type: pat
  token: $AZURE_DEVOPS_TOKEN
testPlan:
  id: 12345
  suiteId: 12346
  suiteMapping: flat
local:
  type: csharp
  include: Tests/**/*.cs
sync:
  tagPrefix: tc
  titleField: System.Title
  markAutomated: true
  ai:
    provider: local
    model: ~/.cache/ado-sync/models/qwen2.5-coder-7b-instruct-q4_k_m.gguf
    # Windows: model: $env:LOCALAPPDATA\ado-sync\models\qwen2.5-coder-7b-instruct-q4_k_m.gguf
```

Run:
```bash
export AZURE_DEVOPS_TOKEN=your-pat
ado-sync push --config ado-sync.yaml
```

> No `apiKey` or `baseUrl` needed — the model runs entirely in-process via `node-llama-cpp`.

---

### Setting up Ollama

```bash
# 1. Install Ollama from https://ollama.com

# 2. Pull a model
ollama pull gemma-4-e4b-it

# 3. Push (Ollama server must be running)
ado-sync push --ai-provider ollama --ai-model gemma-4-e4b-it
```

### Setting up OpenAI / Anthropic

```bash
ado-sync push --ai-provider openai    --ai-key $OPENAI_API_KEY
ado-sync push --ai-provider anthropic --ai-key $ANTHROPIC_API_KEY
```

---

### Using GitHub Copilot or Claude Code

If you already use **GitHub Copilot** or **Claude Code** as your IDE AI assistant, you can reuse the same credentials with ado-sync. The key point: these tools are IDE plugins — they don't expose an API endpoint ado-sync can call. Instead, use the underlying AI provider they run on.

#### Claude Code → `anthropic` provider

Claude Code is powered by Anthropic's Claude models. If you have an `ANTHROPIC_API_KEY` (required to run Claude Code), pass it directly:

```bash
export ANTHROPIC_API_KEY=sk-ant-...

ado-sync push --ai-provider anthropic --ai-key $ANTHROPIC_API_KEY
```

Pin a specific model with `--ai-model` (default is `claude-haiku-4-5-20251001`):

```bash
# Faster / cheaper
ado-sync push --ai-provider anthropic --ai-key $ANTHROPIC_API_KEY --ai-model claude-haiku-4-5-20251001

# Higher quality
ado-sync push --ai-provider anthropic --ai-key $ANTHROPIC_API_KEY --ai-model claude-sonnet-4-6
```

Config file equivalent — set once, never repeat the flag:

```json
{
  "sync": {
    "ai": {
      "provider": "anthropic",
      "apiKey": "$ANTHROPIC_API_KEY",
      "model": "claude-haiku-4-5-20251001"
    }
  }
}
```

#### GitHub Copilot → `openai` or `openai` + `--ai-url` provider

GitHub Copilot itself does not expose a public API endpoint. Use one of these alternatives depending on your subscription:

**Option A — OpenAI API key** (Copilot Individual / Team subscribers)

If you have a separate OpenAI API key:

```bash
ado-sync push --ai-provider openai --ai-key $OPENAI_API_KEY
```

**Option B — Azure OpenAI** (Copilot Enterprise / corporate Azure customers)

If your org has an Azure OpenAI deployment (which also powers enterprise Copilot):

```bash
ado-sync push \
  --ai-provider openai \
  --ai-url "https://<your-resource>.openai.azure.com/openai/deployments/<deployment>/v1" \
  --ai-key $AZURE_OPENAI_KEY \
  --ai-model gpt-4o-mini
```

Config file equivalent:

```json
{
  "sync": {
    "ai": {
      "provider": "openai",
      "baseUrl": "https://<your-resource>.openai.azure.com/openai/deployments/<deployment>/v1",
      "apiKey": "$AZURE_OPENAI_KEY",
      "model": "gpt-4o-mini"
    }
  }
}
```

**Option C — No API key (heuristic)**

Works offline with zero setup — good when you don't want to spend API credits:

```bash
ado-sync push --ai-provider heuristic
```

#### Quick reference

| You use | Recommended provider | Command |
|---------|---------------------|---------|
| Claude Code | `anthropic` | `ado-sync push --ai-provider anthropic --ai-key $ANTHROPIC_API_KEY` |
| Copilot Individual / Team | `openai` | `ado-sync push --ai-provider openai --ai-key $OPENAI_API_KEY` |
| Copilot Enterprise / Azure | `openai` + `--ai-url` | See Azure OpenAI option above |
| Either, no API budget | `heuristic` | `ado-sync push --ai-provider heuristic` |
| Privacy-sensitive / air-gapped | `local` | `ado-sync push --ai-model ~/.cache/ado-sync/models/...` |

#### Running ado-sync from within your IDE assistant

Both tools can execute terminal commands, so you can ask them to run ado-sync for you directly.

**Claude Code:**

```
Run: ado-sync push --ai-provider anthropic --ai-key $ANTHROPIC_API_KEY --dry-run
```

Claude Code will execute it in the terminal and explain what would change before you commit to a real push.

**GitHub Copilot Chat (VS Code):**

Use the `@terminal` agent in Copilot Chat:

```
@terminal run ado-sync push --ai-provider heuristic --dry-run and explain the output
```

Copilot will propose the command in the terminal panel for you to accept and run.

### Using LiteLLM (or any OpenAI-compatible proxy)

[LiteLLM](https://github.com/BerriAI/litellm) is a proxy that exposes an OpenAI-compatible API for 100+ model providers (Azure OpenAI, Bedrock, Gemini, Mistral, Cohere, vLLM, and more). Use the `openai` provider with `--ai-url` pointing at your LiteLLM server:

```bash
# Start LiteLLM proxy (example)
litellm --model gpt-4o-mini   # listens on http://localhost:4000 by default

# Push using LiteLLM
ado-sync push \
  --ai-provider openai \
  --ai-url http://localhost:4000 \
  --ai-key $LITELLM_API_KEY \
  --ai-model gpt-4o-mini
```

The same `--ai-url` override works for any other OpenAI-compatible server:

| Service | `--ai-url` |
|---------|-----------|
| LiteLLM (local proxy) | `http://localhost:4000` |
| LiteLLM (hosted) | `https://<your-litellm-host>/v1` |
| Hugging Face Inference | `https://router.huggingface.co/v1` |
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/deployments/<deployment>` |
| vLLM | `http://localhost:8000/v1` |
| LocalAI | `http://localhost:8080/v1` |
| LM Studio | `http://localhost:1234/v1` |

> **Note:** `api-inference.huggingface.co` is deprecated — use `router.huggingface.co` instead.

### Using Hugging Face Inference API

[Hugging Face](https://huggingface.co) provides a free serverless inference API for open-source models. Use the `openai` provider since HF exposes an OpenAI-compatible endpoint:

```bash
ado-sync push \
  --ai-provider openai \
  --ai-url https://router.huggingface.co/v1 \
  --ai-key $HF_TOKEN \
  --ai-model Qwen/Qwen2.5-Coder-7B-Instruct
```

Get a token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) (requires the **Inference** permission).

Recommended open-source models:

| Model | Notes |
|-------|-------|
| `Qwen/Qwen2.5-Coder-7B-Instruct` | Best for code/test understanding |
| `meta-llama/Llama-3.1-8B-Instruct` | Good general purpose |
| `mistralai/Mistral-7B-Instruct-v0.3` | Lightweight and fast |

Config file equivalent:

```json
{
  "sync": {
    "ai": {
      "provider": "openai",
      "baseUrl": "https://router.huggingface.co/v1",
      "apiKey": "$HF_TOKEN",
      "model": "Qwen/Qwen2.5-Coder-7B-Instruct"
    }
  }
}
```

> **LiteLLM model names:** When using a hosted LiteLLM instance that proxies Anthropic models, prefix the model name with `anthropic/`, e.g. `anthropic/claude-opus-4-6`. Check your instance's `/v1/models` endpoint for registered model names.

Config file equivalent — set any `--ai-*` flag in `sync.ai` to avoid repeating it on every push. CLI flags always take precedence over config values:

```json
{
  "sync": {
    "ai": {
      "provider": "openai",
      "baseUrl": "http://localhost:4000",
      "apiKey": "$LITELLM_API_KEY",
      "model": "gpt-4o-mini"
    }
  }
}
```

The `sync.ai` block works for any provider:

```json
{ "sync": { "ai": { "provider": "ollama", "model": "gemma-4-e4b-it" } } }
```

```json
{ "sync": { "ai": { "provider": "anthropic", "apiKey": "$ANTHROPIC_API_KEY" } } }
```

```json
{ "sync": { "ai": { "provider": "none" } } }
```

### Complete example — C# MSTest with Hugging Face

A full `ado-sync.yaml` for a C# MSTest project using the Hugging Face Inference API for AI-generated test steps:

```yaml
orgUrl: https://dev.azure.com/your-org
project: YourProject
auth:
  type: pat
  token: $AZURE_DEVOPS_TOKEN
testPlan:
  id: 12345
  suiteId: 12346
  suiteMapping: flat
local:
  type: csharp
  include: Tests/**/*.cs
sync:
  tagPrefix: tc
  titleField: System.Title
  markAutomated: true
  ai:
    provider: openai
    baseUrl: https://router.huggingface.co/v1
    apiKey: $HF_TOKEN
    model: Qwen/Qwen2.5-Coder-7B-Instruct
```

Run:
```bash
export AZURE_DEVOPS_TOKEN=your-pat
export HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxxxxx
ado-sync push --config ado-sync.yaml
```

### Disabling AI summary

```bash
ado-sync push --ai-provider none
```

---

### How it works internally

1. After parsing local files, ado-sync checks each test for a missing description or missing steps.
2. For each test that needs either, ado-sync extracts the raw function body from the source file.
3. The body is sent to the configured provider with a prompt requesting `Title:`, `Description:`, and `N. Step` / `N. Check:` lines.
4. Title and steps are applied only when the test had no existing steps. Description is applied only when the test had no existing description.
5. If the LLM call fails (network error, model not found, etc.), it automatically falls back to `heuristic`.
6. The `local` provider caches the GGUF model in memory for the entire push run — a 50-test suite loads it only once.
