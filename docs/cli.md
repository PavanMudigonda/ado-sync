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
  publish-test-results    Publish TRX / JUnit / Cucumber JSON results
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

---

## `push`

Push local spec files to Azure DevOps — creates new Test Cases or updates existing ones.

```bash
ado-sync push
ado-sync push --dry-run
ado-sync push --tags "@smoke and not @wip"
ado-sync push --config-override testPlan.id=9999

# AI-generated test steps for code files
ado-sync push --ai-provider heuristic           # fast regex, no model needed
ado-sync push --ai-provider local --ai-model ~/.cache/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf
ado-sync push --ai-provider ollama --ai-model qwen2.5-coder:7b
ado-sync push --ai-provider openai  --ai-key $OPENAI_API_KEY
ado-sync push --ai-provider anthropic --ai-key $ANTHROPIC_API_KEY
ado-sync push --ai-provider none                # disable AI entirely
ado-sync push --ai-context ./docs/ai-context.md # inject domain context
```

| Scenario | Action |
|----------|--------|
| No ID tag | Creates a new Test Case, writes ID back |
| ID tag, no changes | Skipped |
| ID tag, content changed | Updates the existing Test Case |
| Deleted locally, still in Azure | Tagged `ado-sync:removed` in Azure |

### AI auto-summary

For code-based types (`java`, `csharp`, `python`, `javascript`, `playwright`, `cypress`, `testcafe`, `detox`, `espresso`, `xcuitest`, `flutter`), ado-sync reads test function bodies and generates a TC **title**, **description**, and **steps** automatically.

> No setup required — `push` always works, falling back to fast heuristic analysis.

| Provider | Quality | Setup |
|---|---|---|
| `local` *(default)* | Good–Excellent | Download a GGUF model (see below) |
| `heuristic` | Basic | None — offline, zero dependencies |
| `ollama` | Good–Excellent | `ollama pull qwen2.5-coder:7b` |
| `openai` | Excellent | `--ai-key $OPENAI_API_KEY` |
| `anthropic` | Excellent | `--ai-key $ANTHROPIC_API_KEY` |
| `openai` + `--ai-url` | Excellent | Any OpenAI-compatible proxy (LiteLLM, Azure OpenAI, vLLM) |

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
```

---

## `status`

Show what would change on the next push without making any modifications.

```bash
ado-sync status
ado-sync status --tags "@smoke"
ado-sync status --output json    # machine-readable
```

---

## `diff`

Show a field-level diff between local specs and Azure DevOps — richer than `status`.

```bash
ado-sync diff
ado-sync diff --tags "@smoke"
```

Output example:
```
~ specs/login.feature:12 · Login with valid credentials [#1234]
    changed fields: title, steps
```

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
```

---

## `publish-test-results`

Publish test results from TRX, JUnit XML, NUnit XML, Cucumber JSON, or Playwright JSON files to Azure DevOps Test Runs.

```bash
ado-sync publish-test-results --testResult results/test.trx
ado-sync publish-test-results --testResult results/test.xml --testResultFormat junit --dry-run
ado-sync publish-test-results --testResult results/playwright.json --attachmentsFolder test-results/
```

See [publish-test-results.md](publish-test-results.md) for full reference.

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
