# ado-sync

Bidirectional sync between local test specs and Azure DevOps Test Cases.

Supports Gherkin `.feature`, Markdown `.md`, C#, Java, Python, JavaScript/TypeScript (Jest, Playwright, Cypress, Puppeteer, TestCafe, Detox), Swift (XCUITest), Kotlin/Java (Espresso), Dart (Flutter), Robot Framework, Go, RSpec, PHPUnit, Rust, CSV, and Excel.

> Also available as a **[VS Code Extension](https://marketplace.visualstudio.com/items?itemName=PavanMudigonda.ado-sync-vscode)** — CodeLens, sidebar tree, and all commands without leaving the editor.

---

## Quick start

```bash
npm install -g ado-sync
ado-sync init            # interactive wizard → creates ado-sync.json
export AZURE_DEVOPS_TOKEN=your_pat
ado-sync push --dry-run  # preview
ado-sync push            # create / update Test Cases
```

Minimum config:
```json
{
  "orgUrl": "https://dev.azure.com/YOUR-ORG",
  "project": "YOUR-PROJECT",
  "auth": { "type": "pat", "token": "$AZURE_DEVOPS_TOKEN" },
  "testPlan": { "id": 12345 },
  "local": { "type": "gherkin", "include": "specs/**/*.feature" }
}
```

---

## Commands

| Command | Purpose |
|---------|---------|
| `init` | Interactive config wizard |
| `validate` | Check config and Azure connectivity |
| `push` | Local specs → Azure Test Cases |
| `pull` | Azure Test Cases → local files |
| `status` | Show pending changes without modifying anything |
| `diff` | Field-level drift between local and Azure |
| `generate` | Scaffold spec files from ADO User Stories (template-first, optionally AI-enhanced) |
| `publish-test-results` | Publish TRX / JUnit / Playwright / Cucumber results to a Test Run |
| `story-context` | Show AC, suggested tags, and linked TCs for a User Story |
| `coverage` | Spec link rate and story coverage report |
| `stale` | List (and optionally retire) Azure TCs with no local spec |
| `ac-gate` | Validate stories have AC and linked Test Cases — CI quality gate |
| `find-tagged` | Find work items where a specific tag was added in the last N hours/days |
| `trend` | Flaky test detection and pass-rate trends over historical runs |
| `watch` | Auto-push on file save |

---


## Output symbols

```
+  created    — new Test Case created in Azure DevOps
~  updated    — existing Test Case updated
↓  pulled     — local file updated from Azure DevOps
=  skipped    — no changes detected
!  conflict   — both sides changed (see conflictAction)
−  removed    — local scenario deleted; tagged ado-sync:removed in Azure
↓  retired    — stale TC closed (stale --retire)
✗  error      — something went wrong
```

---

## Documentation

| Topic | Link |
|-------|------|
| CLI reference | [docs/cli.md](docs/cli.md) |
| Configuration reference | [docs/configuration.md](docs/configuration.md) |
| Capability roadmap | [docs/capability-roadmap.md](docs/capability-roadmap.md) |
| Spec file formats | [docs/spec-formats.md](docs/spec-formats.md) |
| Workflow examples (per framework + CI) | [docs/workflows.md](docs/workflows.md) |
| Work item links | [docs/work-item-links.md](docs/work-item-links.md) |
| Publishing test results | [docs/publish-test-results.md](docs/publish-test-results.md) |
| Advanced features | [docs/advanced.md](docs/advanced.md) |
| AI agent setup | [docs/agent-setup.md](docs/agent-setup.md) |
| MCP Server | [docs/mcp-server.md](docs/mcp-server.md) |
| VS Code Extension | [docs/vscode-extension.md](docs/vscode-extension.md) |
| Troubleshooting | [docs/troubleshooting.md](docs/troubleshooting.md) |

---

## AI providers

ado-sync supports multiple AI providers for test-step summarisation (`push`/`pull`/`status`), spec generation (`generate`), and failure analysis (`publish-test-results`). All provider SDKs are **optional** — install only what you need.

`generate` does not crawl the whole repo by default. It uses ADO story data first, and you can add targeted app/test context explicitly when you want richer AI-generated specs.

| Provider | Commands | SDK (install separately) | Auth |
|---|---|---|---|
| `heuristic` | push / pull / status | none — built-in | none |
| `local` | push / pull / status | `node-llama-cpp` *(included)* | GGUF model file path |
| `ollama` | all AI commands | `npm i ollama` | local Ollama server |
| `docker` | all AI commands | `npm i openai` | Docker Desktop with Model Runner — no API key |
| `openai` | all AI commands | `npm i openai` | `$OPENAI_API_KEY` |
| `anthropic` | all AI commands | `npm i @anthropic-ai/sdk` | `$ANTHROPIC_API_KEY` |
| `huggingface` | all AI commands | `npm i openai` | `$HF_TOKEN` |
| `bedrock` | all AI commands | `npm i @aws-sdk/client-bedrock-runtime` | AWS credential chain |
| `azureai` | all AI commands | `npm i openai` | `$AZURE_OPENAI_KEY` + `--ai-url` |
| `github` | all AI commands | `npm i openai` | `$GITHUB_TOKEN` (auto-detected) |
| `azureinference` | all AI commands | `npm i @azure-rest/ai-inference @azure/core-auth` | `$AZURE_AI_KEY` + `--ai-url` |

### AI quick guide

- Use `heuristic` for zero-setup summaries.
- Use `local` for GGUF models through `node-llama-cpp`.
- Use `ollama` if you already manage models with Ollama.
- Use `docker` for Docker Model Runner — local inference via Docker Desktop, no API key required.
- Use `openai`, `anthropic`, `github`, `bedrock`, `azureai`, or `azureinference` for hosted/provider-backed generation.
- For `generate`, pass a small set of relevant files with `--ai-context` instead of the whole repo.

Examples:

```bash
# Fastest setup
ado-sync push --ai-provider heuristic

# Local inference via Docker Desktop (no API key)
ado-sync push --ai-provider docker --ai-model ai/llama3.2

# Hosted model
ado-sync push --ai-provider github --ai-model gpt-4o

# Repo-aware spec generation with targeted context
ado-sync generate --story-ids 1234 \
  --ai-provider openai --ai-key $OPENAI_API_KEY \
  --ai-context src/orders/** \
  --ai-context tests/orders/** \
  --ai-context docs/orders.md
```

Set once in `ado-sync.json` to apply to all commands:

```json
{ "sync": { "ai": { "provider": "github", "model": "gpt-4o" } } }
```

Detailed AI setup, local-model guidance, provider-specific examples, and generate-context recommendations are in the docs:

- [docs/cli.md](docs/cli.md)
- [docs/advanced.md](docs/advanced.md)
- [docs/mcp-server.md](docs/mcp-server.md)

> **LLM / AI crawlers:** [`llms.txt`](llms.txt) contains a single-file summary of the entire project — config schema, CLI flags, ID writeback formats, and the full doc index.
