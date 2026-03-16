# Work Item Links

Link each Test Case to related Azure DevOps work items (User Stories, Bugs, etc.) automatically on every push.

---

## Configure `sync.links`

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

---

## Tag your tests

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

**Robot Framework (`.robot`):**
```robot
*** Test Cases ***
My Login Test
    [Tags]    tc:12345    story:555    bug:789
    Open Browser    ${URL}
    Login As    user    pass
```

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

---

## How it works

- On each `push`, ado-sync reads the `@story:N` / `@bug:N` tags from the spec file.
- **New links** found in the file are added to the Test Case in Azure DevOps.
- **Stale links** (present in Azure but no longer tagged locally) are removed automatically.
- The sync is non-destructive for links not covered by a configured prefix — only the prefixes listed in `sync.links` are managed.
