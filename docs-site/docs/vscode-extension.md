# VS Code Extension

The **ado-sync VS Code Extension** brings the full `ado-sync` workflow into your editor — no terminal required for day-to-day tasks.

- **Marketplace:** [PavanMudigonda.ado-sync-vscode](https://marketplace.visualstudio.com/items?itemName=PavanMudigonda.ado-sync-vscode)
- **Source:** [github.com/PavanMudigonda/ado-sync-vscode](https://github.com/PavanMudigonda/ado-sync-vscode)

---

## Requirements

- `ado-sync` npm package (>= 0.1.65) installed globally or as a project dev dependency:
  ```bash
  npm install -g ado-sync
  # or per-project — the extension automatically prefers ./node_modules/.bin/ado-sync
  npm install --save-dev ado-sync
  ```
- An `ado-sync.json` (or `ado-sync.yml` / `ado-sync.yaml`, or `azure-test-sync.*`) config file anywhere in the workspace — the extension does a BFS scan up to 6 levels deep.

---

## Installation

**From VS Code:**
1. Open the Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`)
2. Search for `ado-sync`
3. Click **Install**

**From the CLI:**
```bash
code --install-extension PavanMudigonda.ado-sync-vscode
```

**From the Marketplace:**
Visit the [Marketplace page](https://marketplace.visualstudio.com/items?itemName=PavanMudigonda.ado-sync-vscode) and click **Install**.

---

## Features

### CodeLens

Every `@tc:12345` tag in `.feature` and `.md` files gets inline action links directly above it:

```
[ View TC #12345 in ADO ] [ Fetch TC #12345 ] [ Push All ]
@tc:12345
Scenario: User can log in
```

- **View TC in ADO** — opens the Test Case in your browser
- **Fetch TC** — pulls the latest version of just this test case (tag-scoped `pull --tags @tc:<id>`)
- **Push All** — runs the full `push` for the workspace

Link tags such as `@story:123` and `@bug:456` (whatever you list under `sync.links` in config) get their own CodeLens row with **View in ADO** and **Story Context** entries that call `story-context` for that ID.

Toggle CodeLens on/off with the `ado-sync.showCodeLens` setting.

### Hover Tooltips

Hover over any `@tc:12345` tag to see a tooltip with a direct link to the Azure DevOps Test Case.

### Sidebar Tree View

The **Testing** panel (`Ctrl+Shift+T`) includes an **ADO Test Cases** tree:

- Lists all spec files in the workspace that contain `@tc:` tags
- Each file expands to show its linked test cases with line numbers
- Click an entry to jump to the line in the editor

### Status Bar

The status bar item shows the current sync state of the workspace. Click it to run `ado-sync status` and refresh. While **Watch** is running it switches to `$(eye) ado-sync: watching` and clicking it stops the watcher.

---

## Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and type `ado-sync`:

| Command | Underlying CLI | Description |
|---|---|---|
| `ado-sync: Push` | `push` | Push local spec changes to Azure DevOps (creates new TCs, updates existing) |
| `ado-sync: Push (Dry Run)` | `push --dry-run` | Preview what push would do — no changes applied |
| `ado-sync: Pull` | `pull` | Pull Azure DevOps changes back into local spec files |
| `ado-sync: Pull (Dry Run)` | `pull --dry-run` | Preview what pull would do — no changes applied |
| `ado-sync: Status` | `status` | Show a diff of local vs. Azure DevOps state |
| `ado-sync: Diff` | `diff` | Field-level diff between local specs and ADO |
| `ado-sync: Validate Config` | `validate` | Verify the config file and test the Azure DevOps connection |
| `ado-sync: Initialize Config` | `init` | Scaffold an `ado-sync.json` or `ado-sync.yml` in the workspace root |
| `ado-sync: Show Resolved Config` | `config show` | Dump the fully resolved config (token redacted) to the Output panel |
| `ado-sync: Generate Spec from Story` | `generate` | Prompt for User Story IDs and generate `.feature` or `.md` spec files |
| `ado-sync: Show Story Context` | `story-context` | Show AC items, suggested tags, and linked test cases for a story |
| `ado-sync: Fetch Test Case` | `pull --tags @tc:<id>` | Refresh the local spec for a single test case |
| `ado-sync: Publish Test Results` | `publish-test-results` | Upload a result file (JUnit XML, TRX, NUnit, Playwright JSON, Cucumber JSON, CTRF) |
| `ado-sync: Detect Stale Test Cases` | `stale` | List ADO Test Cases that have no corresponding local spec |
| `ado-sync: Show Coverage Report` | `coverage` | Spec link rate and story coverage % |
| `ado-sync: AC Gate (validate stories)` | `ac-gate` | Validate that User Stories have AC and linked TCs (CI gate; supports story IDs / area path / WIQL scopes) |
| `ado-sync: Test Run Trend Report` | `trend` | Detect flaky tests and failure patterns over the last N days |
| `ado-sync: Find Recently Tagged Work Items` | `find-tagged` | List work items where a tag was added in the last N hours/days |
| `ado-sync: Start Watch` | `watch` | Auto-push local spec changes on file save (status bar reflects active watch) |
| `ado-sync: Stop Watch` | — | Stop the running watch process |

All command output goes to the **ado-sync** Output Channel (View → Output → select `ado-sync` from the dropdown).

---

## Settings

Configure via VS Code Settings (`Ctrl+,` → search `ado-sync`) or directly in `settings.json`:

| Setting | Type | Default | Description |
|---|---|---|---|
| `ado-sync.configPath` | `string` | `""` | Path to the config file, relative to the workspace root. Empty = auto-detect (`ado-sync.json` / `ado-sync.yml` / `azure-test-sync.*`). |
| `ado-sync.showCodeLens` | `boolean` | `true` | Show inline CodeLens links above `@tc:` and link tags. |
| `ado-sync.autoStatus` | `boolean` | `false` | Automatically run `ado-sync status` when a spec file is saved. |

Example `settings.json`:
```json
{
  "ado-sync.configPath": "config/ado-sync.json",
  "ado-sync.showCodeLens": true,
  "ado-sync.autoStatus": true
}
```

Output verbosity is controlled at the CLI/config layer — set `toolSettings.outputLevel` (`quiet` / `normal` / `verbose` / `diagnostic`) in `ado-sync.json` and the extension will surface it through the Output panel.

---

## Quick Start

1. Install `ado-sync` globally: `npm install -g ado-sync`
2. In your project root, run `ado-sync init` to generate `ado-sync.json`
3. Fill in your `orgUrl`, `project`, `testPlan.id`, and auth token (see [configuration.md](configuration.md))
4. Install this extension
5. Open a `.feature` or `.md` spec file — CodeLens links appear automatically above each `@tc:` tag
6. Run `ado-sync: Validate Config` from the Command Palette to confirm connectivity
7. Run `ado-sync: Push (Dry Run)` to preview, then `ado-sync: Push` to sync

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| CodeLens not showing | Check `ado-sync.showCodeLens` is `true`; reload the window (`Ctrl+Shift+P` → Reload Window) |
| Commands fail with "ado-sync not found" | Run `npm install -g ado-sync` or ensure it is in your project's `devDependencies` |
| "Config file not found" | Run `ado-sync init` in the workspace root, or set `ado-sync.configPath` |
| Auth errors | Verify `AZURE_DEVOPS_TOKEN` is set in your environment or `.env` file |
| Output channel empty | Set `toolSettings.outputLevel: "verbose"` (or `"diagnostic"`) in `ado-sync.json` for more detail |
| `Fetch Test Case` does nothing for a TC | Make sure your local spec already has `@tc:<id>` matching the requested ID — the command pulls only that tagged scenario |

For CLI-level issues see [troubleshooting.md](troubleshooting.md).
