# publish-test-results

Parses test result files (TRX, NUnit XML, JUnit, Cucumber JSON) and publishes them to an Azure DevOps Test Run, linking results back to Test Cases either directly by TC ID (when available in the result file) or by `AutomatedTestName` matching.

---

## Usage

```bash
ado-sync publish-test-results \
  --testResult results/test-results.trx \
  --runName "CI run #42"

# Multiple result files
ado-sync publish-test-results \
  --testResult results/unit.trx \
  --testResult results/integration.xml \
  --testResultFormat junit

# Dry run — parse and summarise without publishing
ado-sync publish-test-results --testResult results/test.trx --dry-run

# Associate with a build
ado-sync publish-test-results \
  --testResult results/test.trx \
  --buildId 12345
```

### Options

| Option | Description |
|--------|-------------|
| `--testResult <path>` | Path to a result file. Repeatable. |
| `--testResultFormat <format>` | `trx` · `nunitXml` · `junit` · `cucumberJson` · `playwrightJson`. Auto-detected when omitted. |
| `--attachmentsFolder <path>` | Folder to scan for screenshots/videos/logs to attach to test results. |
| `--runName <name>` | Name for the Test Run in Azure DevOps. Defaults to `ado-sync <ISO timestamp>`. |
| `--buildId <id>` | Build ID to associate with the Test Run. |
| `--dry-run` | Parse results and print summary without creating a run in Azure. |
| `--config-override` | Override config values (repeatable, same as other commands). |

---

## Supported formats

| Format | Extension | Auto-detected | TC ID in file? | Attachments extracted |
|--------|-----------|---------------|----------------|----------------------|
| TRX (MSTest / VSTest) | `.trx` | Yes (`<TestRun>` root) | Yes — via `[TestProperty("tc","ID")]` | `<Output><StdOut>` + `<ResultFiles>` |
| NUnit XML (native) | `.xml` | Yes (`<test-run>` root) | Yes — via `[Property("tc","ID")]` | `<output>` + `<attachments>` |
| JUnit XML | `.xml` | Yes (`<testsuites>` / `<testsuite>` root) | Optional — via `<property name="tc" value="ID"/>` | `<system-out>`, `<system-err>`, `[[ATTACHMENT\|path]]` (Playwright) |
| Cucumber JSON | `.json` | Yes (JSON array, Cucumber format) | Yes — via `@tc:ID` tag on scenario | `step.embeddings[]` (base64 screenshots/video) |
| Playwright JSON | `.json` | Yes (JSON object with `suites` key) | Via `@tc:ID` in test title | `test.results[].attachments[]` (screenshots, videos, traces) |

> **NUnit via TRX**: when NUnit tests are run through the VSTest adapter (`--logger trx`), `[Property]` values are **not** included in the TRX output. Use `--logger "nunit3;LogFileName=results.xml"` to get the native NUnit XML format, which does include property values.

### How TC linking works

Results are linked to Azure Test Cases in priority order:

1. **TC ID from file** (preferred) — when the result file contains a TC ID (`[TestProperty]`, `[Property]`, `<property name="tc">`, or `@tc:` tag), the result is posted with `testCase.id` set directly. This is robust to class/method renames.
2. **AutomatedTestName matching** (fallback) — when no TC ID is found, the result is posted with `automatedTestName` = the fully-qualified method name. Azure DevOps links it to a TC whose `AutomatedTestName` field matches. Requires `sync.markAutomated: true` on push.

---

## Per-framework guide

### C# MSTest

```bash
dotnet test --logger "trx;LogFileName=results.trx"
ado-sync publish-test-results --testResult results/results.trx
```

TC IDs are read from `[TestProperty("tc","ID")]` embedded in the TRX — no extra config needed.

---

### C# NUnit

```bash
# Use native NUnit XML (includes [Property] values)
dotnet test --logger "nunit3;LogFileName=results.xml"
ado-sync publish-test-results --testResult results/results.xml

# TRX via VSTest adapter (TC IDs NOT included — uses AutomatedTestName matching)
dotnet test --logger "trx;LogFileName=results.trx"
ado-sync publish-test-results --testResult results/results.trx
```

---

### Java JUnit 4 / JUnit 5 (Maven Surefire)

Maven Surefire generates JUnit XML with `classname` = FQCN and `name` = method name. ado-sync builds `automatedTestName` as `FQCN.methodName` on push, which matches the `classname.name` format in the JUnit XML automatically.

```bash
# Run tests (Surefire writes target/surefire-reports/TEST-*.xml)
mvn test

# Publish — TC linking uses AutomatedTestName matching
ado-sync publish-test-results \
  --testResult "target/surefire-reports/TEST-*.xml" \
  --testResultFormat junit
```

Recommended config:
```json
{ "sync": { "markAutomated": true } }
```

**Optional — write TC IDs into JUnit XML** for direct linking (more reliable):

Add a JUnit 5 extension or JUnit 4 rule that reads the `@Tag("tc:ID")` / `// @tc:ID` value and calls `recordProperty` to embed it into the XML. With Surefire, test properties are written as `<property>` elements inside each `<testcase>`.

---

### Java TestNG

TestNG's Surefire reporter generates the same JUnit XML format. Same commands as JUnit above.

```bash
mvn test   # or: ./gradlew test

ado-sync publish-test-results \
  --testResult "target/surefire-reports/TEST-*.xml" \
  --testResultFormat junit
```

---

### Python pytest

```bash
# Run tests and generate JUnit XML
pytest --junitxml=results/junit.xml

# Publish — uses AutomatedTestName matching (classname.name from JUnit XML)
ado-sync publish-test-results --testResult results/junit.xml --testResultFormat junit
```

Recommended config:
```json
{ "sync": { "markAutomated": true } }
```

**Optional — embed TC IDs into JUnit XML** for direct linking.

Add the following to your `conftest.py`:

```python
# conftest.py
def pytest_runtest_makereport(item, call):
    """Write @pytest.mark.tc(N) as a JUnit XML property for ado-sync to pick up."""
    for marker in item.iter_markers("tc"):
        if marker.args:
            item.user_properties.append(("tc", str(marker.args[0])))
```

With this hook, pytest writes:
```xml
<testcase name="test_foo" classname="tests.module.TestClass">
  <properties>
    <property name="tc" value="1041"/>
  </properties>
</testcase>
```

ado-sync will extract the `tc` property and link the result directly to TC 1041, without needing AutomatedTestName matching.

---

### JavaScript / TypeScript — Jest

Install `jest-junit`:
```bash
npm install --save-dev jest-junit
```

Run tests:
```bash
JEST_JUNIT_OUTPUT_DIR=results JEST_JUNIT_OUTPUT_NAME=junit.xml \
  npx jest --reporters=default --reporters=jest-junit
```

Publish:
```bash
ado-sync publish-test-results --testResult results/junit.xml --testResultFormat junit
```

> **TC linking for Jest**: jest-junit does not embed TC IDs in the XML. Linking uses `AutomatedTestName` matching. Set `sync.markAutomated: true` and ensure the `JEST_JUNIT_CLASSNAME` and `JEST_JUNIT_TITLE` env vars match the `automatedTestName` format stored in the TC (`{fileBasename} > {describe} > {testTitle}`).
>
> Set these env vars to align the format:
> ```
> JEST_JUNIT_CLASSNAME="{classname}"   # default: suite hierarchy
> JEST_JUNIT_TITLE="{title}"           # default: test title
> ```

---

### JavaScript / TypeScript — WebdriverIO

WebdriverIO supports JUnit XML via `@wdio/junit-reporter`:

```bash
# Install (if not already present)
npm install --save-dev @wdio/junit-reporter
```

Add to `wdio.conf.ts`:
```typescript
reporters: [['junit', { outputDir: './results', outputFileFormat: () => 'junit.xml' }]]
```

Run tests:
```bash
npx wdio run wdio.conf.ts
```

Publish:
```bash
ado-sync publish-test-results --testResult results/junit.xml --testResultFormat junit
```

---

### Gherkin / Cucumber (JS)

Cucumber JS with Selenium captures screenshots/videos as base64 `embeddings` inside each step. These are extracted automatically and attached to the test result in Azure DevOps.

```bash
# Run with Cucumber JSON reporter (includes step embeddings)
npx cucumber-js --format json:results/cucumber.json

# Publish — TC IDs from @tc:ID tags, screenshots from embeddings
ado-sync publish-test-results --testResult results/cucumber.json
```

TC IDs from `@tc:12345` tags are extracted directly. Screenshots embedded by Selenium/WebDriver hooks are uploaded automatically.

---

### Playwright

Playwright supports two result formats — both extract attachments (screenshots, videos, traces):

**Option A — Playwright JSON reporter** (recommended, includes all attachments):

```bash
# playwright.config.ts
# reporter: [['json', { outputFile: 'results/playwright.json' }]]

npx playwright test
ado-sync publish-test-results --testResult results/playwright.json
```

Screenshots on failure, videos, and trace files are uploaded automatically from the `test-results/` folder referenced in the JSON.

**Option B — JUnit XML reporter** (for CI systems that need JUnit format):

```bash
# playwright.config.ts
# reporter: [['junit', { outputFile: 'results/junit.xml' }]]

npx playwright test
ado-sync publish-test-results --testResult results/junit.xml --testResultFormat junit
```

Playwright embeds `[[ATTACHMENT|path]]` markers in `<system-out>` — ado-sync reads these and uploads the referenced files (screenshots, videos).

**Using `--attachmentsFolder` for extra files:**

```bash
ado-sync publish-test-results \
  --testResult results/junit.xml \
  --attachmentsFolder test-results
```

---

| Framework | Result format | TC ID in file | Attachments uploaded |
|-----------|---------------|---------------|----------------------|
| C# MSTest | TRX | ✅ `[TestProperty("tc","ID")]` | `<Output><StdOut>` + `TestContext.AddResultFile()` files |
| C# NUnit | NUnit XML | ✅ `[Property("tc","ID")]` | `<output>` text + `TestContext.AddAttachment()` files |
| Java JUnit 4/5 | JUnit XML | ⚠️ optional | `<system-out>`, `<system-err>` |
| Java TestNG | JUnit XML | ⚠️ optional | `<system-out>`, `<system-err>` |
| Python pytest | JUnit XML | ⚠️ optional (conftest.py) | `<system-out>`, `<system-err>` |
| Jest | JUnit XML | ❌ | `<system-out>`, `<system-err>` |
| WebdriverIO | JUnit XML | ❌ | `<system-out>`, `<system-err>` |
| Cucumber JS | Cucumber JSON | ✅ `@tc:ID` tag | `step.embeddings[]` (Selenium screenshots/video) |
| Playwright | Playwright JSON | Via `@tc:ID` in title | Screenshots, videos, traces from `attachments[]` |
| Playwright | JUnit XML | Via `@tc:ID` in title | `[[ATTACHMENT\|path]]` referenced files |

---

## Attachments

ado-sync uploads screenshots, videos, and logs from test results to the corresponding Azure DevOps test result entry. Attachments appear in the Azure Test Plans UI under each result.

### What is extracted automatically per format

| Format | Extracted automatically |
|--------|------------------------|
| TRX | `<Output><StdOut>` → console log; `<ResultFiles><ResultFile>` → files on disk |
| NUnit XML | `<output>` → console log; `<attachments><attachment><filePath>` → files on disk |
| JUnit XML | `<system-out>` → log; `<system-err>` → log; `[[ATTACHMENT\|path]]` → Playwright files |
| Cucumber JSON | `step.embeddings[]` → base64-encoded screenshots/video |
| Playwright JSON | `results[].attachments[]` → files on disk (screenshots, videos, traces) |

### `--attachmentsFolder` — folder-based attachment upload

For any framework, point ado-sync at a folder containing screenshots and videos:

```bash
ado-sync publish-test-results \
  --testResult results/junit.xml \
  --attachmentsFolder test-results/screenshots
```

Files are matched to individual test results by looking for the test method name in the filename (case-insensitive). For example, `addItemAndCheckout_failed.png` → matched to `com.example.CheckoutTests.addItemAndCheckout`.

Unmatched files are attached at the test run level.

### Config-based attachment folder

```json
{
  "publishTestResults": {
    "attachments": {
      "folder": "test-results/screenshots",
      "include": ["**/*.png", "**/*.mp4"],
      "matchByTestName": true
    },
    "publishAttachmentsForPassingTests": "files"
  }
}
```

### `publishAttachmentsForPassingTests`

Controls how attachments are handled for **passing** tests (failing tests always get all attachments):

| Value | Behaviour |
|-------|-----------|
| `"none"` *(default)* | No attachments uploaded for passing tests |
| `"files"` | Screenshots and videos uploaded; console logs skipped |
| `"all"` | All attachments including logs uploaded for passing tests |

### Framework-specific setup

**C# MSTest — attach files from test code:**

```csharp
TestContext.AddResultFile("screenshots/mytest.png");
```

**C# NUnit — attach files:**

```csharp
TestContext.AddAttachment("screenshots/mytest.png");
```

**Java (JUnit/TestNG) — capture Selenium screenshot and write to system-out:**

```java
// In an @AfterMethod / @After hook:
File screenshot = ((TakesScreenshot) driver).getScreenshotAs(OutputType.FILE);
// Surefire writes <system-out> to JUnit XML — log the path:
System.out.println("Screenshot: " + screenshot.getAbsolutePath());
// Or use --attachmentsFolder to pick up the file directly
```

**Python pytest — capture screenshot via conftest.py:**

```python
# conftest.py
@pytest.fixture(autouse=True)
def screenshot_on_failure(request, driver):
    yield
    if request.node.rep_call.failed:
        driver.save_screenshot(f"screenshots/{request.node.name}.png")
```

Then publish with:
```bash
ado-sync publish-test-results \
  --testResult results/junit.xml \
  --attachmentsFolder screenshots
```

**Cucumber JS — embed screenshot in step hook:**

```javascript
// hooks.js
After(async function({ pickle, result }) {
  if (result.status === Status.FAILED) {
    const screenshot = await driver.takeScreenshot();
    this.attach(Buffer.from(screenshot, 'base64'), 'image/png');
  }
});
```

Screenshots are embedded as base64 in the Cucumber JSON and uploaded automatically.

**Playwright — screenshots and videos are automatic** when configured in `playwright.config.ts`:

```typescript
use: {
  screenshot: 'only-on-failure',
  video: 'retain-on-failure',
  trace: 'on-first-retry',
}
```

Use the Playwright JSON reporter — attachments are uploaded automatically.

---

## Outcome mapping

| Source outcome | Azure outcome |
|----------------|---------------|
| `passed` / `pass` / `success` | `Passed` |
| `failed` / `fail` / `failure` / `error` | `Failed` |
| `skipped` / `ignored` / `pending` / `notExecuted` | `NotExecuted` |
| `inconclusive` | `Inconclusive` (or override with `treatInconclusiveAs`) |

---

## Configuration

Results can also be configured in the config file under `publishTestResults`:

```json
{
  "publishTestResults": {
    "testResult": {
      "sources": [
        { "value": "results/unit.trx",        "format": "trx" },
        { "value": "results/integration.xml", "format": "junit" }
      ]
    },
    "treatInconclusiveAs": "Failed",
    "testRunSettings": {
      "name": "My CI Run",
      "comment": "Automated sync run",
      "runType": "Automated"
    },
    "testResultSettings": {
      "comment": "Published by ado-sync"
    },
    "testConfiguration": {
      "name": "Default"
    }
  }
}
```

### `publishTestResults` fields

| Field | Description |
|-------|-------------|
| `testResult.sources` | Array of `{ value, format }` objects. `value` is a path relative to config dir. |
| `treatInconclusiveAs` | Override inconclusive outcome. e.g. `"Failed"` or `"NotExecuted"`. |
| `flakyTestOutcome` | How to handle flaky tests: `"lastAttemptOutcome"` *(default)* · `"firstAttemptOutcome"` · `"worstOutcome"`. |
| `testConfiguration.name` | Name of the Azure test configuration to associate. |
| `testConfiguration.id` | ID of the Azure test configuration. |
| `testRunSettings.name` | Name for the Test Run. |
| `testRunSettings.comment` | Comment attached to the Test Run. |
| `testRunSettings.runType` | `"Automated"` *(default)* · `"Manual"`. |
| `testResultSettings.comment` | Comment applied to every test result. |
| `publishAttachmentsForPassingTests` | `"none"` *(default)* · `"files"` · `"all"`. |

---

## Output

```
ado-sync publish-test-results
Config: ado-sync.json

Total results: 42
  38 passed  3 failed  1 other
Run ID: 9876
URL: https://dev.azure.com/my-org/MyProject/_testManagement/runs?runId=9876
```
