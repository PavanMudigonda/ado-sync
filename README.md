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
| `generate` | Scaffold spec files from ADO User Stories (AI-powered or template) |
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

| Provider | Commands | SDK (install separately) | Auth |
|---|---|---|---|
| `heuristic` | push / pull / status | none — built-in | none |
| `local` | push / pull / status | `node-llama-cpp` *(included)* | GGUF model file path |
| `ollama` | all AI commands | `npm i ollama` | local Ollama server |
| `openai` | all AI commands | `npm i openai` | `$OPENAI_API_KEY` |
| `anthropic` | all AI commands | `npm i @anthropic-ai/sdk` | `$ANTHROPIC_API_KEY` |
| `huggingface` | all AI commands | `npm i openai` | `$HF_TOKEN` |
| `bedrock` | all AI commands | `npm i @aws-sdk/client-bedrock-runtime` | AWS credential chain |
| `azureai` | all AI commands | `npm i openai` | `$AZURE_OPENAI_KEY` + `--ai-url` |
| `github` | all AI commands | `npm i openai` | `$GITHUB_TOKEN` (auto-detected) |
| `azureinference` | all AI commands | `npm i @azure-rest/ai-inference @azure/core-auth` | `$AZURE_AI_KEY` + `--ai-url` |

### Local LLM options

If you want to run ado-sync without sending prompts to a hosted model, there are three practical local setups:

| Option | Best for | How it works | Commands |
|---|---|---|---|
| `heuristic` | Zero setup, fastest start | No model at all; built-in rules only | `push`, `pull`, `status` |
| `local` | Single-machine offline use | Runs a GGUF model directly in-process via `node-llama-cpp` | `push`, `pull`, `status`, `generate` |
| `ollama` | Easier local model management | Talks to a local Ollama server over HTTP | `push`, `pull`, `status`, `generate`, `publish-test-results` failure analysis |

`llama.cpp`-style setups work in two ways:

- Use `local` when you want to run a GGUF model directly inside ado-sync through `node-llama-cpp`.
- Use `openai --ai-url ...` when you already run the `llama.cpp` server in OpenAI-compatible mode and want ado-sync to call it over HTTP.

You can also point the `openai` provider at other local OpenAI-compatible servers such as LM Studio, vLLM, or LocalAI by setting `--ai-url`, but that is an advanced setup rather than the default local path.

### Which local option to choose

- Use `heuristic` if you only want lightweight summaries and do not want to download a model.
- Use `local` if you want fully offline inference with a `.gguf` file and no background server. This is the closest built-in path to native `llama.cpp` model usage.
- Use `ollama` if you prefer model pull/run management through Ollama and want the same local provider available to more commands.
- Use `openai --ai-url ...` if you already run `llama.cpp` server mode or another compatible local endpoint and want ado-sync to treat it like an OpenAI-style API.

### Local examples

```bash
# 1. No-model fallback: fastest setup, lowest quality
ado-sync push --ai-provider heuristic

# 2. Fully local GGUF model in-process
ado-sync push --ai-provider local \
  --ai-model ~/.cache/ado-sync/models/gemma-4-e4b-it-Q4_K_M.gguf

# 3. Ollama running on the same machine
ollama pull gemma-4-e4b-it
ado-sync push --ai-provider ollama --ai-model gemma-4-e4b-it

# 4. Local OpenAI-compatible endpoint (LM Studio / vLLM / LocalAI)
ado-sync generate --story-ids 1234 \
  --ai-provider openai \
  --ai-url http://localhost:1234/v1 \
  --ai-model local-model-name \
  --ai-key dummy

# 5. llama.cpp server in OpenAI-compatible mode
./server -m ~/.cache/ado-sync/models/gemma-4-e4b-it-Q4_K_M.gguf --port 8080
ado-sync push \
  --ai-provider openai \
  --ai-url http://localhost:8080/v1 \
  --ai-model gemma-4-e4b-it-Q4_K_M \
  --ai-key dummy
```

### Notes for local use

- `local` requires `--ai-model` to point to a `.gguf` file.
- `local` uses `node-llama-cpp`, so it works with GGUF models from the wider `llama.cpp` ecosystem.
- `ollama` defaults to `http://localhost:11434` unless you override `--ai-url`.
- If you run `llama.cpp` as an HTTP server, use the `openai` provider plus `--ai-url`; ado-sync does not call the `llama.cpp` CLI binary directly.
- `publish-test-results --analyze-failures` supports `ollama`, `openai`, and `anthropic`; it does not use the in-process `local` provider.
- For deeper setup guidance and larger local model examples, see [docs/advanced.md](docs/advanced.md) and [docs/cli.md](docs/cli.md).

```bash
# GitHub Models — free tier available, no billing setup needed
ado-sync push --ai-provider github --ai-model gpt-4o

# Anthropic
ado-sync push --ai-provider anthropic --ai-key $ANTHROPIC_API_KEY

# AWS Bedrock
ado-sync push --ai-provider bedrock --ai-model anthropic.claude-3-haiku-20240307-v1:0 --ai-region us-east-1

# Azure AI Inference (AI Foundry)
ado-sync generate --story-ids 1234 --ai-provider azureinference \
  --ai-url https://myendpoint.inference.azure.com --ai-model gpt-4o --ai-key $AZURE_AI_KEY
```

Set once in `ado-sync.json` to apply to all commands:
```json
{ "sync": { "ai": { "provider": "github", "model": "gpt-4o" } } }
```

> **LLM / AI crawlers:** [`llms.txt`](llms.txt) contains a single-file summary of the entire project — config schema, CLI flags, ID writeback formats, and the full doc index.
