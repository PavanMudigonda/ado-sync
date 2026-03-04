# ado-sync

Bidirectional sync between local test specs and Azure DevOps Test Cases.

Supports **Cucumber / Gherkin** `.feature` files and **prose Markdown** `.md` spec files.
Inspired by [SpecSync](https://docs.specsolutions.eu/specsync/).

---

## How it works

```
Local files                   ado-sync              Azure DevOps
──────────────                ───────────────              ────────────────
.feature files  ── push ──►  create / update  ──────────► Test Cases
.md spec files  ◄── pull ──  apply changes    ◄────────── (Work Items)
                              write ID back
                              @tc:12345 / <!-- tc: 12345 -->
```

On the **first push** of a scenario, a new Test Case is created in Azure DevOps and its ID is written back into the local file as a tag or comment. Every subsequent push uses that ID to update the existing Test Case. Pulling fetches the latest title and steps from Azure and overwrites the local file.

---

## Installation

```bash
npm install -g ado-sync
# or use locally
npx ado-sync --help
```

---

## Quick start

### 1. Generate a config file

```bash
ado-sync init
```

This creates `ado-sync.json` in the current directory.

### 2. Edit the config

```json
{
  "orgUrl": "https://dev.azure.com/my-org",
  "project": "MyProject",
  "auth": {
    "type": "pat",
    "token": "$AZURE_DEVOPS_TOKEN"
  },
  "testPlan": {
    "id": 1234,
    "suiteId": 5678
  },
  "local": {
    "type": "gherkin",
    "include": "specs/**/*.feature"
  },
  "sync": {
    "tagPrefix": "tc"
  }
}
```

### 3. Set your token

```bash
export AZURE_DEVOPS_TOKEN=your_personal_access_token
```

### 4. Push

```bash
ado-sync push
```

New scenarios are created in Azure DevOps. Their IDs are written back into your local files automatically.

---

## CLI reference

```
ado-sync [options] [command]

Options:
  -c, --config <path>   Path to config file (default: ado-sync.json)
  -V, --version         Print version
  -h, --help            Show help

Commands:
  init [options]        Generate a starter config file
  push [options]        Push local specs to Azure DevOps
  pull [options]        Pull updates from Azure DevOps into local files
  status                Show what would change without making any modifications
  help [command]        Help for a specific command
```

### `init`

```bash
ado-sync init
ado-sync init --output path/to/my-config.json
```

Creates a starter `ado-sync.json`. Safe — will not overwrite an existing file.

---

### `push`

```bash
ado-sync push
ado-sync push --dry-run
ado-sync push --tags "@smoke"
ado-sync push --tags "@smoke and not @wip"
ado-sync -c other-config.json push
```

For every scenario / heading in your local spec files:

| Scenario state | Action |
|----------------|--------|
| No ID tag yet | Creates a new Test Case, writes ID back to file |
| Has ID tag, no changes | Skipped |
| Has ID tag, title or steps changed | Updates the existing Test Case |
| Has ID tag but Test Case deleted in Azure | Reported as error |

`--dry-run` prints what would happen without modifying anything.

---

### `pull`

```bash
ado-sync pull
ado-sync pull --dry-run
ado-sync pull --tags "@smoke"
```

For every locally-linked scenario (has an ID tag):

| Remote state | Action |
|--------------|--------|
| Title or steps changed in Azure | Updates the local file |
| No changes | Skipped |
| Test Case not found | Reported as error |

`--dry-run` prints what would change without modifying local files.

---

### `status`

```bash
ado-sync status
ado-sync status --tags "@smoke"
```

Compares local specs against Azure DevOps and prints a diff — no changes made. Equivalent to `push --dry-run`.

---

## Config file reference

Config files can be JSON (`.json`) or YAML (`.yml` / `.yaml`).

```json
{
  "orgUrl":   "https://dev.azure.com/YOUR_ORG",
  "project":  "YOUR_PROJECT",

  "auth": {
    "type":             "pat",
    "token":            "$AZURE_DEVOPS_TOKEN",
    "applicationIdURI": ""
  },

  "testPlan": {
    "id":      1234,
    "suiteId": 5678
  },

  "local": {
    "type":    "gherkin",
    "include": "specs/**/*.feature",
    "exclude": []
  },

  "sync": {
    "tagPrefix":     "tc",
    "areaPath":      "MyProject\\Team A",
    "iterationPath": "MyProject\\Sprint 1"
  }
}
```

### `orgUrl`
Azure DevOps organisation URL. Format: `https://dev.azure.com/YOUR_ORG`.

### `project`
Azure DevOps project name.

### `auth`

| Field | Description |
|-------|-------------|
| `type` | `"pat"` · `"accessToken"` · `"managedIdentity"` |
| `token` | PAT or access token value. Prefix with `$` to read from an environment variable (e.g. `"$AZURE_DEVOPS_TOKEN"`). |
| `applicationIdURI` | Required only when `type` is `"managedIdentity"`. |

**PAT permissions required:** Test Management (Read & Write), Work Items (Read & Write).

### `testPlan`

| Field | Description |
|-------|-------------|
| `id` | ID of the Azure DevOps Test Plan new test cases are added to. |
| `suiteId` | *(Optional)* ID of the Test Suite within the plan. Defaults to the plan's root suite. |

### `local`

| Field | Description |
|-------|-------------|
| `type` | `"gherkin"` for `.feature` files · `"markdown"` for prose `.md` specs. |
| `include` | Glob pattern(s) relative to the config file. String or array. |
| `exclude` | *(Optional)* Glob pattern(s) to exclude. String or array. |

### `sync`

| Field | Default | Description |
|-------|---------|-------------|
| `tagPrefix` | `"tc"` | Prefix used in ID tags. See [ID tags](#id-tags) below. |
| `areaPath` | *(none)* | Area path for newly created Test Cases. |
| `iterationPath` | *(none)* | Iteration path for newly created Test Cases. |

---

## ID tags

After a scenario is pushed for the first time, ado-sync writes the Azure Test Case ID back into the local file. The format depends on the spec type.

### Gherkin

The ID tag is inserted on its own line immediately above the `Scenario:` keyword, using the `@{tagPrefix}:{id}` convention:

```gherkin
Feature: Login

  @tc:1042
  Scenario: Successful login with valid credentials
    Given I am on the login page
    When I enter username "standard_user" and password "secret_sauce"
    Then I am redirected to the inventory page
```

Tags from the feature or scenario are preserved. The ID tag is always kept as the first tag on the line or alongside existing tags.

### Markdown

The ID comment is inserted on the line immediately after the `### heading`, using `<!-- {tagPrefix}: {id} -->`:

```markdown
### 1. Login (happy path)
<!-- tc: 1042 -->

Assumption: Fresh browser session.

Steps:
1. Enter username `standard_user` in the Username field.
2. Enter password `secret_sauce` in the Password field.
3. Click `Login`.

Expected results:
- User is redirected to `/inventory.html`.
- Product list is visible.

---
```

The comment is invisible when the Markdown is rendered.

### Custom prefix

Change the `sync.tagPrefix` in your config to use a different prefix:

```json
{ "sync": { "tagPrefix": "azure" } }
```

Result:
- Gherkin: `@azure:1042`
- Markdown: `<!-- azure: 1042 -->`

> **Warning:** Changing the prefix on an existing project means all existing ID tags will no longer be recognised. Do a project-wide find-and-replace on the old prefix before changing it.

---

## Tag filtering

All commands accept a `--tags` option to limit which scenarios are synced. The syntax is the standard Cucumber tag expression language.

```bash
# Only sync scenarios tagged @smoke
ado-sync push --tags "@smoke"

# Sync everything except @wip
ado-sync push --tags "not @wip"

# Combine tags with and / or
ado-sync push --tags "@smoke and not @slow"
ado-sync pull --tags "@regression or @critical"
```

Tags are evaluated against all tags on a scenario, including:
- Tags inherited from the Feature block
- Tags on the Scenario / Scenario Outline block
- Tags on individual Examples tables
- **Path-based auto-tags** — directory segments prefixed with `@` are automatically applied as tags to all scenarios in that directory:

  ```
  specs/
    @smoke/
      login.feature       ← all scenarios get tag 'smoke'
    @regression/
      @slow/
        checkout.feature  ← all scenarios get tags 'regression' and 'slow'
  ```

  This lets you filter by folder without adding tags to every scenario manually:
  ```bash
  ado-sync push --tags "@smoke"   # only push specs/@smoke/** scenarios
  ```

> Path-based auto-tagging applies to Gherkin files only. Markdown specs do not have a tag system, so `--tags` has no effect on them.

---

## Spec file formats

### Gherkin `.feature`

Standard Gherkin syntax is supported, including:
- `Feature` / `Scenario` / `Scenario Outline`
- `Given` / `When` / `Then` / `And` / `But`
- Feature-level and scenario-level tags
- `Examples` tables — each row becomes a separate Azure Test Case

```gherkin
Feature: Checkout

  @smoke
  Scenario: Add item and complete checkout
    Given I am logged in as "standard_user"
    When I add "Sauce Labs Backpack" to the cart
    And I proceed through checkout with name "Test User" and zip "12345"
    Then I see the order confirmation page

  Scenario Outline: Checkout with different users
    Given I am logged in as "<user>"
    When I complete a checkout
    Then the result is "<result>"

    Examples:
      | user               | result  |
      | standard_user      | success |
      | performance_glitch_user | success |
```

### Markdown `.md`

Each `### heading` is treated as one test case. The file can contain any number of scenarios separated by `---`.

```markdown
# My Feature Test Plan

## Test scenarios

### Login with valid credentials

Steps:
1. Navigate to https://example.com/login
2. Enter username "admin" and password "secret"
3. Click the Login button

Expected results:
- The dashboard page is shown
- The username appears in the top navigation

---

### Login with invalid credentials

Steps:
1. Navigate to https://example.com/login
2. Enter username "wrong" and password "wrong"
3. Click the Login button

Expected results:
- An error message "Invalid credentials" is displayed
- The user remains on the login page

---
```

Headings can optionally have a number prefix (`### 1. Title` or `### Title` — both work).
Sections recognised: `Steps:`, `Expected results:` (case-insensitive). All other prose is captured as the test case description.

---

## YAML config example

```yaml
orgUrl: https://dev.azure.com/my-org
project: MyProject

auth:
  type: pat
  token: $AZURE_DEVOPS_TOKEN

testPlan:
  id: 1234
  suiteId: 5678

local:
  type: markdown
  include:
    - specs/**/*.md
  exclude:
    - specs/archive/**

sync:
  tagPrefix: tc
  areaPath: "MyProject\\QA Team"
```

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `AZURE_DEVOPS_TOKEN` | PAT or access token. Reference it in config with `"$AZURE_DEVOPS_TOKEN"`. |
| Any name | Any env var can be used — set `auth.token` to `"$MY_VAR_NAME"`. |

You can also use a `.env` file in the working directory. It is loaded automatically.

---

## Output symbols

```
+  created    — new Test Case created in Azure DevOps
~  updated    — existing Test Case updated
↓  pulled     — local file updated from Azure DevOps
=  skipped    — no changes detected
!  conflict   — both sides changed (manual resolution needed)
✗  error      — something went wrong (see detail message)
```

---

## Workflow examples

### First-time setup

```bash
# Generate config
ado-sync init

# Edit ado-sync.json with your org, project, plan ID, and token
export AZURE_DEVOPS_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Preview what will be created
ado-sync push --dry-run

# Create test cases in Azure DevOps
ado-sync push
```

### Day-to-day: local changes first

```bash
# Edit your .feature or .md files locally
# Then push changes to Azure DevOps
ado-sync push
```

### Day-to-day: Azure changes first

```bash
# Someone edited a test case in Azure DevOps Test Plans UI
# Pull the changes into your local files
ado-sync pull
```

### Check for drift before a PR

```bash
ado-sync status
```

---

## Troubleshooting

**`No config file found`**
Run `ado-sync init` or pass `-c path/to/config.json`.

**`Environment variable 'X' is not set`**
Your config references `$X` in `auth.token` but the variable is not exported. Run `export X=...` or add it to a `.env` file.

**Test Case created but ID not written back**
Check that the local file is writable. On the next `push` it will try again.

**`Test case #N not found in Azure DevOps`**
The test case was deleted in Azure. Remove the ID tag from the local file to recreate it, or restore the test case in Azure.

**`Failed to parse <file>`**
Gherkin syntax error in a `.feature` file. Run `npx cucumber-js --dry-run` to identify the problem line.

**Changes not detected on push**
The comparison is title + step text. Changing only description or area path requires a manual update via `ado-sync push` after touching a step.
