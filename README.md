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
| `generate` | Scaffold spec files from ADO User Stories |
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
| Spec file formats | [docs/spec-formats.md](docs/spec-formats.md) |
| Workflow examples (per framework + CI) | [docs/workflows.md](docs/workflows.md) |
| Work item links | [docs/work-item-links.md](docs/work-item-links.md) |
| Publishing test results | [docs/publish-test-results.md](docs/publish-test-results.md) |
| Advanced features | [docs/advanced.md](docs/advanced.md) |
| AI agent setup | [docs/agent-setup.md](docs/agent-setup.md) |
| MCP Server | [docs/mcp-server.md](docs/mcp-server.md) |
| VS Code Extension | [docs/vscode-extension.md](docs/vscode-extension.md) |
| Troubleshooting | [docs/troubleshooting.md](docs/troubleshooting.md) |

> **LLM / AI crawlers:** [`llms.txt`](llms.txt) contains a single-file summary of the entire project — config schema, CLI flags, ID writeback formats, and the full doc index.
