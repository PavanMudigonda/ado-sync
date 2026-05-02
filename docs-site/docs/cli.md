# CLI Reference

```
ado-sync [options] [command]

Options:
  -c, --config <path>     Path to config file (default: ado-sync.json)
  --output <format>       Output format: text (default) or json
  -V, --version           Print version
  -h, --help              Show help

Commands:
  init                    Generate a starter config file (interactive wizard)
  validate                Check config and Azure DevOps connectivity
  push                    Push local specs to Azure DevOps
  pull                    Pull updates from Azure DevOps into local files
  status                  Show diff without making changes
  diff                    Show field-level diff between local and Azure
  generate                Generate local spec files from ADO User Stories
  story-context           Show AC, tags, and linked TCs for a User Story
  publish-test-results    Publish TRX / JUnit / Cucumber JSON results
  coverage                Spec link rate and story coverage report
  stale                   List (and optionally retire) TCs with no local spec
  ac-gate                 Validate stories have AC + linked TCs (CI gate)
  find-tagged             Find work items where a tag was added in the last N hours/days
  trend                   Flaky test detection and pass-rate trend report
  watch                   Auto-push on file save
  help [command]          Help for a specific command
```

---

## `init`

Generate a starter config file. Runs an **interactive wizard** when stdin is a TTY.

```bash
ado-sync init                    # creates ado-sync.json (wizard)
ado-sync init ado-sync.yml       # YAML format
ado-sync init --no-interactive   # dump template without prompting
```

The wizard asks for org URL, project, auth type, token env var, test plan ID, local spec type, and include glob — then writes a minimal valid config.

---

## `validate`

Check that the config is valid and Azure DevOps is reachable. Run this before your first `push`.

```bash
ado-sync validate
ado-sync validate -c path/to/ado-sync.json
```

Output:
```
  ✓ Config loaded — /project/ado-sync.json
  ✓ Azure connection — https://dev.azure.com/myorg
  ✓ Project "MyProject" found
  ✓ Test Plan #42 "Regression Suite" found

All checks passed.
```

Set `toolSettings.outputLevel` to `diagnostic` when you want `validate` to also print the effective auth type, local parser type, sync-target mode, tested plan IDs, and runtime override count.

---

## `push`

Push local spec files to Azure DevOps — creates new Test Cases or updates existing ones.

```bash
ado-sync push
ado-sync push --dry-run
ado-sync push --create-only
ado-sync push --link-only
ado-sync push --update-only
ado-sync push --tags "@smoke and not @wip"
ado-sync push --source-file specs/login.feature
ado-sync push --source-file specs/login.feature --source-file specs/checkout.feature
ado-sync push --config-override testPlan.id=9999

# AI-generated test steps for code files
ado-sync push --ai-provider heuristic           # fast regex, no model needed
ado-sync push --ai-provider local --ai-model ~/.cache/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf
ado-sync push --ai-provider ollama --ai-model qwen2.5-coder:7b
ado-sync push --ai-provider docker --ai-model ai/llama3.2                        # Docker Model Runner, no key needed
ado-sync push --ai-provider openai  --ai-key $OPENAI_API_KEY
ado-sync push --ai-provider anthropic --ai-key $ANTHROPIC_API_KEY
ado-sync push --ai-provider huggingface --ai-model mistralai/Mistral-7B-Instruct-v0.3 --ai-key $HF_TOKEN
ado-sync push --ai-provider bedrock --ai-model anthropic.claude-3-haiku-20240307-v1:0 --ai-region us-east-1
ado-sync push --ai-provider azureai --ai-url https://myresource.openai.azure.com --ai-model gpt-4o --ai-key $AZURE_OPENAI_KEY
ado-sync push --ai-provider github  --ai-model gpt-4o                              # uses $GITHUB_TOKEN automatically
ado-sync push --ai-provider azureinference --ai-url https://myendpoint.inference.azure.com --ai-model gpt-4o --ai-key $AZURE_AI_KEY
ado-sync push --ai-provider none                # disable AI entirely
ado-sync push --ai-context ./docs/ai-context.md # inject domain context
```

| Scenario | Action |
|----------|--------|
| No ID tag | Creates a new Test Case, writes ID back |
| ID tag, no changes | Skipped |
| ID tag, content changed | Updates the existing Test Case |
| Deleted locally, still in Azure | Tagged `ado-sync:removed` in Azure |

### Mode comparison

| Flag | Remote create | Remote update | Local ID writeback | Removed detection | Best use |
|------|---------------|---------------|--------------------|-------------------|----------|
| `--source-file` | Yes, when needed | Yes, when needed | Yes, when needed | No | Work on one or a few explicit files without scanning the whole repo |
| `--create-only` | Yes | No | Yes, for newly created cases | No | Seed new Azure test cases without touching linked inventory |
| `--link-only` | No | No | Yes, only for unique exact-title matches | No | Restore missing local IDs from an existing scoped remote inventory |
| `--update-only` | No | Yes, for linked cases | No new IDs | No | Push content changes only for already linked specs |

Quick rule of thumb:
Use `--source-file` when you want a smaller slice of normal push behavior. Use `--create-only`, `--link-only`, or `--update-only` when you want to change the kind of operation, not just the scope.

`--source-file` is repeatable and limits the run to explicit local files. Partial file runs skip removed-case detection so ado-sync does not misclassify untouched specs as deletions.

`--create-only` limits push to unlinked local specs. Linked tests are reported as skipped, and removed-case detection is disabled because the run is intentionally not a full ownership sweep.

`--link-only` limits push to ID recovery. It does not create or update remote test cases. An unlinked local spec is linked only when ado-sync finds exactly one existing remote test case in the current scope whose canonical Azure title matches exactly. Linked specs are skipped, ambiguous title matches are skipped, and removed-case detection is disabled for the run.

`--update-only` limits push to already linked test cases. Unlinked local specs are skipped instead of being created, linked cases whose remote test case no longer exists are skipped instead of being recreated, and removed-case detection is disabled because the run is intentionally not a full reconciliation.

The mode flags are mutually exclusive: use at most one of `--create-only`, `--link-only`, or `--update-only` in a single run.

### AI auto-summary

For code-based types (`java`, `csharp`, `python`, `javascript`, `playwright`, `cypress`, `testcafe`, `detox`, `espresso`, `xcuitest`, `flutter`), ado-sync reads test function bodies and generates a TC **title**, **description**, and **steps** automatically.

> No setup required — `push` always works, falling back to fast heuristic analysis.

| Provider | Quality | Setup |
|---|---|---|
| `local` *(default)* | Good–Excellent | Download a GGUF model (see below) |
| `heuristic` | Basic | None — offline, zero dependencies |
| `ollama` | Good–Excellent | `ollama pull qwen2.5-coder:7b` |
| `docker` | Good–Excellent | Docker Desktop with Model Runner enabled — `--ai-model ai/llama3.2` |
| `openai` | Excellent | `--ai-key $OPENAI_API_KEY` |
| `anthropic` | Excellent | `--ai-key $ANTHROPIC_API_KEY` |
| `huggingface` | Good–Excellent | `--ai-model <model-id> --ai-key $HF_TOKEN` |
| `bedrock` | Excellent | AWS credentials + optional `--ai-region` |
| `azureai` | Excellent | `--ai-url <endpoint> --ai-key $AZURE_OPENAI_KEY` |
| `github` | Excellent | GitHub PAT with `models:read` — `$GITHUB_TOKEN` auto-detected |
| `azureinference` | Excellent | `--ai-url <endpoint> --ai-key $AZURE_AI_KEY` |
| `openai` + `--ai-url` | Excellent | Any OpenAI-compatible proxy (LiteLLM, vLLM) |

#### Local LLM — model download

```bash
# macOS / Linux
mkdir -p ~/.cache/ado-sync/models
curl -L -o ~/.cache/ado-sync/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf \
  "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"

ado-sync push --ai-model ~/.cache/ado-sync/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf
```

| Model | RAM | Quality |
|-------|-----|---------|
| 1.5B Q4_K_M | ~1.1 GB | Good |
| 7B Q4_K_M | ~4.5 GB | Better |
| 14B Q4_K_M | ~8.5 GB | Excellent |

#### Inject domain context

```bash
ado-sync push --ai-context ./docs/ai-context.md
```

Or in config:
```json
{ "sync": { "ai": { "provider": "anthropic", "contextFile": "./docs/ai-context.md" } } }
```

#### Freeze steps in source files

Enable `writebackDocComment: true` to write AI-generated steps as JSDoc comments above each `test()` call. On subsequent pushes the parser reads the JSDoc, so AI is not re-invoked.

```json
{ "sync": { "ai": { "writebackDocComment": true } } }
```

---

## `pull`

Pull Azure DevOps Test Case changes into local spec files.

```bash
ado-sync pull
ado-sync pull --dry-run
ado-sync pull --tags "@smoke"
ado-sync pull --source-file specs/login.feature

# AI step generation — same providers as push, used when pull creates new local stubs
ado-sync pull --ai-provider anthropic --ai-key $ANTHROPIC_API_KEY
ado-sync pull --ai-provider openai    --ai-key $OPENAI_API_KEY --ai-model gpt-4o
ado-sync pull --ai-provider ollama    --ai-model qwen2.5-coder:7b
ado-sync pull --ai-provider docker    --ai-model ai/llama3.2
ado-sync pull --ai-provider huggingface --ai-model mistralai/Mistral-7B-Instruct-v0.3 --ai-key $HF_TOKEN
ado-sync pull --ai-provider bedrock      --ai-model anthropic.claude-3-haiku-20240307-v1:0 --ai-region us-east-1
ado-sync pull --ai-provider azureai      --ai-url https://myresource.openai.azure.com --ai-model gpt-4o --ai-key $AZURE_OPENAI_KEY
ado-sync pull --ai-provider github       --ai-model gpt-4o
ado-sync pull --ai-provider azureinference --ai-url https://myendpoint.inference.azure.com --ai-model gpt-4o --ai-key $AZURE_AI_KEY
```

`--source-file` limits pull to the selected local files. When pull-create is enabled in config, ado-sync skips pull-create for source-file-limited runs because a partial local slice cannot safely infer which unlinked remote test cases should become new files.

Set `toolSettings.outputLevel` to `diagnostic` when you want push, pull, status, and validate to print richer troubleshooting detail consistently during troubleshooting.

---

## `status`

Show what would change on the next push without making any modifications.

```bash
ado-sync status
ado-sync status --tags "@smoke"
ado-sync status --source-file specs/login.feature
ado-sync status --output json    # machine-readable

# AI step generation — used when computing diff for code-based test types
ado-sync status --ai-provider anthropic --ai-key $ANTHROPIC_API_KEY
ado-sync status --ai-provider openai    --ai-key $OPENAI_API_KEY
ado-sync status --ai-provider ollama    --ai-model qwen2.5-coder:7b
ado-sync status --ai-provider docker    --ai-model ai/llama3.2
ado-sync status --ai-provider bedrock        --ai-model anthropic.claude-3-haiku-20240307-v1:0 --ai-region us-east-1
ado-sync status --ai-provider azureai        --ai-url https://myresource.openai.azure.com --ai-model gpt-4o --ai-key $AZURE_OPENAI_KEY
ado-sync status --ai-provider github         --ai-model gpt-4o
ado-sync status --ai-provider azureinference --ai-url https://myendpoint.inference.azure.com --ai-model gpt-4o --ai-key $AZURE_AI_KEY
```

For hierarchy-managed configs, `status` previews the resolved generated suite target on created and updated items. When a linked spec moved between generated suite paths, the output also shows the previous generated suite.

---

## `diff`

Show a field-level diff between local specs and Azure DevOps — richer than `status`.

```bash
ado-sync diff
ado-sync diff --tags "@smoke"
ado-sync diff --source-file specs/login.feature
```

Output example:
```
~ specs/login.feature:12 · Login with valid credentials [#1234]
    changed fields: title, steps
```

For hierarchy-managed configs, `diff` also includes the resolved generated suite target. When the drift is a hierarchy relocation, the diff shows both the target suite and the previous generated suite path.

---

## `generate`

Generate local spec files (`.feature` or `.md`) from Azure DevOps User Stories, pulling title, description, and acceptance criteria to scaffold each file.

```bash
# By explicit work item IDs
ado-sync generate --story-ids 1234,5678

# By area path (fetches all User Stories under it)
ado-sync generate --area-path "MyProject\\\\Teams\\\\QA"

# By WIQL query
ado-sync generate --query "SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType]='User Story' AND [System.State]='Active'"

# Options
ado-sync generate --story-ids 1234 --format gherkin      # output .feature files
ado-sync generate --story-ids 1234 --format markdown     # output .md files (default)
ado-sync generate --story-ids 1234 --output-folder specs/generated
ado-sync generate --story-ids 1234 --force               # overwrite existing files
ado-sync generate --story-ids 1234 --dry-run             # preview without writing

# AI-powered generation — fills in real steps from the story description + AC
ado-sync generate --story-ids 1234 --ai-provider anthropic --ai-key $ANTHROPIC_API_KEY
ado-sync generate --story-ids 1234 --ai-provider openai --ai-key $OPENAI_API_KEY --ai-model gpt-4o
ado-sync generate --story-ids 1234 --ai-provider ollama --ai-model qwen2.5-coder:7b
ado-sync generate --story-ids 1234 --ai-provider docker --ai-model ai/llama3.2
ado-sync generate --story-ids 1234 --ai-provider huggingface --ai-model mistralai/Mistral-7B-Instruct-v0.3 --ai-key $HF_TOKEN
ado-sync generate --story-ids 1234 --ai-provider bedrock        --ai-model anthropic.claude-3-haiku-20240307-v1:0 --ai-region us-east-1
ado-sync generate --story-ids 1234 --ai-provider azureai        --ai-url https://myresource.openai.azure.com --ai-model gpt-4o --ai-key $AZURE_OPENAI_KEY
ado-sync generate --story-ids 1234 --ai-provider github         --ai-model gpt-4o
ado-sync generate --story-ids 1234 --ai-provider azureinference --ai-url https://myendpoint.inference.azure.com --ai-model gpt-4o --ai-key $AZURE_AI_KEY
ado-sync generate --story-ids 1234 --ai-provider local          --ai-model ~/.cache/models/qwen2.5-coder-1.5b.gguf
ado-sync generate --story-ids 1234 --ai-provider openai --ai-key $OPENAI_API_KEY \
  --ai-context src/orders/** --ai-context tests/orders/**
```

### AI generate flags

| Flag | Description |
|------|-------------|
| `--ai-provider` | Provider: `local`, `ollama`, `docker`, `openai`, `anthropic`, `huggingface`, `bedrock`, `azureai`, `github`, `azureinference` |
| `--ai-model` | Model name, path, or deployment ID |
| `--ai-key` | API key (or `$ENV_VAR` reference) |
| `--ai-url` | Base URL override (Ollama, Azure OpenAI full endpoint, OpenAI-compatible) |
| `--ai-region` | AWS region for `bedrock` (default: `AWS_REGION` env or `us-east-1`) |
| `--ai-context` | Additional context source for AI generation. Accepts a file, folder, or glob. Repeatable. |

### AI generation context

`generate` does not scan the entire workspace by default. For better AI-generated specs, pass a small set of relevant files or folders explicitly:

```bash
ado-sync generate --story-ids 1234 \
  --ai-provider openai --ai-key $OPENAI_API_KEY \
  --ai-context src/billing/** \
  --ai-context tests/billing/** \
  --ai-context docs/billing.md
```

Best results come from targeted context: relevant app code, existing automation, and feature docs. The CLI caps the number of files and total context size so prompts stay bounded and predictable.

Without `--ai-provider`, `generate` uses the template scaffold (no AI required). With it, the AI reads the story's title, description, and acceptance criteria and produces realistic Given/When/Then steps.

For `bedrock`, AWS credentials are picked up from the standard chain (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` env vars, `~/.aws/credentials`, or IAM role). Install the SDK if needed: `npm install @aws-sdk/client-bedrock-runtime`.

For `github`, create a GitHub PAT with `models:read` scope and set `GITHUB_TOKEN` in your environment — no `--ai-key` flag needed. Available models: `gpt-4o`, `gpt-4o-mini`, `Meta-Llama-3.1-70B-Instruct`, `Mistral-large`, and others from [GitHub Models](https://github.com/marketplace/models).

For `azureinference`, the endpoint is your Azure AI Inference resource URL (e.g. from Azure AI Foundry). Install the SDK if needed: `npm install @azure-rest/ai-inference @azure/core-auth`.

AI settings also fall back to `sync.ai` in `ado-sync.json`, so you can configure a provider once and all commands (`push`, `generate`, `publish-test-results`) will use it automatically.

#### Dry-run with AI preview

When `--dry-run` and `--ai-provider` are both set, the AI is called but no file is written. The first 20 lines of the generated content are printed to the terminal so you can review quality before committing:

```bash
ado-sync generate --story-ids 1234 --dry-run --ai-provider anthropic --ai-key $ANTHROPIC_API_KEY
```

#### Automatic `@tc:` tag writeback

If the ADO story already has a linked Test Case (from a previous `push` run), `generate` automatically injects the `@tc:<id>` tag into the new file. This prevents the file from appearing as an untracked new test on the next `status` run.

---

## `publish-test-results`

Publish test results from TRX, JUnit XML, NUnit XML, Cucumber JSON, or Playwright JSON files to Azure DevOps Test Runs.

```bash
ado-sync publish-test-results --testResult results/test.trx
ado-sync publish-test-results --testResult results/test.xml --testResultFormat junit --dry-run
ado-sync publish-test-results --testResult results/playwright.json --attachmentsFolder test-results/

# AI failure analysis — posts root-cause + fix suggestion as a comment on each failed result
ado-sync publish-test-results \
  --testResult results/playwright.json \
  --analyze-failures \
  --ai-provider anthropic \
  --ai-model claude-haiku-4-5-20251001 \
  --ai-key $ANTHROPIC_API_KEY

# Or with OpenAI
ado-sync publish-test-results \
  --testResult results/test.trx \
  --analyze-failures \
  --ai-provider openai \
  --ai-key $OPENAI_API_KEY

# Or with a local Ollama server (no cloud cost)
ado-sync publish-test-results \
  --testResult results/junit.xml \
  --analyze-failures \
  --ai-provider ollama \
  --ai-model qwen2.5-coder:7b

# Hugging Face Inference API
ado-sync publish-test-results \
  --testResult results/playwright.json \
  --analyze-failures \
  --ai-provider huggingface \
  --ai-model mistralai/Mistral-7B-Instruct-v0.3 \
  --ai-key $HF_TOKEN

# AWS Bedrock (uses default AWS credential chain)
ado-sync publish-test-results \
  --testResult results/playwright.json \
  --analyze-failures \
  --ai-provider bedrock \
  --ai-model anthropic.claude-3-haiku-20240307-v1:0 \
  --ai-region us-east-1

# Azure OpenAI Service
ado-sync publish-test-results \
  --testResult results/playwright.json \
  --analyze-failures \
  --ai-provider azureai \
  --ai-url https://myresource.openai.azure.com \
  --ai-model gpt-4o \
  --ai-key $AZURE_OPENAI_KEY

# GitHub Models (uses $GITHUB_TOKEN automatically)
ado-sync publish-test-results \
  --testResult results/playwright.json \
  --analyze-failures \
  --ai-provider github \
  --ai-model gpt-4o

# Azure AI Inference (Azure AI Foundry endpoint)
ado-sync publish-test-results \
  --testResult results/playwright.json \
  --analyze-failures \
  --ai-provider azureinference \
  --ai-url https://myendpoint.inference.azure.com \
  --ai-model gpt-4o \
  --ai-key $AZURE_AI_KEY
```

See [publish-test-results.md](publish-test-results.md) for full reference including config-based setup.

Set `toolSettings.outputLevel` to `diagnostic` when you want `publish-test-results` to print resolved result sources, configuration ID, planned-run bindings, attachment counts, and AI-analysis counts in addition to the normal publish summary.

---

## `find-tagged`

Find work items where a specific tag was added within the last N hours or days. Uses the Azure DevOps **revisions API** to find the exact date and time the tag first appeared — not just the item's last-changed date.

```bash
# Tag added in the last 24 hours
ado-sync find-tagged --tag "regression" --hours 24

# Tag added in the last 7 days
ado-sync find-tagged --tag "sprint-42" --days 7

# Different work item type
ado-sync find-tagged --tag "blocker" --hours 48 --work-item-type Bug

# Machine-readable output
ado-sync find-tagged --tag "regression" --days 3 --output json
```

| Flag | Description |
|------|-------------|
| `--tag <name>` | **Required.** Tag to search for |
| `--hours <n>` | Return items where the tag was added in the last N hours |
| `--days <n>` | Return items where the tag was added in the last N days |
| `--work-item-type <type>` | Work item type to search (default: `User Story`) |

One of `--hours` or `--days` is required.

Example output:
```
+ [#1234] [Active] User can reset password
   Tag added: Mar 18, 2026 14:32:07 by Jane Smith (rev 5)
   https://dev.azure.com/myorg/MyProject/_workitems/edit/1234

3 items found where "regression" was added in the last 24 hours.
```

---

## `--config-override`

All commands accept `--config-override path=value` (repeatable) to set config values at runtime:

```bash
ado-sync push --config-override testPlan.id=9999
ado-sync push --config-override sync.disableLocalChanges=true
ado-sync push --config-override sync.tagPrefix=test --config-override testPlan.id=42
```

---

## `--output json`

All sync commands support `--output json` for machine-readable output:

```bash
ado-sync status --output json | jq '.[] | select(.action=="updated")'
ado-sync push   --output json > results.json
```

Each result object: `{ action, filePath, title, azureId?, detail?, changedFields? }`

---

## `ac-gate`

Validate that ADO User Stories have Acceptance Criteria and at least one linked Test Case. Designed as a sprint or merge quality gate — exits with code 1 when any stories fail.

```bash
# Validate specific story IDs
ado-sync ac-gate --story-ids 1234,5678

# Validate all User Stories under an area path
ado-sync ac-gate --area-path "MyProject\\Teams\\QA"

# Validate via a WIQL query
ado-sync ac-gate --query "SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType]='User Story' AND [System.State]='Active'"

# Default: validates all Active/Resolved/Closed stories in the project
ado-sync ac-gate

# Machine-readable output
ado-sync ac-gate --story-ids 1234,5678 --output json
```

Options:

| Flag | Description |
|------|-------------|
| `--story-ids <ids>` | Comma-separated ADO work item IDs |
| `--area-path <path>` | Validate all User Stories under this area path |
| `--query <wiql>` | WIQL query to select stories |
| `--states <states>` | Story states to include (default: `Active,Resolved,Closed`) |

Set `toolSettings.outputLevel` to `diagnostic` when you want `ac-gate` to also print the story-selection mode, selector value, state scope, fail mode, and pass/fail bucket counts.

**Outcomes per story:**
- `pass` — has AC and at least one linked TC
- `no-ac` — missing Acceptance Criteria
- `no-tc` — has AC but no linked Test Cases (run `ado-sync push` to create them)

**CI usage:**

```yaml
- name: AC gate
  run: ado-sync ac-gate --area-path "MyProject\\QA"
  env:
    AZURE_DEVOPS_TOKEN: ${{ secrets.AZURE_DEVOPS_TOKEN }}
```

---

## `stale --retire`

The `stale` command now supports automatically retiring orphaned Azure Test Cases rather than just listing them.

Set `toolSettings.outputLevel` to `diagnostic` when you want `stale` to also print the effective sync target mode, plan scope, marker prefix, ownership tag, tag filter, stale candidate count, and retire settings.

```bash
# List stale TCs (unchanged behaviour)
ado-sync stale

# Preview what --retire would do
ado-sync stale --retire --dry-run

# Transition stale TCs to Closed and tag ado-sync:retired
ado-sync stale --retire

# Use a custom target state
ado-sync stale --retire --retire-state "Inactive"
```

Options:

| Flag | Description |
|------|-------------|
| `--retire` | Transition stale TCs to the target state and add `ado-sync:retired` tag |
| `--retire-state <state>` | Target state (default: `Closed`) |
| `--dry-run` | Preview without making changes |

---

Set `toolSettings.outputLevel` to `diagnostic` when you want `coverage` to also print the effective local parser type, sync target mode, tag filter, story-link prefix, raw linked and unlinked counts, and fail-below gate.

## `trend`

Analyse historical Azure DevOps test runs to detect flaky tests and failing patterns. Optionally post a summary to a Slack or Teams webhook.

```bash
# Analyse last 30 days (default)
ado-sync trend

# Narrow the period and number of runs sampled
ado-sync trend --days 14 --max-runs 20

# Show top 20 failing tests
ado-sync trend --top 20

# Filter to runs whose name contains "nightly"
ado-sync trend --run-name nightly

# Post summary to Slack
ado-sync trend --webhook-url https://hooks.slack.com/services/... --webhook-type slack

# Post to Microsoft Teams
ado-sync trend --webhook-url https://your-org.webhook.office.com/... --webhook-type teams

# Fail the build when flaky tests are detected
ado-sync trend --fail-on-flaky

# Fail when overall pass rate drops below 85%
ado-sync trend --fail-below 85

# Machine-readable output
ado-sync trend --output json
```

Options:

| Flag | Description |
|------|-------------|
| `--days <n>` | Days of history to analyse (default: 30) |
| `--max-runs <n>` | Max test runs to sample (default: 50) |
| `--top <n>` | Top N failing tests to surface (default: 10) |
| `--run-name <filter>` | Only include runs whose name contains this string |
| `--webhook-url <url>` | Webhook URL to post summary to |
| `--webhook-type <type>` | `slack` (default), `teams`, or `generic` |
| `--fail-on-flaky` | Exit 1 when any flaky tests are found |
| `--fail-below <percent>` | Exit 1 when overall pass rate is below threshold |

Set `toolSettings.outputLevel` to `diagnostic` when you want `trend` to also print the effective date window, max-run cap, top-N cap, run-name filter, webhook mode, fail gates, and analyzed run/result counts.

**Flaky test definition:** a test that both passed and failed at least once in the sampled period.

**CI usage:**

```yaml
- name: Trend report
  run: ado-sync trend --days 30 --fail-on-flaky --webhook-url ${{ secrets.SLACK_WEBHOOK }}
  env:
    AZURE_DEVOPS_TOKEN: ${{ secrets.AZURE_DEVOPS_TOKEN }}
```

---

## `watch`

Watch local spec files and rerun `push` automatically when files change.

```bash
ado-sync watch
ado-sync watch --dry-run
ado-sync watch --source-file specs/login.feature
ado-sync watch --source-file specs/login.feature --update-only
ado-sync watch --tags "@smoke" --debounce 1200
ado-sync watch --create-only
ado-sync watch --link-only
```

`watch` forwards the same constrained push modes that `push` supports:

- `--source-file` limits both the watched files and the push scope.
- `--create-only` creates only unlinked local specs on each run.
- `--link-only` restores local IDs by unique exact-title match without remote mutations.
- `--update-only` updates only already linked specs.

The mode flags are mutually exclusive in `watch` just as they are in `push`.

Use `watch` when you want the normal push feedback loop after each save, but still need the safety boundaries from the explicit push modes.

---

## GitHub Actions templates

Two ready-to-use workflow templates ship in `.github/workflows/`:

### `ado-sync-pr-check.yml`

Runs `ado-sync push --dry-run` on every pull request and posts (or updates) a structured comment listing unlinked specs, drift, and conflicts.

Required secrets: `ADO_PAT`

```yaml
# .github/workflows/ado-sync-pr-check.yml  (already present in this repo)
on:
  pull_request:
    types: [opened, synchronize, reopened]
```

### `ado-sync-coverage-gate.yml`

Runs three checks on push/PR to main:
1. **Spec link rate gate** — `ado-sync coverage --fail-below N`
2. **AC gate** — `ado-sync ac-gate` scoped to an area path
3. **Trend report** — informational, posts to webhook if configured

Required secrets: `ADO_PAT`

Key repository variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ADO_SYNC_COVERAGE_MIN` | `80` | Minimum spec link rate % |
| `ADO_SYNC_AC_AREA_PATH` | *(all)* | Area path scope for AC gate |
| `ADO_SYNC_TREND_DAYS` | `30` | Days of history for trend report |
| `ADO_SYNC_TREND_WEBHOOK` | | Webhook URL for trend summary |
| `ADO_SYNC_TREND_WEBHOOK_TYPE` | `slack` | `slack`, `teams`, or `generic` |
