# MCP Server

`ado-sync` ships a built-in MCP (Model Context Protocol) server that exposes its sync operations as **structured tools** for AI agents — Claude Code, GitHub Copilot, Cursor, and any other MCP-compatible host.

Using the MCP server instead of spawning the CLI gives agents:
- Typed JSON responses (no output parsing)
- Structured error objects with status codes
- Fine-grained tool calls (get one test case, push a subset, etc.)

---

## Installation

No separate install needed. `ado-sync-mcp` ships inside the `ado-sync` npm package.

**Option A — Global install (recommended, fastest startup)**
```bash
npm install -g ado-sync
```

**Option B — npx (no install, always latest)**

Use `npx --yes --package=ado-sync ado-sync-mcp` as the command in all configs below.
npx downloads and runs the package automatically on first use.

---

## Claude Code — one-liner registration

```bash
# With global install
claude mcp add ado-sync \
  --env AZURE_DEVOPS_TOKEN="$AZURE_DEVOPS_TOKEN" \
  --env ADO_SYNC_CONFIG="$(pwd)/ado-sync.json" \
  -- ado-sync-mcp

# With npx (no global install required)
claude mcp add ado-sync \
  --env AZURE_DEVOPS_TOKEN="$AZURE_DEVOPS_TOKEN" \
  --env ADO_SYNC_CONFIG="$(pwd)/ado-sync.json" \
  -- npx --yes --package=ado-sync ado-sync-mcp
```

Verify it registered: run `/mcp` in Claude Code — `ado-sync` should appear in the list.

**Manual config** — `~/.claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "ado-sync": {
      "command": "npx",
      "args": ["--yes", "--package=ado-sync", "ado-sync-mcp"],
      "env": {
        "AZURE_DEVOPS_TOKEN": "<your-pat>",
        "ADO_SYNC_CONFIG": "/absolute/path/to/ado-sync.json"
      }
    }
  }
}
```

---

## Claude Desktop

Config file location:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ado-sync": {
      "command": "npx",
      "args": ["--yes", "--package=ado-sync", "ado-sync-mcp"],
      "env": {
        "AZURE_DEVOPS_TOKEN": "<your-pat>",
        "ADO_SYNC_CONFIG": "/absolute/path/to/ado-sync.json"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

---

## VS Code (GitHub Copilot agent mode)

Create `.vscode/mcp.json` in your workspace root:

```json
{
  "servers": {
    "ado-sync": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "--package=ado-sync", "ado-sync-mcp"],
      "env": {
        "AZURE_DEVOPS_TOKEN": "${env:AZURE_DEVOPS_TOKEN}",
        "ADO_SYNC_CONFIG": "${workspaceFolder}/ado-sync.json"
      }
    }
  }
}
```

`${env:AZURE_DEVOPS_TOKEN}` reads the variable from your shell environment — no hardcoded secrets.

---

## Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ado-sync": {
      "command": "npx",
      "args": ["--yes", "--package=ado-sync", "ado-sync-mcp"],
      "env": {
        "AZURE_DEVOPS_TOKEN": "<your-pat>",
        "ADO_SYNC_CONFIG": "/absolute/path/to/ado-sync.json"
      }
    }
  }
}
```

---

## Verify it works

After registration, ask your AI assistant:

```
"Call ado-sync validate_config and tell me what it returns"
```

Expected response includes config validity, Azure connection status, and test plan confirmation.

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
| `publish_test_results` | Publish TRX / JUnit / Playwright JSON / CTRF results; optionally file issues for failures |
| `create_issue` | File a single GitHub Issue or ADO Bug for a test failure (for healer agents) |
| `get_story_context` | Planner-agent feed: AC items, suggested tags, actors, linked TC IDs |
| `generate_manifest` | Write `.ai-workflow-manifest-{id}.json` for the full Planner→CI cycle |
| `find_tagged_items` | Find work items where a tag was added in the last N hours/days (exact timestamp via revisions API) |

---

## Tool parameters

All tools accept these optional base parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `configPath` | string | Absolute path to `ado-sync.json` (overrides `ADO_SYNC_CONFIG`) |
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
  "attachmentsFolder": "test-results/",
  "createIssuesOnFailure": true,
  "issueProvider": "github",
  "githubRepo": "myorg/myrepo",
  "githubToken": "$GITHUB_TOKEN",
  "bugThreshold": 20,
  "maxIssues": 50
}
```

### `create_issue`

```json
{
  "title": "[FAILED] Login with valid credentials",
  "body": "Error: Expected 200 but got 401\n\nStack: ...",
  "provider": "github",
  "githubRepo": "myorg/myrepo",
  "githubToken": "$GITHUB_TOKEN",
  "testCaseId": 1234
}
```

### `get_story_context`

```json
{ "storyId": 1234 }
```

Returns: AC items as a bullet list, inferred tags (`@smoke`, `@auth`, …), extracted actors, and IDs of any Test Cases already linked via TestedBy relation.

### `generate_manifest`

```json
{
  "storyIds": [1234, 5678],
  "outputFolder": "e2e/bdd",
  "format": "gherkin",
  "dryRun": false
}
```

Writes `.ai-workflow-manifest-1234.json` in `outputFolder`. The manifest contains the ordered 8-step workflow, AC items, required documents checklist, and validation steps.

### `find_tagged_items`

```json
{
  "tag": "regression",
  "hours": 24
}
```

```json
{
  "tag": "sprint-42",
  "days": 7,
  "workItemType": "Bug"
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `tag` | string | **Required.** Tag to search for |
| `hours` | number | Time window in hours |
| `days` | number | Time window in days (mutually exclusive with `hours`) |
| `workItemType` | string | Work item type (default: `"User Story"`) |

Returns per item: `id`, `title`, `state`, `tagAddedAt` (ISO timestamp), `tagAddedBy`, `tagAddedRevision`, `currentTags`, `url`.

Uses the revisions API — finds the exact revision where the tag first appeared, not just when the item was last changed.

---

## Example agent workflow

Once registered, an AI agent can orchestrate the full test lifecycle without any human CLI invocation:

```
Agent: "Set up ado-sync for this repo"
→ calls validate_config to check connectivity
→ calls push_specs({ dryRun: true }) to preview
→ calls push_specs({}) to create Test Cases

Agent: "Generate spec files for User Story 1234"
→ calls generate_specs({ storyIds: [1234], format: "gherkin" })

Agent: "Publish the latest test results and file issues for failures"
→ calls publish_test_results({ testResult: "results/playwright.json", createIssuesOnFailure: true, githubRepo: "myorg/myrepo", githubToken: "$GITHUB_TOKEN" })
→ returns issue URLs for any failures → healer agent opens fix PRs
```

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `ADO_SYNC_CONFIG` | Absolute path to config file (default: `ado-sync.json` in cwd) |
| `AZURE_DEVOPS_TOKEN` | PAT or access token (referenced by `auth.token` in config) |

> **Important:** `ADO_SYNC_CONFIG` must be an **absolute path**. The MCP server process does not inherit the shell's working directory the same way as a CLI call.
