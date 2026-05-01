# VS Code Extension

The **ado-sync VS Code Extension** brings the full `ado-sync` workflow into your editor — no terminal required for day-to-day tasks.

- **Marketplace:** [PavanMudigonda.ado-sync-vscode](https://marketplace.visualstudio.com/items?itemName=PavanMudigonda.ado-sync-vscode)
- **Source:** [github.com/PavanMudigonda/ado-sync-vscode](https://github.com/PavanMudigonda/ado-sync-vscode)

---

## Requirements

- `ado-sync` npm package installed globally:
  ```bash
  npm install -g ado-sync
  ```
  Or as a dev dependency in your project (`npx ado-sync` is used automatically).
- An `ado-sync.json` (or `ado-sync.yml`) config file in the workspace root.

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
[ View in ADO ] [ Push ] [ Fetch ]
@tc:12345
Scenario: User can log in
```

- **View in ADO** — opens the Test Case in your browser
- **Push** — pushes only this test case to Azure DevOps
- **Fetch** — retrieves the latest version of this test case from ADO

Toggle CodeLens on/off with the `ado-sync.showCodeLens` setting.

### Hover Tooltips

Hover over any `@tc:12345` tag to see a tooltip with a direct link to the Azure DevOps Test Case.

### Sidebar Tree View

The **Testing** panel (`Ctrl+Shift+T`) includes an **ADO Test Cases** tree:

- Lists all spec files in the workspace that contain `@tc:` tags
- Each file expands to show its linked test cases with line numbers
- Click an entry to jump to the line in the editor

### Status Bar

The status bar item shows the current sync state of the workspace. Click it to run `ado-sync status` and refresh.

---

## Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and type `ado-sync`:

| Command | Description |
|---|---|
| `ado-sync: Push` | Push all local spec changes to Azure DevOps (creates new TCs, updates existing) |
| `ado-sync: Push (Dry Run)` | Preview what push would do — no changes applied |
| `ado-sync: Pull` | Pull Azure DevOps changes back into local spec files |
| `ado-sync: Pull (Dry Run)` | Preview what pull would do — no changes applied |
| `ado-sync: Status` | Show a diff of local vs. Azure DevOps state |
| `ado-sync: Validate Config` | Verify the config file and test the Azure DevOps connection |
| `ado-sync: Generate Spec from Story` | Prompt for a User Story ID and generate a `.feature` or `.md` spec file |
| `ado-sync: Fetch Test Case` | Prompt for a Test Case ID and retrieve it from Azure DevOps |
| `ado-sync: Publish Test Results` | Upload a result file (JUnit XML, TRX, NUnit, Playwright JSON, Cucumber JSON, CTRF) |

All command output goes to the **ado-sync** Output Channel (View → Output → select `ado-sync` from the dropdown).

---

## Settings

Configure via VS Code Settings (`Ctrl+,` → search `ado-sync`) or directly in `settings.json`:

| Setting | Type | Default | Description |
|---|---|---|---|
| `ado-sync.configPath` | `string` | `""` | Path to the config file, relative to the workspace root. Empty = auto-detect (`ado-sync.json` / `ado-sync.yml`). |
| `ado-sync.showCodeLens` | `boolean` | `true` | Show inline CodeLens links above `@tc:` tags. |
| `ado-sync.autoStatus` | `boolean` | `false` | Automatically run `ado-sync status` when a spec file is saved. |
| `ado-sync.outputLevel` | `string` | `"normal"` | Output verbosity: `"normal"`, `"verbose"`, or `"quiet"`. |

Example `settings.json`:
```json
{
  "ado-sync.configPath": "config/ado-sync.json",
  "ado-sync.showCodeLens": true,
  "ado-sync.autoStatus": true,
  "ado-sync.outputLevel": "verbose"
}
```

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
| Output channel empty | Set `ado-sync.outputLevel` to `"verbose"` for more detail |

For CLI-level issues see [troubleshooting.md](troubleshooting.md).
