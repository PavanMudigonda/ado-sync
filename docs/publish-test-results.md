# publish-test-results

Parses test result files (TRX, JUnit, Cucumber JSON) and publishes them to an Azure DevOps Test Run, linking results back to Test Cases via the sync tag.

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
| `--testResultFormat <format>` | `trx` · `junit` · `cucumberJson`. Auto-detected from file extension/content when omitted. |
| `--runName <name>` | Name for the Test Run in Azure DevOps. Defaults to `ado-sync <ISO timestamp>`. |
| `--buildId <id>` | Build ID to associate with the Test Run. |
| `--dry-run` | Parse results and print summary without creating a run in Azure. |
| `--config-override` | Override config values (repeatable, same as other commands). |

---

## Supported formats

| Format | Extension | Auto-detected |
|--------|-----------|---------------|
| TRX (Visual Studio / .NET) | `.trx` | Yes (XML root `<TestRun>`) |
| JUnit XML | `.xml` | Yes (XML root `<testsuites>` or `<testsuite>`) |
| Cucumber JSON | `.json` | Yes (JSON array of feature objects) |

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
