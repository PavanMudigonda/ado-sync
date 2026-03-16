# MCP Server

`ado-sync` ships a built-in MCP (Model Context Protocol) server that exposes its sync operations as **structured tools** for AI agents — Claude Code, GitHub Copilot, Cursor, and any other MCP-compatible host.

Using the MCP server instead of spawning the CLI gives agents:
- Typed JSON responses (no output parsing)
- Structured error objects with status codes
- Fine-grained tool calls (get one test case, push a subset, etc.)

---

## Start the server

```bash
# stdio transport (standard for IDE integrations)
ado-sync-mcp
```

The server reads your `ado-sync.json` (or the path in `ADO_SYNC_CONFIG` env var) automatically.

```bash
# Point at a specific config
ADO_SYNC_CONFIG=/path/to/ado-sync.json ado-sync-mcp
```

---

## Register in Claude Code

Add to `~/.claude/claude_desktop_config.json` (or the path shown in Claude Code → Settings → MCP):

```json
{
  "mcpServers": {
    "ado-sync": {
      "command": "ado-sync-mcp",
      "env": {
        "AZURE_DEVOPS_TOKEN": "<your-token>",
        "ADO_SYNC_CONFIG": "/path/to/ado-sync.json"
      }
    }
  }
}
```

Restart Claude Code. The tools appear automatically under the `ado-sync` server namespace.

---

## Register in VS Code (GitHub Copilot)

Add to `.vscode/mcp.json` in your workspace (or user settings):

```json
{
  "servers": {
    "ado-sync": {
      "type": "stdio",
      "command": "ado-sync-mcp",
      "env": {
        "AZURE_DEVOPS_TOKEN": "${env:AZURE_DEVOPS_TOKEN}",
        "ADO_SYNC_CONFIG": "${workspaceFolder}/ado-sync.json"
      }
    }
  }
}
```

---

## Register in Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ado-sync": {
      "command": "ado-sync-mcp",
      "env": {
        "AZURE_DEVOPS_TOKEN": "<your-token>",
        "ADO_SYNC_CONFIG": "/path/to/ado-sync.json"
      }
    }
  }
}
```

---

## Available tools

| Tool | Description |
|------|-------------|
| `validate_config` | Check config validity and Azure DevOps connectivity |
| `get_test_cases` | List all Test Cases in a suite |
| `get_test_case` | Get a single Test Case by ID |
| `push_specs` | Push local spec files to Azure DevOps |
| `pull_specs` | Pull Azure DevOps changes into local files |
| `status` | Show diff between local and Azure without making changes |
| `diff` | Show field-level diff (richer than status) |
| `generate_specs` | Generate local spec files from ADO User Stories |
| `get_work_items` | Fetch ADO User Stories / work items |
| `publish_test_results` | Publish TRX / JUnit / Playwright JSON results |

---

## Tool parameters

All tools accept these optional base parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `configPath` | string | Path to `ado-sync.json` (overrides `ADO_SYNC_CONFIG`) |
| `configOverrides` | string[] | Runtime overrides in `key=value` format (same as `--config-override`) |

### `push_specs`

```json
{
  "dryRun": false,
  "tags": "@smoke and not @wip",
  "aiProvider": "heuristic"
}
```

### `generate_specs`

```json
{
  "storyIds": [1234, 5678],
  "format": "gherkin",
  "outputFolder": "specs/generated",
  "dryRun": false,
  "force": false
}
```

### `publish_test_results`

```json
{
  "testResult": "results/playwright.json",
  "attachmentsFolder": "test-results/"
}
```

---

## Example agent workflow

Once registered, an AI agent can orchestrate the full test lifecycle without any human CLI invocation:

```
Agent: "Push my Playwright specs to Azure DevOps"
→ calls push_specs({ dryRun: true })        # preview
→ calls push_specs({})                       # apply

Agent: "Generate spec files for User Story 1234"
→ calls generate_specs({ storyIds: [1234], format: "gherkin" })

Agent: "Publish the latest test results"
→ calls publish_test_results({ testResult: "results/playwright.json" })
```

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `ADO_SYNC_CONFIG` | Path to config file (default: `ado-sync.json` in cwd) |
| `AZURE_DEVOPS_TOKEN` | PAT or access token (referenced by `auth.token` in config) |
