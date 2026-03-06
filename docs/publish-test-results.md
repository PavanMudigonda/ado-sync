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
| `--testResultFormat <format>` | `trx` · `nunitXml` · `junit` · `cucumberJson`. Auto-detected from file extension/content when omitted. |
| `--runName <name>` | Name for the Test Run in Azure DevOps. Defaults to `ado-sync <ISO timestamp>`. |
| `--buildId <id>` | Build ID to associate with the Test Run. |
| `--dry-run` | Parse results and print summary without creating a run in Azure. |
| `--config-override` | Override config values (repeatable, same as other commands). |

---

## Supported formats

| Format | Extension | Auto-detected | TC ID in file? |
|--------|-----------|---------------|----------------|
| TRX (MSTest / VSTest) | `.trx` | Yes (`<TestRun>` root) | Yes — via `[TestProperty("tc","ID")]` in `TestDefinitions` |
| NUnit XML (native) | `.xml` | Yes (`<test-run>` root) | Yes — via `[Property("tc","ID")]` on each `test-case` |
| JUnit XML | `.xml` | Yes (`<testsuites>` / `<testsuite>` root) | Optional — via `<property name="tc" value="ID"/>` (see below) |
| Cucumber JSON | `.json` | Yes (JSON array) | Yes — via `@tc:ID` tag on scenario |

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

```bash
# Run with Cucumber JSON reporter
npx cucumber-js --format json:results/cucumber.json

# Publish — TC IDs are read from @tc:ID tags on each scenario
ado-sync publish-test-results --testResult results/cucumber.json
```

TC IDs from `@tc:12345` tags on scenarios are extracted directly from the JSON — no AutomatedTestName matching needed.

---

| Framework | Result format | TC ID in file | Fallback |
|-----------|---------------|---------------|---------|
| C# MSTest | TRX | ✅ `[TestProperty("tc","ID")]` | — |
| C# NUnit | NUnit XML | ✅ `[Property("tc","ID")]` | — |
| Java JUnit 4/5 | JUnit XML | ⚠️ optional (see above) | AutomatedTestName |
| Java TestNG | JUnit XML | ⚠️ optional (see above) | AutomatedTestName |
| Python pytest | JUnit XML | ⚠️ optional (conftest.py) | AutomatedTestName |
| Jest | JUnit XML | ❌ | AutomatedTestName |
| WebdriverIO | JUnit XML | ❌ | AutomatedTestName |
| Cucumber JS | Cucumber JSON | ✅ `@tc:ID` tag | — |

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
