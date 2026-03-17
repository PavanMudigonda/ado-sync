# Workflow Examples

Framework-specific end-to-end examples for using `ado-sync push`, `pull`, and `publish-test-results`.

---

## Day-to-day

```bash
# Local changes first — edit your files, then push
ado-sync push

# Azure changes first — someone edited a Test Case in the ADO UI
ado-sync pull

# Check for drift before raising a PR
ado-sync status
```

---

## C# MSTest

```bash
# 1. Create TCs and write IDs back into .cs files
ado-sync push --dry-run   # preview
ado-sync push             # writes [TestProperty("tc","ID")] above each [TestMethod]

# 2. Run tests — TRX contains [TestProperty] values, TC IDs extracted automatically
dotnet test --logger "trx;LogFileName=results.trx"

# 3. Publish results
ado-sync publish-test-results --testResult results/results.trx
```

Recommended config:
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
  "sync": { "markAutomated": true, "format": { "useExpectedResult": true } }
}
```

---

## C# NUnit

```bash
ado-sync push

# Use native NUnit XML logger — TRX omits [Property] values
dotnet test --logger "nunit3;LogFileName=results.xml"

ado-sync publish-test-results --testResult results/results.xml
```

---

## C# SpecFlow

```bash
ado-sync push   # writes @tc:ID above each Scenario

dotnet test --logger "trx;LogFileName=results.trx"
ado-sync publish-test-results --testResult results/results.trx
```

Recommended config:
```json
{
  "orgUrl": "https://dev.azure.com/my-org",
  "project": "MyProject",
  "auth": { "type": "pat", "token": "$AZURE_DEVOPS_TOKEN" },
  "testPlan": { "id": 1234 },
  "local": { "type": "gherkin", "include": ["Features/**/*.feature"] },
  "sync": { "tagPrefix": "tc", "markAutomated": true }
}
```

---

## Java JUnit / TestNG

```bash
ado-sync push   # writes // @tc:ID (JUnit 4/TestNG) or @Tag("tc:ID") (JUnit 5)

# Maven
mvn test   # Surefire: target/surefire-reports/*.xml

# Gradle
./gradlew test   # build/test-results/test/*.xml

ado-sync publish-test-results \
  --testResult "target/surefire-reports/TEST-*.xml" \
  --testResultFormat junit
```

Recommended config:
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
  "sync": { "markAutomated": true }
}
```

---

## Python pytest

```bash
ado-sync push   # writes @pytest.mark.tc(ID) above each def test_*()

pytest --junitxml=results/junit.xml

ado-sync publish-test-results --testResult results/junit.xml --testResultFormat junit
```

**Optional — embed TC IDs directly into JUnit XML** (more reliable than AutomatedTestName matching):

Add to `conftest.py`:
```python
def pytest_runtest_makereport(item, call):
    for marker in item.iter_markers("tc"):
        if marker.args:
            item.user_properties.append(("tc", str(marker.args[0])))
```

Recommended config:
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
  "sync": { "markAutomated": true }
}
```

---

## JavaScript / TypeScript (Jest, Jasmine, WebdriverIO)

```bash
ado-sync push   # writes // @tc:ID above each it() / test()

npx jest --reporters=default --reporters=jest-junit
# JEST_JUNIT_OUTPUT_DIR=results JEST_JUNIT_OUTPUT_NAME=junit.xml

ado-sync publish-test-results --testResult results/junit.xml --testResultFormat junit
```

Recommended config:
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
  "sync": { "markAutomated": true }
}
```

---

## Playwright

```bash
ado-sync push   # writes annotation: { type: 'tc', description: 'ID' } into test options

# playwright.config.ts: reporter: [['json', { outputFile: 'results/playwright.json' }]]
npx playwright test

# TC IDs from native test.annotations; screenshots/videos from attachments[]
ado-sync publish-test-results \
  --testResult results/playwright.json \
  --attachmentsFolder test-results/
```

Recommended config:
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
  "sync": { "markAutomated": true }
}
```

---

## Detox (React Native)

```bash
ado-sync push   # writes // @tc:ID above each it() / test()

npx detox test --configuration ios.sim.release

ado-sync publish-test-results --testResult results/junit.xml --testResultFormat junit
```

Recommended config:
```json
{
  "orgUrl": "https://dev.azure.com/my-org",
  "project": "MyProject",
  "auth": { "type": "pat", "token": "$AZURE_DEVOPS_TOKEN" },
  "testPlan": { "id": 1234 },
  "local": { "type": "detox", "include": ["e2e/**/*.test.ts"] },
  "sync": { "markAutomated": true }
}
```

---

## Espresso (Android)

```bash
ado-sync push   # writes // @tc:ID above @Test

./gradlew connectedAndroidTest
# XML: app/build/outputs/androidTest-results/connected/TEST-*.xml

ado-sync publish-test-results \
  --testResult "app/build/outputs/androidTest-results/connected/TEST-*.xml" \
  --testResultFormat junit
```

Recommended config:
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

---

## XCUITest (iOS)

```bash
ado-sync push   # writes // @tc:ID above func test*()

xcodebuild test \
  -project MyApp.xcodeproj -scheme MyApp \
  -destination 'platform=iOS Simulator,name=iPhone 15' \
  -resultBundlePath TestResults.xcresult
xcrun xcresulttool get --path TestResults.xcresult --format junit > results/junit.xml

ado-sync publish-test-results --testResult results/junit.xml --testResultFormat junit
```

Recommended config:
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

---

## Flutter

```bash
ado-sync push   # writes // @tc:ID above testWidgets() / test()

flutter test --reporter junit > results/junit.xml

ado-sync publish-test-results --testResult results/junit.xml --testResultFormat junit
```

Recommended config:
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

---

## Robot Framework

```bash
ado-sync push   # inserts/updates tc:ID in [Tags] of each test case

robot --outputdir results tests/

ado-sync publish-test-results --testResult results/output.xml
```

TC IDs are read directly from the `tc:N` tag in `<tags>` in `output.xml` — no extra config needed.

Recommended config:
```json
{
  "orgUrl": "https://dev.azure.com/my-org",
  "project": "MyProject",
  "auth": { "type": "pat", "token": "$AZURE_DEVOPS_TOKEN" },
  "testPlan": { "id": 1234 },
  "local": {
    "type": "robot",
    "include": ["tests/**/*.robot"],
    "exclude": ["tests/resources/**"]
  },
  "sync": { "markAutomated": true }
}
```

---

## CI pipeline (GitHub Actions)

### Basic push + publish

```yaml
- name: Sync test cases to Azure DevOps
  run: ado-sync push --config-override sync.disableLocalChanges=true
  env:
    AZURE_DEVOPS_TOKEN: ${{ secrets.AZURE_DEVOPS_TOKEN }}

- name: Publish test results
  run: ado-sync publish-test-results --testResult results/test.trx
  env:
    AZURE_DEVOPS_TOKEN: ${{ secrets.AZURE_DEVOPS_TOKEN }}
```

Use `sync.disableLocalChanges=true` in CI so the pipeline never commits ID writeback files.

---

### PR comment bot

Copy [`.github/workflows/ado-sync-pr-check.yml`](../.github/workflows/ado-sync-pr-check.yml) into your repo. On every pull request it runs `ado-sync push --dry-run` and posts a comment showing:

- Unlinked specs that would be created in Azure DevOps
- Specs with drift vs. existing Test Cases
- Conflicts where both local and remote changed

Requires one secret: `ADO_PAT` (Azure DevOps PAT with Test Management read/write).

---

### Coverage gate + AC gate

Copy [`.github/workflows/ado-sync-coverage-gate.yml`](../.github/workflows/ado-sync-coverage-gate.yml) into your repo. Runs three checks on push/PR to main:

```
Step 1 — Spec coverage gate
  ado-sync coverage --fail-below 80
  Fails if fewer than 80% of local specs are linked to Azure Test Cases.

Step 2 — Acceptance criteria gate
  ado-sync ac-gate --area-path "..."
  Fails if any Active/Resolved story is missing AC or linked Test Cases.

Step 3 — Trend report (informational)
  ado-sync trend --days 30
  Optionally posts a Slack/Teams webhook summary. Never fails the build.
```

Configure via GitHub repository variables (no code changes needed):

| Variable | Description | Default |
|----------|-------------|---------|
| `ADO_SYNC_COVERAGE_MIN` | Minimum spec link rate % | `80` |
| `ADO_SYNC_AC_AREA_PATH` | Area path scope for AC gate | *(all stories)* |
| `ADO_SYNC_TREND_DAYS` | Days of history for trend report | `30` |
| `ADO_SYNC_TREND_WEBHOOK` | Slack/Teams webhook URL | *(none)* |
| `ADO_SYNC_TREND_WEBHOOK_TYPE` | `slack`, `teams`, or `generic` | `slack` |

---

### Stale TC cleanup in CI

To periodically retire stale Azure Test Cases (TCs that no longer have a local spec):

```yaml
- name: Retire stale test cases
  run: ado-sync stale --retire --dry-run   # remove --dry-run to apply
  env:
    AZURE_DEVOPS_TOKEN: ${{ secrets.AZURE_DEVOPS_TOKEN }}
```

This transitions orphaned TCs to `Closed` state and tags them `ado-sync:retired`. Use `--retire-state "Inactive"` if your process uses a different state name.

---

### Flaky test detection in CI

```yaml
- name: Detect flaky tests
  run: |
    ado-sync trend \
      --days 14 \
      --fail-on-flaky \
      --webhook-url ${{ secrets.SLACK_WEBHOOK }}
  env:
    AZURE_DEVOPS_TOKEN: ${{ secrets.AZURE_DEVOPS_TOKEN }}
```

Exits 1 if any test both passed and failed in the last 14 days, and posts a summary to Slack. Drop `--fail-on-flaky` to run as informational-only.
