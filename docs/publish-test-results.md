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
| JUnit XML | `.xml` | Yes (`<testsuites>` / `<testsuite>` root) | No — uses `AutomatedTestName` fallback |
| Cucumber JSON | `.json` | Yes (JSON array) | Yes — via `@tc:ID` tag on scenario |

> **NUnit via TRX**: when NUnit tests are run through the VSTest adapter (`--logger trx`), `[Property]` values are **not** included in the TRX output. Use `--logger "nunit3;LogFileName=results.xml"` to get the native NUnit XML format, which does include property values.

### How TC linking works

Results are linked to Azure Test Cases in priority order:

1. **TC ID from file** (preferred) — when the result file contains a TC ID (`[TestProperty]`, `[Property]`, or `@tc:` tag), the result is posted with `testCase.id` set directly. This is robust to class/method renames.
2. **AutomatedTestName matching** (fallback) — when no TC ID is found, the result is posted with `automatedTestName` = the fully-qualified method name. Azure DevOps links it to a TC whose `AutomatedTestName` field matches. Requires `sync.markAutomated: true` on push.

| Scenario | Recommended approach |
|----------|---------------------|
| MSTest + TRX | `--logger trx` — TC IDs extracted automatically from `[TestProperty("tc","ID")]` |
| NUnit + TC IDs | `--logger "nunit3;LogFileName=results.xml"` — TC IDs extracted from `[Property("tc","ID")]` |
| NUnit + TRX only | `--logger trx` + `sync.markAutomated: true` — uses FQMN matching, no TC IDs in file |

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
