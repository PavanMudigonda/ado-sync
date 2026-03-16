# Agent Setup Guide

This document is written for AI agents (Claude Code, GitHub Copilot, Cursor, etc.) to autonomously set up `ado-sync` for a user. Follow the steps in order.

---

## Step 1 — Detect the test framework

Scan the user's repository for these file patterns and map to a `local.type`:

| If you find... | Use `local.type` | Default include glob |
|---|---|---|
| `*.feature` files + `*.cs` project files | `gherkin` (SpecFlow) | `Features/**/*.feature` |
| `*.feature` files (no .cs) | `gherkin` | `specs/**/*.feature` or `features/**/*.feature` |
| `*.md` files with `### ` headings in a specs folder | `markdown` | `specs/**/*.md` |
| `*.cs` + `[TestMethod]` or `[Test]` annotations | `csharp` | `**/Tests/**/*.cs` |
| `*.java` + `@Test` + JUnit/TestNG imports | `java` | `**/src/test/**/*.java` |
| `*.py` + `def test_` functions | `python` | `tests/**/*.py` |
| `*.spec.ts` or `*.spec.js` + `@playwright/test` import | `playwright` | `tests/**/*.spec.ts` |
| `*.cy.ts` or `*.cy.js` + `cypress/` folder | `cypress` | `cypress/e2e/**/*.cy.ts` |
| `*.test.ts` or `*.test.js` + jest config / `jest` in package.json | `javascript` | `src/**/*.test.ts` |
| `*.test.ts` + `detox` in package.json | `detox` | `e2e/**/*.test.ts` |
| `*.java` or `*.kt` in `androidTest/` | `espresso` | `app/src/androidTest/**/*.java` |
| `*.swift` + `XCUIApplication` usage | `xcuitest` | `UITests/**/*.swift` |
| `*_test.dart` + `flutter_test` import | `flutter` | `test/**/*_test.dart` |
| `*.robot` files | `robot` | `tests/**/*.robot` |

If none of the above match, ask the user which framework they use.

---

## Step 2 — Collect required config values

Ask the user (or read from their existing environment) for these four values:

| Value | How to find it | Example |
|---|---|---|
| **Azure DevOps org URL** | The base URL to their ADO org | `https://dev.azure.com/contoso` |
| **Project name** | The ADO project name, visible in the breadcrumb | `MyProject` |
| **Test Plan ID** | Test Plans → click the plan → number in the URL (`?planId=42`) | `42` |
| **PAT token** | ADO → User Settings → Personal Access Tokens → New Token, scope: **Test Management Read & Write** + **Work Items Read** | (secret) |

If the user already has `AZURE_DEVOPS_TOKEN` in their environment or `.env`, use that — do not ask again.

---

## Step 3 — Generate the config file

Write `ado-sync.json` in the project root with these values:

```json
{
  "orgUrl": "<orgUrl>",
  "project": "<project>",
  "auth": { "type": "pat", "token": "$AZURE_DEVOPS_TOKEN" },
  "testPlan": { "id": <planId> },
  "local": {
    "type": "<local.type>",
    "include": ["<include glob>"],
    "exclude": []
  },
  "sync": { "markAutomated": true }
}
```

For code-based types (`csharp`, `java`, `python`, `javascript`, `playwright`, `cypress`, `detox`, `espresso`, `xcuitest`, `flutter`), always include `"markAutomated": true` — it links the Test Case to the automation method in Azure DevOps.

Add reasonable excludes based on the framework:

| local.type | Suggested excludes |
|---|---|
| `csharp` | `["**/*BaseTest.cs", "**/*Helper.cs", "**/*Fixture.cs"]` |
| `java` | `["**/*BaseTest.java", "**/*Helper.java", "**/*Base.java"]` |
| `python` | `["tests/conftest.py", "tests/**/helpers.py", "tests/**/fixtures.py"]` |
| `playwright` | `["**/*.helper.ts", "**/*.fixtures.ts"]` |
| `javascript` | `["**/*.helper.ts", "**/*.util.ts"]` |
| `robot` | `["tests/resources/**"]` |

---

## Step 4 — Set the token

If the user has not already exported `AZURE_DEVOPS_TOKEN`, add it to a `.env` file:

```
AZURE_DEVOPS_TOKEN=<their-token>
```

Add `.env` to `.gitignore` if not already present.

---

## Step 5 — Validate the setup

Run:

```bash
ado-sync validate
```

Expected output:
```
  ✓ Config is valid
  ✓ Azure connection established
  ✓ Project "..." found
  ✓ Test Plan ... found
All checks passed.
```

If any check fails:

| Error | Fix |
|---|---|
| `Authentication failed` | Token is wrong or expired — generate a new PAT |
| `Access denied` | PAT is missing Test Management or Work Items scope |
| `Project not found` | `project` field has a typo — check the ADO breadcrumb |
| `Test Plan not found` | Wrong `testPlan.id` — check the URL on the Test Plans page |
| `Config error` | Missing required field — check the error message and fix `ado-sync.json` |

---

## Step 6 — Preview, then push

```bash
# Show what will be created — no changes made
ado-sync push --dry-run

# Create Test Cases in Azure DevOps and write IDs back into files
ado-sync push
```

After push, each test file will have an ID written back (e.g. `@tc:12345`). Commit these changes.

---

## Step 7 — (Optional) Set up CI

For GitHub Actions, add to `.github/workflows/test.yml`:

```yaml
- name: Push test cases to Azure DevOps
  run: ado-sync push --config-override sync.disableLocalChanges=true
  env:
    AZURE_DEVOPS_TOKEN: ${{ secrets.AZURE_DEVOPS_TOKEN }}

- name: Publish test results
  run: ado-sync publish-test-results --testResult results/junit.xml --testResultFormat junit
  env:
    AZURE_DEVOPS_TOKEN: ${{ secrets.AZURE_DEVOPS_TOKEN }}
```

Use `sync.disableLocalChanges=true` in CI so the pipeline never commits ID writeback files.

Add `AZURE_DEVOPS_TOKEN` to the repository's GitHub secrets (Settings → Secrets → Actions).

---

## Step 8 — (Optional) Register the MCP server

If the user is using Claude Code, Cursor, or VS Code with GitHub Copilot, register the MCP server so the AI can manage sync operations directly without CLI invocations.

**Claude Code** — add to `~/.claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "ado-sync": {
      "command": "ado-sync-mcp",
      "env": {
        "AZURE_DEVOPS_TOKEN": "<token>",
        "ADO_SYNC_CONFIG": "<absolute path to ado-sync.json>"
      }
    }
  }
}
```

See [mcp-server.md](mcp-server.md) for VS Code and Cursor instructions.

---

## Quick decision tree

```
User has test files?
  ├─ .feature → local.type: gherkin (or gherkin for SpecFlow)
  ├─ .cs      → local.type: csharp
  ├─ .java    → local.type: java (or espresso if in androidTest/)
  ├─ .py      → local.type: python
  ├─ .spec.ts/js → local.type: playwright (if @playwright/test) or javascript
  ├─ .cy.ts/js   → local.type: cypress
  ├─ .test.ts/js → local.type: javascript (or detox if detox in package.json)
  ├─ .swift   → local.type: xcuitest
  ├─ _test.dart → local.type: flutter
  ├─ .robot   → local.type: robot
  └─ .md      → local.type: markdown

Token available?
  ├─ Yes (env var) → write "$AZURE_DEVOPS_TOKEN" in config
  └─ No → ask user, write to .env, add .env to .gitignore

Run: ado-sync validate → all green?
  ├─ Yes → ado-sync push --dry-run → ado-sync push → commit ID writebacks
  └─ No  → fix the failing check (see Step 5 error table above)
```
