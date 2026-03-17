# ado-sync

Bidirectional sync between local test specs and Azure DevOps Test Cases.

Supports a wide range of test file formats and frameworks:

| `local.type` | Framework / Format | Files | Example config |
|---|---|---|---|
| `gherkin` | Cucumber / Gherkin | `.feature` | |
| `markdown` | Prose specs, Playwright test plans | `.md` | |
| `csharp` | MSTest | `.cs` | [csharp-mstest.yaml](docs/examples/csharp-mstest.yaml) · [local LLM](docs/examples/csharp-mstest-local-llm.yaml) |
| `csharp` | NUnit | `.cs` | [csharp-nunit.yaml](docs/examples/csharp-nunit.yaml) |
| `csharp` | SpecFlow (Gherkin) | `.feature` | [csharp-specflow.yaml](docs/examples/csharp-specflow.yaml) |
| `java` | JUnit 4, JUnit 5 | `.java` | [java-junit.yaml](docs/examples/java-junit.yaml) |
| `java` | TestNG + Selenium | `.java` | [java-testng.yaml](docs/examples/java-testng.yaml) |
| `python` | pytest + Selenium | `.py` | [python-pytest.yaml](docs/examples/python-pytest.yaml) |
| `javascript` | Jest | `.js` / `.ts` | [js-jest.yaml](docs/examples/js-jest.yaml) |
| `javascript` | Jasmine / WebdriverIO | `.js` / `.ts` | [js-jasmine-wdio.yaml](docs/examples/js-jasmine-wdio.yaml) |
| `playwright` | Playwright Test (TypeScript) | `.spec.ts` | [playwright-ts.yaml](docs/examples/playwright-ts.yaml) |
| `playwright` | Playwright Test (JavaScript) | `.spec.js` | [playwright-js.yaml](docs/examples/playwright-js.yaml) |
| `puppeteer` | Puppeteer + Jest or Mocha | `.js` / `.ts` | [puppeteer.yaml](docs/examples/puppeteer.yaml) |
| `cypress` | Cypress | `.cy.js` / `.cy.ts` | [cypress.yaml](docs/examples/cypress.yaml) |
| `testcafe` | TestCafe | `.js` / `.ts` | [testcafe.yaml](docs/examples/testcafe.yaml) |
| `detox` | Detox (React Native E2E) | `.js` / `.ts` | [detox-react-native.yaml](docs/examples/detox-react-native.yaml) |
| `espresso` | Android Espresso (JUnit 4 / Kotlin) | `.java` / `.kt` | [espresso-android.yaml](docs/examples/espresso-android.yaml) |
| `xcuitest` | iOS / macOS XCUITest | `.swift` | [xcuitest-ios.yaml](docs/examples/xcuitest-ios.yaml) |
| `flutter` | Flutter widget & integration tests | `_test.dart` | [flutter-dart.yaml](docs/examples/flutter-dart.yaml) |
| `robot` | Robot Framework | `.robot` | [robot-framework.yaml](docs/examples/robot-framework.yaml) |
| Appium | Use `javascript` / `java` / `python` / `csharp` | depends on language binding | |
| `csv` | Azure DevOps tabular export | `.csv` | |
| `excel` | Azure DevOps tabular export | `.xlsx` | |

Inspired by [SpecSync](https://docs.specsolutions.eu/specsync/).

Also available as a **[VS Code Extension](https://marketplace.visualstudio.com/items?itemName=PavanMudigonda.ado-sync-vscode)** — CodeLens, sidebar tree, status bar, and all commands without leaving the editor.

---

## How it works

```
Local files                    ado-sync              Azure DevOps
──────────────                 ─────────────────     ────────────────
.feature files   ── push ──►  create / update  ──►  Test Cases
.md spec files   ◄── pull ──  apply changes    ◄──  (Work Items)
.cs / .java /    ── push ──►  (push-only)      ──►  + Associated Automation
.py / .js / .ts
.robot / .csv    ── push ──►  (push-only)
                               write ID back
                               @tc:12345 / [TestProperty] / @Tag / @pytest.mark / // @tc:
TRX / JUnit /    ── publish-test-results ──►   Test Run results (linked to TCs)
Cucumber JSON
```

On the **first push**, a new Test Case is created in Azure DevOps and its ID is written back into the local file. Every subsequent push uses that ID to update the existing Test Case.

---

## Quick start

**1 — Install**

```bash
npm install -g ado-sync
# or run once without installing
npx ado-sync --help
```

**2 — Generate a config file**

```bash
ado-sync init              # interactive wizard → creates ado-sync.json
ado-sync init ado-sync.yml # YAML format
```

**3 — Fill in your details**

```json
{
  "orgUrl": "https://dev.azure.com/YOUR-ORG",
  "project": "YOUR-PROJECT-NAME",
  "auth": { "type": "pat", "token": "$AZURE_DEVOPS_TOKEN" },
  "testPlan": { "id": 12345 },
  "local": { "type": "gherkin", "include": "specs/**/*.feature" }
}
```

| Field | Where to find it |
|-------|-----------------|
| `orgUrl` | Azure DevOps → top-left org name → `https://dev.azure.com/<org>` |
| `project` | Azure DevOps → your project name (shown in the breadcrumb) |
| `testPlan.id` | Test Plans → click your plan → the number in the URL |
| `AZURE_DEVOPS_TOKEN` | Azure DevOps → User Settings → Personal Access Tokens → New Token (scope: Test Management read/write) |

**4 — Set your token**

```bash
export AZURE_DEVOPS_TOKEN=your_personal_access_token
# or add it to a .env file in this directory
```

**5 — Preview then push**

```bash
ado-sync push --dry-run   # preview — no changes made
ado-sync push             # create / update Test Cases in Azure DevOps
```

---

**6 — Publish test results**

```bash
ado-sync publish-test-results --testResult results/junit.xml --testResultFormat junit
```

See [docs/publish-test-results.md](docs/publish-test-results.md) for TRX, NUnit, Playwright JSON, Cucumber JSON, and attachment options.

---

**7 — VS Code Extension**

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/PavanMudigonda.ado-sync-vscode?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=PavanMudigonda.ado-sync-vscode)

Use all commands, CodeLens, sidebar tree, and status bar directly inside VS Code — no terminal needed.

See [docs/vscode-extension.md](docs/vscode-extension.md) for installation, commands, and settings.

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
| **AI agent setup guide** (framework detection → config → validate → push) | [docs/agent-setup.md](docs/agent-setup.md) |
| CLI reference (all commands and flags) | [docs/cli.md](docs/cli.md) |
| Full configuration reference | [docs/configuration.md](docs/configuration.md) |
| Spec file formats (Gherkin, Markdown, C#, CSV, Excel, JS/TS) | [docs/spec-formats.md](docs/spec-formats.md) |
| Framework workflow examples (C#, Java, Python, Playwright, Robot, CI) | [docs/workflows.md](docs/workflows.md) |
| Work Item Links (User Story, Bug, etc.) | [docs/work-item-links.md](docs/work-item-links.md) |
| Publishing test results | [docs/publish-test-results.md](docs/publish-test-results.md) |
| Advanced features (format, state, fieldUpdates, attachments, AI, CI) | [docs/advanced.md](docs/advanced.md) |
| MCP Server (use ado-sync from AI agents) | [docs/mcp-server.md](docs/mcp-server.md) |
| **VS Code Extension** | [docs/vscode-extension.md](docs/vscode-extension.md) |
| Troubleshooting | [docs/troubleshooting.md](docs/troubleshooting.md) |

> **AI models / LLM crawlers:** [`llms.txt`](llms.txt) contains a flat single-file summary of this entire project — framework type mappings, config schema, CLI flags, ID writeback formats, and the full doc index. Read that first.
