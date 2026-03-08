# ado-sync

Bidirectional sync between local test specs and Azure DevOps Test Cases.

Supports a wide range of test file formats and frameworks:

| `local.type` | Framework / Format | Files |
|---|---|---|
| `gherkin` | Cucumber / Gherkin | `.feature` |
| `markdown` | Prose specs, Playwright test plans | `.md` |
| `csharp` | MSTest, NUnit | `.cs` |
| `java` | JUnit 4, JUnit 5, TestNG + Selenium | `.java` |
| `python` | pytest + Selenium | `.py` |
| `javascript` | Jest, Jasmine, WebdriverIO | `.js` / `.ts` |
| `playwright` | Playwright Test | `.js` / `.ts` |
| `puppeteer` | Puppeteer + Jest or Mocha | `.js` / `.ts` |
| `cypress` | Cypress | `.cy.js` / `.cy.ts` |
| `testcafe` | TestCafe | `.js` / `.ts` |
| `detox` | Detox (React Native E2E) | `.js` / `.ts` |
| `espresso` | Android Espresso (JUnit 4 / Kotlin) | `.java` / `.kt` |
| `xcuitest` | iOS / macOS XCUITest | `.swift` |
| `flutter` | Flutter widget & integration tests | `_test.dart` |
| Appium | Use `javascript` / `java` / `python` / `csharp` | depends on language binding |
| `csv` | Azure DevOps tabular export | `.csv` |
| `excel` | Azure DevOps tabular export | `.xlsx` |

Inspired by [SpecSync](https://docs.specsolutions.eu/specsync/).

---

## How it works

```
Local files                    ado-sync              Azure DevOps
──────────────                 ─────────────────     ────────────────
.feature files   ── push ──►  create / update  ──►  Test Cases
.md spec files   ◄── pull ──  apply changes    ◄──  (Work Items)
.cs files        ── push ──►  (push-only)      ──►  + Associated Automation
.java files      ── push ──►  (push-only)      ──►  + Associated Automation
.py files        ── push ──►  (push-only)      ──►  + Associated Automation
.js / .ts files  ── push ──►  (push-only)      ──►  + Associated Automation
.csv files       ── push ──►  (push-only)
.xlsx files      ── push ──►  (push-only)
                               write ID back
                               @tc:12345 / [TestProperty] / @Tag / @pytest.mark / // @tc:
TRX / JUnit /    ── publish-test-results ──►   Test Run results (linked to TCs)
Cucumber JSON
```

On the **first push**, a new Test Case is created in Azure DevOps and its ID is written back into the local file. Every subsequent push uses that ID to update the existing Test Case.

**ID writeback format per framework:**

| Framework | ID written as |
|---|---|
| Gherkin / Markdown | `@tc:12345` tag / comment |
| C# MSTest | `[TestProperty("tc", "12345")]` |
| C# NUnit | `[Property("tc", "12345")]` |
| Java JUnit 4 / TestNG | `// @tc:12345` comment above `@Test` |
| Java JUnit 5 | `@Tag("tc:12345")` above `@Test` |
| Python pytest | `@pytest.mark.tc(12345)` above `def test_*` |
| JavaScript/TS (Jest/Jasmine/WebdriverIO) | `// @tc:12345` comment above `it()`/`test()` |
| Playwright | `annotation: { type: 'tc', description: '12345' }` in test options *(preferred)*; or `// @tc:12345` comment fallback |
| Puppeteer | `// @tc:12345` comment above `it()`/`test()` |
| Cypress | `// @tc:12345` comment above `it()`/`specify()` |
| TestCafe | `test.meta('tc', '12345')('title', fn)` *(preferred)*; or `// @tc:12345` comment fallback |
| Detox | `// @tc:12345` comment above `it()`/`test()` |
| Espresso (Java/Kotlin) | `// @tc:12345` comment above `@Test` |
| XCUITest (Swift) | `// @tc:12345` comment above `func test*()` |
| Flutter (Dart) | `// @tc:12345` comment above `testWidgets()`/`test()` |
| CSV | Numeric ID in column A |
| Excel | Numeric ID in cell A |

---

## Quick start

**Step 1 — Install**

```bash
npm install -g ado-sync
# or run once without installing
npx ado-sync --help
```

**Step 2 — Generate a config file**

```bash
ado-sync init              # creates ado-sync.json
ado-sync init ado-sync.yml # YAML format if you prefer
```

**Step 3 — Fill in your details**

Open `ado-sync.json` and replace the placeholders:

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

**Step 4 — Set your token**

```bash
export AZURE_DEVOPS_TOKEN=your_personal_access_token
# or add it to a .env file in this directory
```

**Step 5 — Preview then push**

```bash
ado-sync push --dry-run   # preview — no changes made
ado-sync push             # create / update Test Cases in Azure DevOps
```

On the first push, new Test Cases are created and their IDs are written back into your local files (`@tc:12345`). Every subsequent push updates them.

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

# AI-generated test steps for code files (Java, C#, Python, JS/TS, Playwright)
ado-sync push --ai-provider heuristic           # fast regex-based (no model needed)
ado-sync push --ai-provider local --ai-model ~/.cache/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf
ado-sync push --ai-provider ollama --ai-model qwen2.5-coder:7b
ado-sync push --ai-provider openai  --ai-key $OPENAI_API_KEY
ado-sync push --ai-provider none                # disable AI summary entirely
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
ado-sync status --ai-provider heuristic
```

Compares local specs against Azure DevOps and prints a diff — no changes made.

### AI auto-summary

For code-based test types (`java`, `csharp`, `python`, `javascript`, `playwright`, `cypress`, `testcafe`, `detox`, `espresso`, `xcuitest`, `flutter`), ado-sync reads your test function bodies and automatically generates a TC **title**, **description**, and **steps** — so you don't need doc comments on every test.

> **No setup required to try it.** `ado-sync push` always works, even without a model — it falls back to fast regex-based analysis automatically.

#### Choose a provider

| Provider | Quality | Setup |
|---|---|---|
| `local` *(default)* | Good–Excellent | Download a GGUF model file (see below) |
| `heuristic` | Basic | None — works offline, zero dependencies |
| `ollama` | Good–Excellent | Install [Ollama](https://ollama.com) + `ollama pull qwen2.5-coder:7b` |
| `openai` | Excellent | `--ai-key $OPENAI_API_KEY` |
| `anthropic` | Excellent | `--ai-key $ANTHROPIC_API_KEY` |
| `openai` + `--ai-url` | Excellent | Any OpenAI-compatible proxy: LiteLLM, Azure OpenAI, vLLM, LM Studio |

#### Option A — No setup (heuristic, instant)

```bash
ado-sync push --ai-provider heuristic
```

Uses regex pattern matching. No model download, no internet required. Good for CI pipelines.

#### Option B — Local LLM (best privacy, no API cost)

`node-llama-cpp` is bundled — **no extra install needed**. You only need to download a model file once.

**1. Pick a model size**

| Model | RAM needed | Quality |
|-------|-----------|---------|
| 1.5B Q4_K_M *(start here)* | ~1.1 GB | Good |
| 7B Q4_K_M | ~4.5 GB | Better |
| 14B Q4_K_M | ~8.5 GB | Excellent |

**2. Download the model**

macOS / Linux:
```bash
mkdir -p ~/.cache/ado-sync/models
curl -L -o ~/.cache/ado-sync/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf \
  "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"
```

Windows (PowerShell):
```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\ado-sync\models"
Invoke-WebRequest `
  -Uri "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf" `
  -OutFile "$env:LOCALAPPDATA\ado-sync\models\qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"
```

**3. Run push with the model**

```bash
# macOS / Linux
ado-sync push --ai-model ~/.cache/ado-sync/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf

# Windows
ado-sync push --ai-model "$env:LOCALAPPDATA\ado-sync\models\qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"
```

#### Option C — Ollama (model management UI, easy upgrades)

```bash
# 1. Install Ollama from https://ollama.com, then:
ollama pull qwen2.5-coder:7b

# 2. Push using Ollama
ado-sync push --ai-provider ollama --ai-model qwen2.5-coder:7b
```

#### Option D — Cloud AI (OpenAI / Anthropic)

```bash
ado-sync push --ai-provider openai   --ai-key $OPENAI_API_KEY
ado-sync push --ai-provider anthropic --ai-key $ANTHROPIC_API_KEY
```

#### Option E — LiteLLM or any OpenAI-compatible proxy

[LiteLLM](https://github.com/BerriAI/litellm) is a proxy that routes to 100+ providers (Azure OpenAI, Bedrock, Gemini, Mistral, vLLM, and more) via a single OpenAI-compatible API. Point the `openai` provider at it with `--ai-url`:

```bash
ado-sync push \
  --ai-provider openai \
  --ai-url http://localhost:4000 \
  --ai-key $LITELLM_API_KEY \
  --ai-model gpt-4o-mini
```

The same pattern works for Azure OpenAI, vLLM, LM Studio, and LocalAI — just change `--ai-url` to the endpoint's base URL. See [docs/advanced.md](docs/advanced.md) for a full compatibility table.

#### Disable AI entirely

```bash
ado-sync push --ai-provider none
```

> Tests with existing doc comments (JSDoc / Javadoc / C# XML doc / Python docstring) that already have both steps and a description are **never overwritten**. Local source files are **never modified** by AI summary.

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
| Spec file formats (Gherkin, Markdown, C# MSTest, CSV, Excel, JS/TS) | [docs/spec-formats.md](docs/spec-formats.md) |
| Work Item Links (User Story, Bug, etc.) | [docs/spec-formats.md#work-item-links](docs/spec-formats.md#work-item-links) |
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

### C# MSTest / NUnit / SpecFlow: create TCs, run tests, publish results

```bash
# 1. Create TCs and write IDs back into .cs / .feature files
ado-sync push --dry-run   # preview
ado-sync push             # writes [TestProperty("tc","ID")] / [Property("tc","ID")] / @tc:ID

# 2a. MSTest — TRX contains [TestProperty] values; TC IDs extracted automatically
dotnet test --logger "trx;LogFileName=results.trx"
ado-sync publish-test-results --testResult results/results.trx

# 2b. NUnit — use native XML logger so [Property("tc","ID")] values are included
dotnet test --logger "nunit3;LogFileName=results.xml"
ado-sync publish-test-results --testResult results/results.xml

# 2c. SpecFlow — TRX format (SpecFlow writes @tc:ID into TestProperty automatically)
dotnet test --logger "trx;LogFileName=results.trx"
ado-sync publish-test-results --testResult results/results.trx
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

Recommended `ado-sync.json` for C# SpecFlow:

```json
{
  "orgUrl": "https://dev.azure.com/my-org",
  "project": "MyProject",
  "auth": { "type": "pat", "token": "$AZURE_DEVOPS_TOKEN" },
  "testPlan": { "id": 1234 },
  "local": {
    "type": "gherkin",
    "include": ["Features/**/*.feature"]
  },
  "sync": {
    "tagPrefix": "tc",
    "markAutomated": true
  }
}
```

### Java JUnit / TestNG: create TCs and publish results

```bash
# 1. Create TCs and write IDs back into .java files
ado-sync push --dry-run   # preview
ado-sync push             # writes // @tc:ID (JUnit 4/TestNG) or @Tag("tc:ID") (JUnit 5)

# 2. Run tests and generate JUnit XML
mvn test                  # Surefire writes target/surefire-reports/*.xml by default
# or with Gradle:
./gradlew test            # writes build/test-results/test/*.xml

# 3. Publish results
ado-sync publish-test-results --testResult target/surefire-reports/TEST-*.xml --testResultFormat junit
```

Recommended `ado-sync.json` for Java:

```json
{
  "orgUrl": "https://dev.azure.com/my-org",
  "project": "MyProject",
  "auth": { "type": "pat", "token": "$AZURE_DEVOPS_TOKEN" },
  "testPlan": { "id": 1234 },
  "local": {
    "type": "java",
    "include": ["**/src/test/**/*.java"],
    "exclude": ["**/*BaseTest.java", "**/*Helper.java"]
  },
  "sync": {
    "markAutomated": true
  }
}
```

### Python pytest: create TCs and publish results

```bash
# 1. Create TCs and write IDs back into .py files
ado-sync push --dry-run   # preview
ado-sync push             # writes @pytest.mark.tc(ID) above each test function

# 2. Run tests and generate JUnit XML
pytest --junitxml=results/junit.xml

# 3. Publish results
ado-sync publish-test-results --testResult results/junit.xml --testResultFormat junit
```

By default, TC linking uses `AutomatedTestName` matching (requires `sync.markAutomated: true`).

**Optional — embed TC IDs into JUnit XML** for direct linking (more reliable, works even if the class/method is renamed):

Add this to `conftest.py`:

```python
# conftest.py
def pytest_runtest_makereport(item, call):
    """Write @pytest.mark.tc(N) as a JUnit XML property for ado-sync to pick up."""
    for marker in item.iter_markers("tc"):
        if marker.args:
            item.user_properties.append(("tc", str(marker.args[0])))
```

pytest will then write each TC ID into the JUnit XML as `<property name="tc" value="N"/>`, and ado-sync will link the result directly to that Test Case — no AutomatedTestName matching needed.

Recommended `ado-sync.json` for Python:

```json
{
  "orgUrl": "https://dev.azure.com/my-org",
  "project": "MyProject",
  "auth": { "type": "pat", "token": "$AZURE_DEVOPS_TOKEN" },
  "testPlan": { "id": 1234 },
  "local": {
    "type": "python",
    "include": ["tests/**/*.py"],
    "exclude": ["tests/conftest.py", "tests/**/helpers.py"]
  },
  "sync": {
    "markAutomated": true
  }
}
```

### JavaScript / TypeScript (Jest, Jasmine, WebdriverIO): create TCs

```bash
# 1. Create TCs and write IDs back into .js / .ts files
ado-sync push --dry-run   # preview
ado-sync push             # writes // @tc:ID above each it() / test()

# 2. Run tests and generate JUnit XML (Jest example)
npx jest --reporters=default --reporters=jest-junit
# JEST_JUNIT_OUTPUT_DIR=results JEST_JUNIT_OUTPUT_NAME=junit.xml

# 3. Publish results
ado-sync publish-test-results --testResult results/junit.xml --testResultFormat junit
```

### Playwright: create TCs and publish results with screenshots

```bash
# 1. Create TCs and write IDs back into .ts spec files
ado-sync push --dry-run   # preview
ado-sync push             # writes // @tc:ID above each test()

# 2. Add @tc:ID tag to test title and run Playwright with JSON reporter
#    playwright.config.ts: reporter: [['json', { outputFile: 'results/playwright.json' }]]
npx playwright test

# 3. Publish — TC IDs from @tc:ID in test title; screenshots/videos from attachments[]
ado-sync publish-test-results --testResult results/playwright.json
```

Recommended `ado-sync.json` for Playwright:

```json
{
  "orgUrl": "https://dev.azure.com/my-org",
  "project": "MyProject",
  "auth": { "type": "pat", "token": "$AZURE_DEVOPS_TOKEN" },
  "testPlan": { "id": 1234 },
  "local": {
    "type": "playwright",
    "include": ["tests/**/*.spec.ts"],
    "exclude": ["**/*.helper.ts"]
  },
  "sync": {
    "markAutomated": true
  }
}
```

Recommended `ado-sync.json` for Jest/Jasmine/WebdriverIO:

```json
{
  "orgUrl": "https://dev.azure.com/my-org",
  "project": "MyProject",
  "auth": { "type": "pat", "token": "$AZURE_DEVOPS_TOKEN" },
  "testPlan": { "id": 1234 },
  "local": {
    "type": "javascript",
    "include": ["src/**/*.spec.ts", "tests/**/*.test.js"],
    "exclude": ["**/*.helper.ts"]
  },
  "sync": {
    "markAutomated": true
  }
}
```

### Detox (React Native): create TCs and push

```bash
# 1. Create TCs and write IDs back into .ts files
ado-sync push --dry-run   # preview
ado-sync push             # writes // @tc:ID above each it() / test()

# 2. Run Detox tests (Jest runner)
npx detox test --configuration ios.sim.release

# 3. Publish results (Jest JUnit reporter)
ado-sync publish-test-results --testResult results/junit.xml --testResultFormat junit
```

Recommended `ado-sync.json` for Detox:

```json
{
  "orgUrl": "https://dev.azure.com/my-org",
  "project": "MyProject",
  "auth": { "type": "pat", "token": "$AZURE_DEVOPS_TOKEN" },
  "testPlan": { "id": 1234 },
  "local": {
    "type": "detox",
    "include": ["e2e/**/*.test.ts"]
  },
  "sync": { "markAutomated": true }
}
```

### Espresso (Android): create TCs and push

```bash
# 1. Create TCs and write IDs back into .java / .kt files
ado-sync push --dry-run   # preview
ado-sync push             # writes // @tc:ID above @Test

# 2. Run instrumented tests and generate JUnit XML
./gradlew connectedAndroidTest
# XML output: app/build/outputs/androidTest-results/connected/TEST-*.xml

# 3. Publish results
ado-sync publish-test-results \
  --testResult "app/build/outputs/androidTest-results/connected/TEST-*.xml" \
  --testResultFormat junit
```

Recommended `ado-sync.json` for Espresso:

```json
{
  "orgUrl": "https://dev.azure.com/my-org",
  "project": "MyProject",
  "auth": { "type": "pat", "token": "$AZURE_DEVOPS_TOKEN" },
  "testPlan": { "id": 1234 },
  "local": {
    "type": "espresso",
    "include": ["app/src/androidTest/**/*.java", "app/src/androidTest/**/*.kt"],
    "exclude": ["**/*BaseTest.java"]
  },
  "sync": { "markAutomated": true }
}
```

### XCUITest (iOS): create TCs and push

```bash
# 1. Create TCs and write IDs back into .swift files
ado-sync push --dry-run   # preview
ado-sync push             # writes // @tc:ID above func test*()

# 2. Run XCUITest and export JUnit XML
xcodebuild test \
  -project MyApp.xcodeproj \
  -scheme MyApp \
  -destination 'platform=iOS Simulator,name=iPhone 15' \
  -resultBundlePath TestResults.xcresult
xcrun xcresulttool get --path TestResults.xcresult --format junit > results/junit.xml

# 3. Publish results
ado-sync publish-test-results --testResult results/junit.xml --testResultFormat junit
```

Recommended `ado-sync.json` for XCUITest:

```json
{
  "orgUrl": "https://dev.azure.com/my-org",
  "project": "MyProject",
  "auth": { "type": "pat", "token": "$AZURE_DEVOPS_TOKEN" },
  "testPlan": { "id": 1234 },
  "local": {
    "type": "xcuitest",
    "include": ["UITests/**/*.swift"],
    "exclude": ["UITests/**/*Helper.swift", "UITests/**/*Base.swift"]
  },
  "sync": { "markAutomated": true }
}
```

### Flutter: create TCs and push

```bash
# 1. Create TCs and write IDs back into _test.dart files
ado-sync push --dry-run   # preview
ado-sync push             # writes // @tc:ID above testWidgets() / test()

# 2. Run Flutter tests with machine-readable output
flutter test --machine > results/flutter_test.jsonl
# Or generate JUnit XML with the flutter_test_junit package:
flutter test --reporter junit > results/junit.xml

# 3. Publish results
ado-sync publish-test-results --testResult results/junit.xml --testResultFormat junit
```

Recommended `ado-sync.json` for Flutter:

```json
{
  "orgUrl": "https://dev.azure.com/my-org",
  "project": "MyProject",
  "auth": { "type": "pat", "token": "$AZURE_DEVOPS_TOKEN" },
  "testPlan": { "id": 1234 },
  "local": {
    "type": "flutter",
    "include": ["test/**/*_test.dart", "integration_test/**/*_test.dart"]
  },
  "sync": { "markAutomated": true }
}
```

### CI pipeline

```yaml
# GitHub Actions
- name: Sync test cases to Azure DevOps
  run: ado-sync push --config-override sync.disableLocalChanges=true
  env:
    AZURE_DEVOPS_TOKEN: ${{ secrets.AZURE_DEVOPS_TOKEN }}

- name: Sync test cases to Azure DevOps (with AI summary)
  run: ado-sync push --ai-provider heuristic --config-override sync.disableLocalChanges=true
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

## Work Item Links

Link each Test Case to related Azure DevOps work items (User Stories, Bugs, etc.) automatically on every push.

### Configure `sync.links`

```json
{
  "sync": {
    "links": [
      {
        "prefix": "story",
        "relationship": "Microsoft.VSTS.Common.TestedBy-Reverse",
        "workItemType": "User Story"
      },
      {
        "prefix": "bug",
        "relationship": "System.LinkTypes.Related",
        "workItemType": "Bug"
      }
    ]
  }
}
```

| Field | Description |
|-------|-------------|
| `prefix` | The tag prefix used in your spec files (e.g. `story` → `@story:555`) |
| `relationship` | ADO relation type (see common values below) |
| `workItemType` | Optional — used in log output only |

**Common relationship values:**

| Relationship | Meaning |
|---|---|
| `Microsoft.VSTS.Common.TestedBy-Reverse` | Test Case "Tested By" ↔ User Story |
| `System.LinkTypes.Related` | Simple "Related" link |
| `System.LinkTypes.Dependency-Forward` | "Successor" (this item depends on) |
| `System.LinkTypes.Hierarchy-Reverse` | "Parent" link |

### Tag your tests

**Gherkin (`.feature`):**
```gherkin
# @story:555 @bug:789
Scenario: User can log in
  Given I am on the login page
```

**JavaScript / TypeScript (Jest, Playwright, Cypress, TestCafe, Puppeteer):**
```typescript
// @story:555
// @bug:789
test('user can log in', async ({ page }) => { ... });
```

**Markdown (`.md`):**
```markdown
### User can log in @story:555 @bug:789

1. Navigate to the login page
2. Check: Login form is visible
```

**Python (pytest):**
```python
# @story:555 @bug:789
def test_user_can_log_in():
    ...
```

**C# / Java / Espresso:** Add `// @story:555` in the comment block immediately above the `[TestMethod]` / `@Test` line.

**Swift (XCUITest):**
```swift
// @story:555
// @bug:789
func testUserCanLogin() { ... }
```

**Dart (Flutter):**
```dart
// @story:555
// @bug:789
testWidgets('user can log in', (WidgetTester tester) async { ... });
```

**Detox / React Native:**
```typescript
// @story:555
// @bug:789
it('user can log in', async () => { ... });
```

### How it works

- On each `push`, ado-sync reads the `@story:N` / `@bug:N` tags from the spec file.
- **New links** found in the file are added to the Test Case in Azure DevOps.
- **Stale links** (present in Azure but no longer tagged locally) are removed automatically.
- The sync is non-destructive for links not covered by a configured prefix — only the prefixes listed in `sync.links` are managed.

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
Ensure the file is not open in another application and that `sync.disableLocalChanges` is not `true`. If a TC was deleted from Azure and re-created on push, the old ID in column A is now replaced with the new ID automatically.

**Excel file not parsed / `No worksheet found`**
ado-sync searches for the first worksheet by reading `xl/_rels/workbook.xml.rels` from the xlsx ZIP, falling back to common names (`sheet.xml`, `sheet1.xml`). Non-standard sheet names and multi-sheet workbooks are handled automatically. If parsing still fails, re-export from Azure DevOps.

**Pull has no effect on CSV files**
CSV pull is now supported — `ado-sync pull` updates the Title and step rows in CSV files to match the current Azure DevOps Test Case. Run `ado-sync pull --dry-run` first to preview changes.

**Pull has no effect on Excel files**
Excel (xlsx) pull is not yet supported — only push. Use CSV export instead if bidirectional sync is needed, or pull the changes manually and re-export.

**C# categories show as constant names instead of values**
ado-sync resolves `const string` declarations in the same file. Constants defined in a base class are not resolved — use string literals in `[TestCategory("...")]` for reliable tagging.

**C# test methods not detected**
Ensure the method has `[TestMethod]` on its own line. Nested classes or abstract base methods are not parsed. Add base class files to `local.exclude`.

**TRX results not linked to Test Cases**
For MSTest, TC IDs are read directly from `[TestProperty("tc","ID")]` embedded in the TRX — no further config needed. For NUnit, use `--logger "nunit3;LogFileName=results.xml"` (native XML format) instead of TRX so `[Property("tc","ID")]` values are included. If neither is available, set `sync.markAutomated: true` and rely on `AutomatedTestName` FQMN matching.

**Java test methods not detected**
Ensure each test method has a `@Test` annotation. Abstract base methods and methods with only `@Before`/`@After` are not parsed. Add base class files to `local.exclude`.

**Java ID not written back (JUnit 5)**
ado-sync writes `@Tag("tc:ID")` above the `@Test` annotation. Ensure the file is writable. The `@Tag` import (`org.junit.jupiter.api.Tag`) must already be present or will be added automatically.

**Python test functions not detected**
ado-sync detects functions starting with `test_` at module level and inside classes. Ensure functions follow the `def test_*()` convention. Abstract base test methods should be excluded from `local.include`.

**Python ID not written back**
ado-sync writes `@pytest.mark.tc(ID)` directly above the `def test_*` line. Ensure `pytest` is in your test environment. The `pytest` import is not required in the file itself — the mark is a decorator, not a function call.

**JavaScript/TypeScript tests not detected**
ado-sync detects `it()`, `test()`, `xit()`, `xtest()`, and `.only`/`.skip`/`.concurrent` variants. Tests with dynamic titles (template literals or computed values) are skipped — use string literals for the test title.

**JavaScript ID not written back**
ado-sync inserts `// @tc:ID` immediately above the `it()`/`test()` line. There must be no blank line between the comment and the test function call.

**`publish-test-results` — "TestPointId, testCaseId must be specified for planned test results"**
This error means the Test Run was created as a "planned" run (tied to a test plan), which requires test point IDs for each result. ado-sync creates standalone automated runs — do not pass `plan.id` in `runModel`. This is handled automatically; if you see this error, ensure you are on the latest version.

**TRX screenshots / `<ResultFiles>` not attached**
In TRX format, `<ResultFiles>` is a child of `<Output>`, not a direct child of `<UnitTestResult>`. Make sure `TestContext.AddResultFile("path/to/screenshot.png")` is called in your test code. ado-sync reads from the correct nested path automatically.

**Attachment paths resolve incorrectly**
Attachment paths embedded in result files (TRX `<ResultFiles>`, NUnit `<filePath>`, JUnit `[[ATTACHMENT|path]]`, Playwright `attachments[].path`) are resolved **relative to the result file's directory**, not the working directory. Keep result files and screenshots in the same output folder hierarchy as your test runner produces them.

**"Invalid AttachmentType specified" from Azure DevOps API**
Azure DevOps only accepts `GeneralAttachment` and `ConsoleLog` as attachment types. Screenshot and video files are uploaded as `GeneralAttachment` automatically — no special type is needed.
