---
id: intro
title: Overview
slug: /
description: Command-first documentation for syncing local test specs with Azure DevOps Test Cases.
---

<div className="landing-shell">

<div className="landing-hero">

<p className="landing-kicker">CLI-first documentation</p>

# ado-sync

Bidirectional sync between local test specs and Azure DevOps Test Cases.

ado-sync supports Gherkin `.feature`, Markdown `.md`, C#, Java, Python, JavaScript/TypeScript frameworks such as Jest, Playwright, Cypress, Puppeteer, and TestCafe, plus mobile and desktop test stacks including Detox, Espresso, Flutter, Robot Framework, Go, RSpec, PHPUnit, Rust, CSV, and Excel.

<div className="landing-actions">

- [Start with the CLI](./cli.md)
- [Read configuration](./configuration.md)
- [Open workflow examples](./workflows.md)

</div>

</div>

<div className="landing-grid">

<div className="landing-card">

## Use it for

- Creating and updating Azure DevOps Test Cases from local specs
- Writing IDs back into source files so tests and work items stay linked
- Publishing results from TRX, JUnit, Playwright, and Cucumber outputs
- Supporting AI-assisted summarization, generation, and MCP workflows

</div>

<div className="landing-card">

## Start here

- New user: [CLI reference](./cli.md)
- Connecting Azure DevOps: [Configuration reference](./configuration.md)
- Agent orchestration: [MCP server](./mcp-server.md)
- CI patterns: [Workflows](./workflows.md)

</div>

</div>

## Quick start

```bash
npm install -g ado-sync
ado-sync init
export AZURE_DEVOPS_TOKEN=your_pat
ado-sync push --dry-run
ado-sync push
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

## Core flow

1. Run `ado-sync init` to create the config.
2. Set `AZURE_DEVOPS_TOKEN` or another supported auth method.
3. Use `ado-sync push --dry-run` to inspect pending work safely.
4. Use `ado-sync push` or `ado-sync pull` once the mapping looks correct.
5. Publish automated test results with `ado-sync publish-test-results`.

## Common commands

| Command | Purpose |
| --- | --- |
| `init` | Interactive config wizard |
| `validate` | Check config and Azure connectivity |
| `push` | Local specs to Azure Test Cases |
| `pull` | Azure Test Cases to local files |
| `status` | Show pending changes without modifying anything |
| `diff` | Field-level drift between local and Azure |
| `generate` | Scaffold spec files from ADO User Stories |
| `publish-test-results` | Publish TRX, JUnit, Playwright, or Cucumber results |

## Working modes

| Mode | Entry points |
| --- | --- |
| Day-to-day sync | `push`, `pull`, `status`, `diff` |
| Planning and generation | `generate`, `story-context`, `coverage`, `stale` |
| Automation and agents | `mcp-server`, `agent-setup`, `publish-test-results` |

## Documentation map

- [CLI reference](./cli.md)
- [Configuration reference](./configuration.md)
- [Capability roadmap](./capability-roadmap.md)
- [Agent setup](./agent-setup.md)
- [MCP server](./mcp-server.md)
- [Work item links](./work-item-links.md)
- [Workflows](./workflows.md)
- [Publish test results](./publish-test-results.md)
- [Spec formats](./spec-formats.md)
- [VS Code extension](./vscode-extension.md)
- [Troubleshooting](./troubleshooting.md)
- [Advanced features](./advanced.md)
- [Framework examples](./examples/index.md)

## AI providers

ado-sync supports multiple AI providers for test-step summarization, spec generation, and failure analysis. Provider SDKs are optional, so you only install what you need.

- `heuristic` for zero-setup summaries
- `local` for GGUF models through `node-llama-cpp`
- `ollama` for local model serving
- `openai`, `anthropic`, `github`, `bedrock`, `azureai`, and `azureinference` for hosted models

Detailed setup and provider-specific examples are covered in the CLI, advanced, and MCP server docs.

</div>
