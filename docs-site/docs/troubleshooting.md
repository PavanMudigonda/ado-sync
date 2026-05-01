# Troubleshooting

---

## Configuration & connectivity

**`No config file found`**
Run `ado-sync init` or pass `-c path/to/config.json`.

**`Environment variable 'X' is not set`**
Your config references `$X` in `auth.token` but the variable is not exported. Run `export X=...` or add it to a `.env` file.

**`Test case #N not found in Azure DevOps`**
The test case was deleted in Azure. Remove the ID tag from the local file to recreate it, or restore the test case in Azure.

**`Failed to parse <file>`**
Gherkin syntax error. Run `npx cucumber-js --dry-run` to identify the problem line.

---

## Push / sync

**Test Case created but ID not written back**
Check that the file is writable, or that `sync.disableLocalChanges` is not `true`.

**Changes not detected on push**
The comparison uses title + steps + description. Touch any step to force an update, or reset the cache by deleting `.ado-sync-state.json`.

**Conflict detected unexpectedly**
Delete `.ado-sync-state.json` to reset the cache. The next push re-populates it from Azure.

**CSV/Excel IDs not written back**
Ensure the file is not open in another application and that `sync.disableLocalChanges` is not `true`. If a TC was deleted from Azure and re-created on push, the old ID in column A is replaced with the new ID automatically.

**Excel file not parsed / `No worksheet found`**
ado-sync searches for the first worksheet by reading `xl/_rels/workbook.xml.rels` from the xlsx ZIP, falling back to common names (`sheet.xml`, `sheet1.xml`). Non-standard sheet names and multi-sheet workbooks are handled automatically. If parsing still fails, re-export from Azure DevOps.

**Pull has no effect on CSV files**
CSV pull is now supported — `ado-sync pull` updates the Title and step rows in CSV files to match the current Azure DevOps Test Case. Run `ado-sync pull --dry-run` first to preview changes.

**Pull has no effect on Excel files**
Excel (xlsx) pull is not yet supported — only push. Use CSV export instead if bidirectional sync is needed, or pull the changes manually and re-export.

---

## C# / .NET

**C# categories show as constant names instead of values**
ado-sync resolves `const string` declarations in the same file. Constants defined in a base class are not resolved — use string literals in `[TestCategory("...")]` for reliable tagging.

**C# test methods not detected**
Ensure the method has `[TestMethod]` on its own line. Nested classes or abstract base methods are not parsed. Add base class files to `local.exclude`.

---

## Java

**Java test methods not detected**
Ensure each test method has a `@Test` annotation. Abstract base methods and methods with only `@Before`/`@After` are not parsed. Add base class files to `local.exclude`.

**Java ID not written back (JUnit 5)**
ado-sync writes `@Tag("tc:ID")` above the `@Test` annotation. Ensure the file is writable. The `@Tag` import (`org.junit.jupiter.api.Tag`) must already be present or will be added automatically.

---

## Python

**Python test functions not detected**
ado-sync detects functions starting with `test_` at module level and inside classes. Ensure functions follow the `def test_*()` convention. Abstract base test methods should be excluded from `local.include`.

**Python ID not written back**
ado-sync writes `@pytest.mark.tc(ID)` directly above the `def test_*` line. Ensure `pytest` is in your test environment. The `pytest` import is not required in the file itself.

---

## JavaScript / TypeScript

**JavaScript/TypeScript tests not detected**
ado-sync detects `it()`, `test()`, `xit()`, `xtest()`, and `.only`/`.skip`/`.concurrent` variants. Tests with dynamic titles (template literals or computed values) are skipped — use string literals for the test title.

**JavaScript ID not written back**
ado-sync inserts `// @tc:ID` immediately above the `it()`/`test()` line. There must be no blank line between the comment and the test function call.

---

## Publishing test results

**`publish-test-results` — "TestPointId, testCaseId must be specified for planned test results"**
This error means the Test Run was created as a "planned" run (tied to a test plan), which requires test point IDs for each result. ado-sync creates standalone automated runs — do not pass `plan.id` in `runModel`. This is handled automatically; if you see this error, ensure you are on the latest version.

**TRX results not linked to Test Cases**
For MSTest, TC IDs are read directly from `[TestProperty("tc","ID")]` embedded in the TRX. For NUnit, use `--logger "nunit3;LogFileName=results.xml"` (native XML format) instead of TRX so `[Property("tc","ID")]` values are included. If neither is available, set `sync.markAutomated: true` and rely on `AutomatedTestName` FQMN matching.

**TRX screenshots / `<ResultFiles>` not attached**
In TRX format, `<ResultFiles>` is a child of `<Output>`, not a direct child of `<UnitTestResult>`. Make sure `TestContext.AddResultFile("path/to/screenshot.png")` is called in your test code.

**Attachment paths resolve incorrectly**
Attachment paths embedded in result files (TRX `<ResultFiles>`, NUnit `<filePath>`, JUnit `[[ATTACHMENT|path]]`, Playwright `attachments[].path`) are resolved **relative to the result file's directory**, not the working directory. Keep result files and screenshots in the same output folder hierarchy as your test runner produces them.

**"Invalid AttachmentType specified" from Azure DevOps API**
Azure DevOps only accepts `GeneralAttachment` and `ConsoleLog` as attachment types. Screenshot and video files are uploaded as `GeneralAttachment` automatically — no special type is needed.
