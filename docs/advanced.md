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

By default, all Test Cases go into a single flat suite (`suiteMapping: "flat"`). Setting `suiteMapping: "byFolder"` mirrors the local folder structure as nested child suites in Azure.

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
    basic.feature    → suite "login" → TC "Successful login"
  checkout/
    happy.feature    → suite "checkout" → TC "Add item and checkout"
```

Child suites are created automatically if they do not exist. The suite hierarchy is re-used across runs.

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

## AI auto-summary for code tests

When pushing code-based test types (`java`, `csharp`, `python`, `javascript`, `playwright`), ado-sync reads each test function body and automatically generates a TC **title**, **description**, and numbered **steps**.

**What gets generated and when:**

| Test state | What AI generates |
|------------|------------------|
| No doc comment at all | Title + description + all steps |
| Has doc comment steps but no description | Description only (existing steps kept) |
| Has both steps and a description | Nothing — left unchanged |

Local source files are **never modified** by the AI summary feature.

---

### Providers

| Provider | Quality | Requires |
|----------|---------|---------|
| `local` *(default)* | Good–Excellent | A GGUF model file (see setup below) |
| `heuristic` | Basic | Nothing — zero dependencies, works offline |
| `ollama` | Good–Excellent | [Ollama](https://ollama.com) server running locally |
| `openai` | Excellent | OpenAI API key |
| `anthropic` | Excellent | Anthropic API key |

> **No setup required to try it.** If no `--ai-model` is passed for `local`, it falls back to `heuristic` silently — so `ado-sync push` always works.

### CLI flags

| Flag | Description |
|------|-------------|
| `--ai-provider <p>` | Provider to use. Default: `local`. Pass `none` to disable entirely. |
| `--ai-model <m>` | For `local`: path to `.gguf` file. For `ollama`/`openai`/`anthropic`: model name/tag. |
| `--ai-url <url>` | Base URL for `ollama` or an OpenAI-compatible endpoint. |
| `--ai-key <key>` | API key for `openai` or `anthropic`. Supports `$ENV_VAR` references. |

---

### Setting up the local provider (step by step)

`node-llama-cpp` is bundled with ado-sync — **no separate install needed**. You only need to download a model file once.

#### Step 1 — Choose a model size

All models use the `Q4_K_M` quantization (best balance of size and quality).

| Model | RAM needed | Quality | HF repo |
|-------|-----------|---------|---------|
| 0.5B | ~400 MB | Minimal | `Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF` |
| **1.5B** *(start here)* | ~1.1 GB | Good | `Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF` |
| 3B | ~2 GB | Better | `Qwen/Qwen2.5-Coder-3B-Instruct-GGUF` |
| 7B | ~4.5 GB | Best local | `Qwen/Qwen2.5-Coder-7B-Instruct-GGUF` |
| 14B | ~8.5 GB | Excellent | `Qwen/Qwen2.5-Coder-14B-Instruct-GGUF` |

#### Step 2 — Download the model

**macOS / Linux:**
```bash
mkdir -p ~/.cache/ado-sync/models

# curl (no extra tools needed)
curl -L -o ~/.cache/ado-sync/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf \
  "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"

# or huggingface-cli (shows a progress bar — useful for larger models)
pip install -U huggingface_hub
huggingface-cli download Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF \
  qwen2.5-coder-1.5b-instruct-q4_k_m.gguf \
  --local-dir ~/.cache/ado-sync/models
```

**Windows (PowerShell):**
```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\ado-sync\models"

# Invoke-WebRequest
Invoke-WebRequest `
  -Uri "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf" `
  -OutFile "$env:LOCALAPPDATA\ado-sync\models\qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"

# or huggingface-cli (shows a progress bar)
pip install -U huggingface_hub
huggingface-cli download Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF `
  qwen2.5-coder-1.5b-instruct-q4_k_m.gguf `
  --local-dir "$env:LOCALAPPDATA\ado-sync\models"
```

#### Step 3 — Push with the model

```bash
# macOS / Linux
ado-sync push --ai-model ~/.cache/ado-sync/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf

# Windows
ado-sync push --ai-model "$env:LOCALAPPDATA\ado-sync\models\qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"
```

The model is loaded once and reused for all tests in the run — no repeated loading overhead.

---

### Setting up Ollama

```bash
# 1. Install Ollama from https://ollama.com

# 2. Pull a model
ollama pull qwen2.5-coder:7b

# 3. Push (Ollama server must be running)
ado-sync push --ai-provider ollama --ai-model qwen2.5-coder:7b
```

### Setting up OpenAI / Anthropic

```bash
ado-sync push --ai-provider openai    --ai-key $OPENAI_API_KEY
ado-sync push --ai-provider anthropic --ai-key $ANTHROPIC_API_KEY
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
