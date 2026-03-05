# ado-sync

Bidirectional sync between local test specs and Azure DevOps Test Cases.

Supports **Cucumber / Gherkin** `.feature` files, **prose Markdown** `.md` spec files (including Playwright test-plan markdown), **C# MSTest** `.cs` test files, and **Azure DevOps tabular exports** in **CSV** and **Excel** (`.xlsx`) format.
Inspired by [SpecSync](https://docs.specsolutions.eu/specsync/).

---

## How it works

```
Local files                   ado-sync              Azure DevOps
──────────────                ─────────────────     ────────────────
.feature files  ── push ──►  create / update  ──►  Test Cases
.md spec files  ◄── pull ──  apply changes    ◄──  (Work Items)
.cs files       ── push ──►  (push-only)      ──►  + Associated Automation
.csv files      ── push ──►  (push-only)
.xlsx files     ── push ──►  (push-only)
                              write ID back
                              @tc:12345 / [TestProperty("tc","…")] / col A
TRX / JUnit /   ── publish-test-results ──►   Test Run results (linked to TCs)
Cucumber JSON
```

On the **first push**, a new Test Case is created in Azure DevOps and its ID is written back into the local file. Every subsequent push uses that ID to update the existing Test Case. For C# MSTest tests, the ID is written as `[TestProperty("tc", "12345")]` so TRX results published via `publish-test-results` can be linked back to the right Test Cases.

---

## Installation

```bash
npm install -g ado-sync
# or run without installing
npx ado-sync --help
```

---

## Quick start

```bash
# 1. Generate a config file
ado-sync init              # creates ado-sync.json
ado-sync init ado-sync.yml # YAML format

# 2. Edit the config with your org, project, plan ID, and token
export AZURE_DEVOPS_TOKEN=your_personal_access_token

# 3. Preview what will be created
ado-sync push --dry-run

# 4. Push to Azure DevOps
ado-sync push
```

Minimal config:

```json
{
  "orgUrl": "https://dev.azure.com/my-org",
  "project": "MyProject",
  "auth": { "type": "pat", "token": "$AZURE_DEVOPS_TOKEN" },
  "testPlan": { "id": 1234 },
  "local": { "type": "gherkin", "include": "specs/**/*.feature" }
}
```

---

## CLI reference

```
ado-sync [options] [command]

Options:
  -c, --config <path>   Path to config file (default: ado-sync.json)
  -V, --version         Print version
  -h, --help            Show help

Commands:
  init [output]                Generate a starter config file
  push [options]               Push local specs to Azure DevOps
  pull [options]               Pull updates from Azure DevOps into local files
  status [options]             Show diff without making changes
  publish-test-results [opts]  Publish TRX / JUnit / Cucumber JSON results to Azure DevOps
  help [command]               Help for a specific command
```

### `init`

```bash
ado-sync init                    # creates ado-sync.json
ado-sync init ado-sync.yml       # YAML format
```

### `push`

```bash
ado-sync push
ado-sync push --dry-run
ado-sync push --tags "@smoke and not @wip"
ado-sync push --config-override testPlan.id=9999
```

| Scenario state | Action |
|----------------|--------|
| No ID tag | Creates a new Test Case, writes ID back |
| ID tag, no changes | Skipped |
| ID tag, content changed | Updates the existing Test Case |
| Deleted locally, still in Azure suite | Tagged `ado-sync:removed` in Azure |

### `pull`

```bash
ado-sync pull
ado-sync pull --dry-run
ado-sync pull --tags "@smoke"
```

### `status`

```bash
ado-sync status
ado-sync status --tags "@smoke"
```

Compares local specs against Azure DevOps and prints a diff — no changes made.

### `publish-test-results`

```bash
ado-sync publish-test-results --testResult results/test.trx
ado-sync publish-test-results --testResult results/test.xml --testResultFormat junit --dry-run
```

See [docs/publish-test-results.md](docs/publish-test-results.md) for full reference.

### `--config-override`

All commands accept `--config-override path=value` to set config values without editing the file:

```bash
ado-sync push --config-override testPlan.id=9999
ado-sync push --config-override sync.disableLocalChanges=true
```

---

## Output symbols

```
+  created    — new Test Case created in Azure DevOps
~  updated    — existing Test Case updated
↓  pulled     — local file updated from Azure DevOps
=  skipped    — no changes detected
!  conflict   — both sides changed (see conflictAction)
−  removed    — local scenario deleted; Test Case tagged ado-sync:removed in Azure
✗  error      — something went wrong (see detail message)
```

---

## Documentation

| Topic | Link |
|-------|------|
| Full configuration reference | [docs/configuration.md](docs/configuration.md) |
| Spec file formats (Gherkin, Markdown, C# MSTest, CSV, Excel) | [docs/spec-formats.md](docs/spec-formats.md) |
| Advanced features (format, state, fieldUpdates, customizations, attachments, CI mode) | [docs/advanced.md](docs/advanced.md) |
| Publishing test results | [docs/publish-test-results.md](docs/publish-test-results.md) |

---

## Workflow examples

### Day-to-day: local changes first

```bash
# Edit your .feature or .md files, then push
ado-sync push
```

### Day-to-day: Azure changes first

```bash
# Someone edited a Test Case in the Azure DevOps UI
ado-sync pull
```

### C# MSTest / NUnit: create TCs, run tests, publish results

```bash
# 1. Create TCs and write IDs back into .cs files
ado-sync push --dry-run   # preview
ado-sync push             # writes [TestProperty("tc","ID")] / [Property("tc","ID")]

# 2a. MSTest — TRX contains [TestProperty] values; TC IDs extracted automatically
dotnet test --logger "trx;LogFileName=results.trx"
ado-sync publish-test-results --testResult results/results.trx

# 2b. NUnit — use native XML logger so [Property("tc","ID")] values are included
dotnet test --logger "nunit3;LogFileName=results.xml"
ado-sync publish-test-results --testResult results/results.xml
```

Recommended `ado-sync.json` for C# MSTest:

```json
{
  "orgUrl": "https://dev.azure.com/my-org",
  "project": "MyProject",
  "auth": { "type": "pat", "token": "$AZURE_DEVOPS_TOKEN" },
  "testPlan": { "id": 1234 },
  "local": {
    "type": "csharp",
    "include": ["**/RegressionTests/**/*.cs"],
    "exclude": ["**/*BaseTest.cs", "**/*Helper.cs"]
  },
  "sync": {
    "markAutomated": true,
    "format": { "useExpectedResult": true }
  }
}
```

### CI pipeline

```yaml
# GitHub Actions
- name: Sync test cases to Azure DevOps
  run: ado-sync push --config-override sync.disableLocalChanges=true
  env:
    AZURE_DEVOPS_TOKEN: ${{ secrets.AZURE_DEVOPS_TOKEN }}

- name: Publish test results
  run: ado-sync publish-test-results --testResult results/test.trx
  env:
    AZURE_DEVOPS_TOKEN: ${{ secrets.AZURE_DEVOPS_TOKEN }}
```

### Check for drift before a PR

```bash
ado-sync status
```

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `AZURE_DEVOPS_TOKEN` | PAT or access token. Reference in config with `"$AZURE_DEVOPS_TOKEN"`. |
| Any name | Any env var — set `auth.token` to `"$MY_VAR_NAME"`. |

A `.env` file in the working directory is loaded automatically.

---

## Troubleshooting

**`No config file found`**
Run `ado-sync init` or pass `-c path/to/config.json`.

**`Environment variable 'X' is not set`**
Your config references `$X` in `auth.token` but the variable is not exported. Run `export X=...` or add it to a `.env` file.

**Test Case created but ID not written back**
Check that the file is writable, or that `sync.disableLocalChanges` is not `true`.

**`Test case #N not found in Azure DevOps`**
The test case was deleted in Azure. Remove the ID tag from the local file to recreate it, or restore the test case in Azure.

**`Failed to parse <file>`**
Gherkin syntax error. Run `npx cucumber-js --dry-run` to identify the problem line.

**Changes not detected on push**
The comparison uses title + steps + description. Touch any step to force an update, or reset the cache by deleting `.ado-sync-state.json`.

**Conflict detected unexpectedly**
Delete `.ado-sync-state.json` to reset the cache. The next push re-populates it from Azure.

**CSV/Excel IDs not written back**
Ensure the file is not open in another application. Check that `sync.disableLocalChanges` is not `true`.

**Excel file not parsed / `No worksheet found`**
ado-sync looks for `xl/worksheets/sheet.xml` or `xl/worksheets/sheet1.xml` inside the xlsx ZIP. Re-export from Azure DevOps to get a compatible file.

**Pull has no effect on CSV/Excel files**
Pull is not supported for CSV and Excel — only push. These formats are managed by external tools.

**C# categories show as constant names instead of values**
ado-sync resolves `const string` declarations in the same file. Constants defined in a base class are not resolved — use string literals in `[TestCategory("...")]` for reliable tagging.

**C# test methods not detected**
Ensure the method has `[TestMethod]` on its own line. Nested classes or abstract base methods are not parsed. Add base class files to `local.exclude`.

**TRX results not linked to Test Cases**
For MSTest, TC IDs are read directly from `[TestProperty("tc","ID")]` embedded in the TRX — no further config needed. For NUnit, use `--logger "nunit3;LogFileName=results.xml"` (native XML format) instead of TRX so `[Property("tc","ID")]` values are included. If neither is available, set `sync.markAutomated: true` and rely on `AutomatedTestName` FQMN matching.
