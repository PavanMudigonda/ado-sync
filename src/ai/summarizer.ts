/**
 * Auto-summary generator for test cases that have no doc comment.
 *
 * Providers:
 *
 *   local      — Node.js-native LLM via node-llama-cpp (bundled dependency).
 *                Runs GGUF models directly in-process; no external server.
 *                Requires a GGUF model file path supplied via `model`.
 *                Falls back to heuristic if no model path is provided.
 *                Recommended model: Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf
 *
 *   heuristic  — regex pattern matching against the test body; zero
 *                dependencies, works fully offline.
 *
 *   ollama     — local LLM via Ollama REST API (http://localhost:11434).
 *                Model suggestion: qwen2.5-coder:7b.
 *
 *   openai     — OpenAI Chat Completions API (requires API key).
 *
 *   anthropic  — Anthropic Messages API (requires API key).
 *
 * Usage (engine.ts / CLI):
 *   const { title, description, steps } = await summarizeTest(test, localType, {
 *     provider: 'local',
 *     model: '/path/to/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
 *   });
 *   test.title = title;
 *   test.description = description;
 *   test.steps = steps;
 */

import * as fs from 'fs';

import { ParsedStep, ParsedTest } from '../types';

// ─── Public options ───────────────────────────────────────────────────────────

export type AiProvider = 'heuristic' | 'local' | 'ollama' | 'openai' | 'anthropic';

export interface AiSummaryOpts {
  provider: AiProvider;
  /**
   * For `local`: absolute path to a GGUF model file, e.g.
   *   ~/.cache/ado-sync/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf
   * For `ollama`: model tag, e.g. qwen2.5-coder:7b
   * For `openai`: model name, e.g. gpt-4o-mini
   * For `anthropic`: model name, e.g. claude-haiku-4-5-20251001
   */
  model?: string;
  /** Base URL for Ollama (default: http://localhost:11434) or OpenAI-compatible endpoint. */
  baseUrl?: string;
  /** API key for openai / anthropic — or $ENV_VAR reference. */
  apiKey?: string;
  /** Fall back to heuristic if the LLM call fails. Default: true. */
  heuristicFallback?: boolean;
}

type LocalType =
  | 'gherkin' | 'markdown' | 'csv' | 'excel'
  | 'csharp' | 'java' | 'python' | 'javascript' | 'playwright'
  | 'puppeteer' | 'cypress' | 'testcafe'
  | 'detox' | 'espresso' | 'xcuitest' | 'flutter';

// ─── Function body extraction ─────────────────────────────────────────────────

/**
 * Read the source file and return the raw text of the test function body,
 * starting from the marker line (1-based).
 *
 * For Python: collects lines indented past the `def` line.
 * For all others: collects until balanced braces close.
 */
export function extractFunctionBody(
  filePath: string,
  markerLine: number,
  localType: LocalType
): string {
  const source = fs.readFileSync(filePath, 'utf8');
  const lines = source.split('\n');
  const markerIdx = markerLine - 1; // 0-based

  return localType === 'python'
    ? extractPythonBody(lines, markerIdx)
    : extractBraceBody(lines, markerIdx);
}

function extractPythonBody(lines: string[], markerIdx: number): string {
  const defLine = lines[markerIdx] ?? '';
  const defIndent = (defLine.match(/^(\s*)/) ?? ['', ''])[1].length;
  const body: string[] = [defLine];

  for (let i = markerIdx + 1; i < lines.length && i < markerIdx + 80; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') { body.push(line); continue; }
    const indent = (line.match(/^(\s*)/) ?? ['', ''])[1].length;
    if (indent <= defIndent) break;
    body.push(line);
  }
  return body.join('\n');
}

function extractBraceBody(lines: string[], markerIdx: number): string {
  const body: string[] = [];
  let braceDepth = 0;
  let started = false;

  for (let i = markerIdx; i < lines.length && i < markerIdx + 100; i++) {
    const line = lines[i];
    body.push(line);
    for (const ch of line) {
      if (ch === '{') { braceDepth++; started = true; }
      else if (ch === '}') { braceDepth--; }
    }
    if (started && braceDepth === 0) break;
  }
  return body.join('\n');
}

// ─── Selector prettifier ──────────────────────────────────────────────────────

function prettifySelector(selector: string): string {
  return (
    selector
      .replace(/\[data-test=['"]([^'"]+)['"]\]/, '$1')
      .replace(/\[data-testid=['"]([^'"]+)['"]\]/, '$1')
      .replace(/^[#.]/, '')
      .replace(/[-_]/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .trim() || selector
  );
}

// ─── Heuristic pattern rules ──────────────────────────────────────────────────

interface StepResult { isCheck: boolean; text: string }
interface PatternRule { regex: RegExp; toStep(m: RegExpMatchArray): StepResult | null }

const PATTERNS: PatternRule[] = [
  // ── Navigate ──────────────────────────────────────────────────────────────
  {
    regex: /(?:page\.goto|browser\.url|driver\.get|d\.get|\.GoToUrl|Navigate\(\)\.GoToUrl)\(\s*(['"`])(https?:\/\/[^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: false, text: `Navigate to ${m[2]}` }),
  },
  {
    regex: /(?:page\.goto|browser\.url|driver\.get)\(\s*BASE_URL\s*\+?\s*(['"`])?([^'"`)\s]*)\1?/,
    toStep: (m) => ({ isCheck: false, text: `Navigate to ${m[2] ? 'BASE_URL' + m[2] : 'the application'}` }),
  },

  // ── Fill / type ───────────────────────────────────────────────────────────
  {
    // page.fill('#selector', 'value')
    regex: /(?:page\.fill|\.fill)\(\s*(['"`])([^'"` ]+)\1\s*,\s*(['"`])([^'"` ]*)\3/,
    toStep: (m) => ({ isCheck: false, text: `Enter "${m[4]}" into the ${prettifySelector(m[2])} field` }),
  },
  {
    // $(...).setValue('value') — WebdriverIO
    regex: /\$\(\s*(['"`])([^'"` ]+)\1\s*\)\.setValue\(\s*(['"`])([^'"` ]*)\3/,
    toStep: (m) => ({ isCheck: false, text: `Enter "${m[4]}" into the ${prettifySelector(m[2])} field` }),
  },
  {
    // .sendKeys('value') — Selenium Java/JS
    regex: /\.sendKeys\(\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: false, text: `Type "${m[2]}"` }),
  },
  {
    // .SendKeys("value") — C# Selenium
    regex: /\.SendKeys\(\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: false, text: `Type "${m[2]}"` }),
  },
  {
    // .send_keys("value") — Python Selenium
    regex: /\.send_keys\(\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: false, text: `Type "${m[2]}"` }),
  },

  // ── Select ────────────────────────────────────────────────────────────────
  {
    regex: /\.selectOption\(\s*(['"`])([^'"` ]+)\1\s*,\s*(['"`])([^'"` ]+)\3/,
    toStep: (m) => ({ isCheck: false, text: `Select "${m[4]}" from the ${prettifySelector(m[2])} dropdown` }),
  },
  {
    regex: /\.selectByAttribute\(['"`][^'"` ]+['"`]\s*,\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: false, text: `Select option "${m[2]}"` }),
  },

  // ── Click ─────────────────────────────────────────────────────────────────
  {
    // page.click('#selector')
    regex: /page\.click\(\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: false, text: `Click the ${prettifySelector(m[2])}` }),
  },
  {
    // $(...).click() — WebdriverIO
    regex: /\$\(\s*(['"`])([^'"` ]+)\1\s*\)\.click\(\)/,
    toStep: (m) => ({ isCheck: false, text: `Click the ${prettifySelector(m[2])}` }),
  },
  {
    // page.locator('...').click()
    regex: /\.locator\(\s*(['"`])([^'"` ]+)\1\s*\)\.click\(\)/,
    toStep: (m) => ({ isCheck: false, text: `Click the ${prettifySelector(m[2])}` }),
  },
  {
    // driver.findElement(By.id("x")).click() — Selenium Java/JS
    regex: /findElement\(By\.\w+\(\s*(['"`])([^'"` ]+)\1\s*\)\)\.click\(\)/,
    toStep: (m) => ({ isCheck: false, text: `Click the ${prettifySelector(m[2])}` }),
  },
  {
    // .FindElement(By.Id("x")).Click() — C# Selenium
    regex: /FindElement\(By\.\w+\(\s*(['"`])([^'"` ]+)\1\s*\)\)\.Click\(\)/,
    toStep: (m) => ({ isCheck: false, text: `Click the ${prettifySelector(m[2])}` }),
  },
  {
    // .find_element(By.ID, "x").click() — Python Selenium
    regex: /find_element\(By\.\w+,\s*(['"`])([^'"` ]+)\1\s*\)\.click\(\)/,
    toStep: (m) => ({ isCheck: false, text: `Click the ${prettifySelector(m[2])}` }),
  },
  {
    // .click() on a locator line — Playwright generic
    regex: /\.locator\(\s*(['"`])([^'"` ]+)\1\s*\)\s*\.\s*click/,
    toStep: (m) => ({ isCheck: false, text: `Click the ${prettifySelector(m[2])}` }),
  },

  // ── Wait / navigation ─────────────────────────────────────────────────────
  {
    regex: /(?:waitForURL|waitUntilUrlContains|wait\(until\.urlContains)\(\s*\/([^/]+)\//,
    toStep: (m) => ({ isCheck: false, text: `Wait for URL to contain "${m[1]}"` }),
  },

  // ── Cypress commands ──────────────────────────────────────────────────────
  {
    // cy.visit('url')
    regex: /cy\.visit\(\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: false, text: `Navigate to ${m[2]}` }),
  },
  {
    // cy.get('#selector').click()
    regex: /cy\.get\(\s*(['"`])([^'"` ]+)\1\s*\)(?:\.[^(]+\(\s*['"`][^'"` ]*['"`]\s*\))*\.click\(\)/,
    toStep: (m) => ({ isCheck: false, text: `Click the ${prettifySelector(m[2])}` }),
  },
  {
    // cy.get('#selector').type('value')
    regex: /cy\.get\(\s*(['"`])([^'"` ]+)\1\s*\)\.type\(\s*(['"`])([^'"` ]*)\3/,
    toStep: (m) => ({ isCheck: false, text: `Enter "${m[4]}" into the ${prettifySelector(m[2])} field` }),
  },
  {
    // cy.get('#selector').select('option')
    regex: /cy\.get\(\s*(['"`])([^'"` ]+)\1\s*\)\.select\(\s*(['"`])([^'"` ]+)\3/,
    toStep: (m) => ({ isCheck: false, text: `Select "${m[4]}" from the ${prettifySelector(m[2])} dropdown` }),
  },
  {
    // cy.get('#selector').should('have.text', 'value')
    regex: /cy\.get\(\s*(['"`])([^'"` ]+)\1\s*\)\.should\(\s*['"`]have\.text['"`]\s*,\s*(['"`])([^'"` ]+)\3/,
    toStep: (m) => ({ isCheck: true, text: `text of ${prettifySelector(m[2])} equals "${m[4]}"` }),
  },
  {
    // cy.get('#selector').should('contain', 'value') / contain.text
    regex: /cy\.get\(\s*(['"`])([^'"` ]+)\1\s*\)\.should\(\s*['"`](?:contain|contain\.text)['"`]\s*,\s*(['"`])([^'"` ]+)\3/,
    toStep: (m) => ({ isCheck: true, text: `${prettifySelector(m[2])} contains "${m[4]}"` }),
  },
  {
    // cy.get('#selector').should('be.visible')
    regex: /cy\.get\(\s*(['"`])([^'"` ]+)\1\s*\)\.should\(\s*['"`]be\.visible['"`]/,
    toStep: (m) => ({ isCheck: true, text: `${prettifySelector(m[2])} is visible` }),
  },
  {
    // cy.url().should('include', 'path') or cy.url().should('contain', 'path')
    regex: /cy\.url\(\s*\)\.should\(\s*['"`](?:include|contain)['"`]\s*,\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: true, text: `URL contains "${m[2]}"` }),
  },
  {
    // cy.url().should('equal', 'url')
    regex: /cy\.url\(\s*\)\.should\(\s*['"`]equal['"`]\s*,\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: true, text: `URL equals "${m[2]}"` }),
  },
  {
    // cy.contains('text') — broad text assertion
    regex: /cy\.contains\(\s*(['"`])([^'"` ]+)\1\s*\)\.should/,
    toStep: (m) => ({ isCheck: true, text: `page contains "${m[2]}"` }),
  },

  // ── TestCafe commands ──────────────────────────────────────────────────────
  {
    // await t.navigateTo('url')
    regex: /t\.navigateTo\(\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: false, text: `Navigate to ${m[2]}` }),
  },
  {
    // await t.click('#selector') or t.click(Selector('#selector'))
    regex: /t\.click\(\s*(?:Selector\(\s*)?(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: false, text: `Click the ${prettifySelector(m[2])}` }),
  },
  {
    // await t.typeText('#selector', 'value')
    regex: /t\.typeText\(\s*(?:Selector\(\s*)?(['"`])([^'"` ]+)\1\s*\)?\s*,\s*(['"`])([^'"` ]*)\3/,
    toStep: (m) => ({ isCheck: false, text: `Enter "${m[4]}" into the ${prettifySelector(m[2])} field` }),
  },
  {
    // await t.selectText('#selector')
    regex: /t\.selectText\(\s*(?:Selector\(\s*)?(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: false, text: `Select text in the ${prettifySelector(m[2])} field` }),
  },
  {
    // await t.expect(x).eql('value')
    regex: /t\.expect\([^)]{3,60}\)\.eql\(\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: true, text: `value equals "${m[2]}"` }),
  },
  {
    // await t.expect(x).contains('value')
    regex: /t\.expect\([^)]{3,60}\)\.contains\(\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: true, text: `result contains "${m[2]}"` }),
  },
  {
    // await t.expect(x).ok()
    regex: /t\.expect\(([^)]{3,60})\)\.ok\(\)/,
    toStep: (m) => ({ isCheck: true, text: `${m[1].trim()} is true` }),
  },

  // ── Puppeteer-specific (supplements the Playwright patterns above) ─────────
  {
    // page.type('#selector', 'value') — Puppeteer (page.fill is Playwright)
    regex: /page\.type\(\s*(['"`])([^'"` ]+)\1\s*,\s*(['"`])([^'"` ]*)\3/,
    toStep: (m) => ({ isCheck: false, text: `Enter "${m[4]}" into the ${prettifySelector(m[2])} field` }),
  },
  {
    // page.waitForNavigation() — Puppeteer
    regex: /page\.waitForNavigation\(/,
    toStep: (_m) => ({ isCheck: false, text: `Wait for page navigation` }),
  },

  // ── Detox (React Native) commands ─────────────────────────────────────────
  {
    // await device.launchApp() / device.relaunchApp()
    regex: /device\.(?:launch|relaunch)App\(/,
    toStep: (_m) => ({ isCheck: false, text: `Launch the app` }),
  },
  {
    // await element(by.id('x')).tap() / by.text / by.label
    regex: /element\(by\.\w+\(\s*(['"`])([^'"` ]+)\1\s*\)\)\.tap\(\)/,
    toStep: (m) => ({ isCheck: false, text: `Tap the ${prettifySelector(m[2])}` }),
  },
  {
    // await element(by.id('x')).typeText('value')
    regex: /element\(by\.\w+\(\s*(['"`])([^'"` ]+)\1\s*\)\)\.typeText\(\s*(['"`])([^'"` ]*)\3/,
    toStep: (m) => ({ isCheck: false, text: `Enter "${m[4]}" into the ${prettifySelector(m[2])} field` }),
  },
  {
    // await element(by.id('x')).clearText()
    regex: /element\(by\.\w+\(\s*(['"`])([^'"` ]+)\1\s*\)\)\.clearText\(\)/,
    toStep: (m) => ({ isCheck: false, text: `Clear the ${prettifySelector(m[2])} field` }),
  },
  {
    // await expect(element(by.id('x'))).toBeVisible()
    regex: /expect\(element\(by\.\w+\(\s*(['"`])([^'"` ]+)\1\s*\)\)\)\.toBeVisible\(\)/,
    toStep: (m) => ({ isCheck: true, text: `${prettifySelector(m[2])} is visible` }),
  },
  {
    // await expect(element(by.id('x'))).toHaveText('value')
    regex: /expect\(element\(by\.\w+\(\s*(['"`])([^'"` ]+)\1\s*\)\)\)\.toHaveText\(\s*(['"`])([^'"` ]+)\3/,
    toStep: (m) => ({ isCheck: true, text: `text of ${prettifySelector(m[2])} equals "${m[4]}"` }),
  },
  {
    // await expect(element(by.id('x'))).not.toBeVisible()
    regex: /expect\(element\(by\.\w+\(\s*(['"`])([^'"` ]+)\1\s*\)\)\)\.not\.toBeVisible\(\)/,
    toStep: (m) => ({ isCheck: true, text: `${prettifySelector(m[2])} is not visible` }),
  },

  // ── Espresso (Android) commands ───────────────────────────────────────────
  {
    // onView(withId(R.id.name)).perform(typeText("value"))
    regex: /onView\(withId\(R\.id\.(\w+)\)\)\.perform\(typeText\(\s*(['"`])([^'"` ]*)\2/,
    toStep: (m) => ({ isCheck: false, text: `Enter "${m[3]}" into the ${prettifySelector(m[1])} field` }),
  },
  {
    // onView(withId(R.id.name)).perform(click())
    regex: /onView\(withId\(R\.id\.(\w+)\)\)\.perform\(click\(\)\)/,
    toStep: (m) => ({ isCheck: false, text: `Click the ${prettifySelector(m[1])}` }),
  },
  {
    // onView(withId(R.id.name)).perform(scrollTo())
    regex: /onView\(withId\(R\.id\.(\w+)\)\)\.perform\(scrollTo\(\)\)/,
    toStep: (m) => ({ isCheck: false, text: `Scroll to the ${prettifySelector(m[1])}` }),
  },
  {
    // onView(withId(R.id.name)).check(matches(isDisplayed()))
    regex: /onView\(withId\(R\.id\.(\w+)\)\)\.check\(matches\(isDisplayed\(\)\)\)/,
    toStep: (m) => ({ isCheck: true, text: `${prettifySelector(m[1])} is displayed` }),
  },
  {
    // onView(withId(R.id.name)).check(matches(withText("value")))
    regex: /onView\(withId\(R\.id\.(\w+)\)\)\.check\(matches\(withText\(\s*(['"`])([^'"` ]+)\2/,
    toStep: (m) => ({ isCheck: true, text: `text of ${prettifySelector(m[1])} equals "${m[3]}"` }),
  },
  {
    // Espresso intending(hasComponent(hasShortClassName(".ActivityName")))
    regex: /Intents\.intended\(hasComponent\(hasShortClassName\(\s*(['"`])([^'"` .]+)\1/,
    toStep: (m) => ({ isCheck: true, text: `screen "${m[2]}" is displayed` }),
  },

  // ── XCUITest (iOS/macOS) commands ─────────────────────────────────────────
  {
    // app.launch() / app.activate()
    regex: /app\.(?:launch|activate)\(\)/,
    toStep: (_m) => ({ isCheck: false, text: `Launch the app` }),
  },
  {
    // app.buttons["Login"].tap()  /  app.staticTexts["Title"].tap()
    regex: /app\.\w+\[\s*(['"`])([^'"` ]+)\1\s*\]\.tap\(\)/,
    toStep: (m) => ({ isCheck: false, text: `Tap "${m[2]}"` }),
  },
  {
    // app.textFields["email"].typeText("value")
    regex: /app\.(?:textFields|secureTextFields|searchFields)\[\s*(['"`])([^'"` ]+)\1\s*\]\.typeText\(\s*(['"`])([^'"` ]*)\3/,
    toStep: (m) => ({ isCheck: false, text: `Enter "${m[4]}" into the "${m[2]}" field` }),
  },
  {
    // app.textFields["email"].clearAndEnterText("value")
    regex: /app\.(?:textFields|secureTextFields)\[\s*(['"`])([^'"` ]+)\1\s*\]\.clearAndEnterText\(\s*(['"`])([^'"` ]*)\3/,
    toStep: (m) => ({ isCheck: false, text: `Enter "${m[4]}" into the "${m[2]}" field` }),
  },
  {
    // app.swipeUp() / app.swipeDown()
    regex: /app\.swipe(Up|Down|Left|Right)\(\)/,
    toStep: (m) => ({ isCheck: false, text: `Swipe ${m[1].toLowerCase()}` }),
  },
  {
    // XCTAssertTrue(app.staticTexts["Welcome"].exists)
    regex: /XCTAssertTrue\(\s*app\.\w+\[\s*(['"`])([^'"` ]+)\1\s*\]\.exists/,
    toStep: (m) => ({ isCheck: true, text: `"${m[2]}" is visible` }),
  },
  {
    // XCTAssertEqual(actual, "expected")
    regex: /XCTAssertEqual\(\s*[^,]+,\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: true, text: `value equals "${m[2]}"` }),
  },
  {
    // XCTAssertFalse / XCTAssertNil
    regex: /XCTAssert(?:False|Nil)\(\s*(.{3,60}?)\s*\)/,
    toStep: (m) => ({ isCheck: true, text: `${m[1].trim()} is false/nil` }),
  },

  // ── Flutter / Dart widget test commands ───────────────────────────────────
  {
    // await tester.tap(find.byKey(Key('x'))) / find.byType(X) / find.text('x')
    regex: /tester\.tap\(\s*find\.(?:byKey\(Key\()?(?:['"`])([^'"` ]+)['"`]/,
    toStep: (m) => ({ isCheck: false, text: `Tap "${prettifySelector(m[1])}"` }),
  },
  {
    // await tester.enterText(find.byType(TextField), 'value')
    regex: /tester\.enterText\(\s*find\.[^,]+,\s*(['"`])([^'"` ]*)\1/,
    toStep: (m) => ({ isCheck: false, text: `Enter "${m[2]}"` }),
  },
  {
    // await tester.longPress(find.byKey(Key('x')))
    regex: /tester\.longPress\(\s*find\.(?:byKey\(Key\()?(?:['"`])([^'"` ]+)['"`]/,
    toStep: (m) => ({ isCheck: false, text: `Long press "${prettifySelector(m[1])}"` }),
  },
  {
    // await tester.pumpAndSettle()
    regex: /tester\.pumpAndSettle\(/,
    toStep: (_m) => ({ isCheck: false, text: `Wait for UI to settle` }),
  },
  {
    // expect(find.text('Hello'), findsOneWidget) / findsWidgets / findsNothing
    regex: /expect\(\s*find\.text\(\s*(['"`])([^'"` ]+)\1\s*\),\s*(findsOneWidget|findsWidgets)/,
    toStep: (m) => ({ isCheck: true, text: `"${m[2]}" is visible` }),
  },
  {
    // expect(find.text('Hello'), findsNothing)
    regex: /expect\(\s*find\.text\(\s*(['"`])([^'"` ]+)\1\s*\),\s*findsNothing/,
    toStep: (m) => ({ isCheck: true, text: `"${m[2]}" is not visible` }),
  },
  {
    // expect(find.byKey(Key('x')), findsOneWidget)
    regex: /expect\(\s*find\.byKey\(Key\(\s*(['"`])([^'"` ]+)\1\s*\)\),\s*(findsOneWidget|findsWidgets)/,
    toStep: (m) => ({ isCheck: true, text: `"${prettifySelector(m[2])}" widget is present` }),
  },

  // ── Assertions / Checks ───────────────────────────────────────────────────
  {
    // expect(page).toHaveURL(/pattern/) or toHaveURL('url')
    regex: /\.toHaveURL\(\s*\/([^/]+)\//,
    toStep: (m) => ({ isCheck: true, text: `URL matches /${m[1]}/` }),
  },
  {
    regex: /\.toHaveURL\(\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: true, text: `URL equals "${m[2]}"` }),
  },
  {
    // toHaveUrlContaining — WebdriverIO
    regex: /\.toHaveUrlContaining\(\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: true, text: `URL contains "${m[2]}"` }),
  },
  {
    regex: /\.toHaveText\(\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: true, text: `text equals "${m[2]}"` }),
  },
  {
    regex: /\.toContainText\(\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: true, text: `text contains "${m[2]}"` }),
  },
  {
    regex: /\.toContain\(\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: true, text: `result contains "${m[2]}"` }),
  },
  {
    regex: /\.toEqual\(\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: true, text: `value equals "${m[2]}"` }),
  },
  {
    regex: /\.toBe\(\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: true, text: `value equals "${m[2]}"` }),
  },
  {
    regex: /\.toBe\(\s*(\d+)\)/,
    toStep: (m) => ({ isCheck: true, text: `value equals ${m[1]}` }),
  },
  {
    regex: /\.toHaveCount\(\s*(\d+)/,
    toStep: (m) => ({ isCheck: true, text: `count equals ${m[1]}` }),
  },
  {
    regex: /\.toBeVisible\(\)/,
    toStep: (_m) => ({ isCheck: true, text: `element is visible` }),
  },
  {
    // assertEquals("expected", actual) — JUnit / TestNG
    regex: /(?:assertEquals|Assert\.assertEquals)\(\s*(['"`])([^'"` ]+)\1\s*,/,
    toStep: (m) => ({ isCheck: true, text: `value equals "${m[2]}"` }),
  },
  {
    // assertEquals(number, actual) — JUnit
    regex: /(?:assertEquals|Assert\.assertEquals)\(\s*(\d+)\s*,/,
    toStep: (m) => ({ isCheck: true, text: `count equals ${m[1]}` }),
  },
  {
    regex: /assertTrue\(([^,)]{3,60})\)/,
    toStep: (m) => ({ isCheck: true, text: `${m[1].trim()} is true` }),
  },
  {
    // Assert.AreEqual("expected", actual) — C# MSTest
    regex: /Assert\.AreEqual\(\s*(['"`])([^'"` ]+)\1\s*,/,
    toStep: (m) => ({ isCheck: true, text: `value equals "${m[2]}"` }),
  },
  {
    // StringAssert.Contains("x", ...) — C#
    regex: /StringAssert\.Contains\(\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: true, text: `text contains "${m[2]}"` }),
  },
  {
    // Assert.That(x, Is.EqualTo("y")) — NUnit
    regex: /Is\.EqualTo\(\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: true, text: `value equals "${m[2]}"` }),
  },
  {
    // Does.Contain("y") — NUnit
    regex: /Does\.Contain\(\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: true, text: `text contains "${m[2]}"` }),
  },
  {
    // assert x == "y" — Python
    regex: /assert\s+\w+\s*==\s*(['"`])([^'"` ]+)\1/,
    toStep: (m) => ({ isCheck: true, text: `value equals "${m[2]}"` }),
  },
  {
    // assert "x" in y — Python
    regex: /assert\s+(['"`])([^'"` ]+)\1\s+in\s+/,
    toStep: (m) => ({ isCheck: true, text: `result contains "${m[2]}"` }),
  },
  {
    // assert "x" in driver.current_url — Python URL check
    regex: /assert\s+(['"`])([^'"` ]+)\1\s+in\s+\w+\.current_url/,
    toStep: (m) => ({ isCheck: true, text: `URL contains "${m[2]}"` }),
  },
];

// ─── Title derivation from method name ────────────────────────────────────────

function methodNameToTitle(name: string): string {
  return name
    .replace(/^(test_?|Test)/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
}

// ─── Heuristic summary ────────────────────────────────────────────────────────

export function heuristicSummary(
  body: string,
  fallbackTitle: string
): { title: string; description: string; steps: ParsedStep[] } {
  const steps: ParsedStep[] = [];
  const seenKeys = new Set<string>();

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      trimmed.startsWith('//') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('"""') ||
      trimmed.startsWith("'''")
    ) continue;

    for (const rule of PATTERNS) {
      const m = trimmed.match(rule.regex);
      if (!m) continue;
      const result = rule.toStep(m);
      if (!result) continue;
      const key = result.text.toLowerCase();
      if (seenKeys.has(key)) break;
      seenKeys.add(key);
      steps.push({ keyword: result.isCheck ? 'Then' : 'Step', text: result.text });
      break;
    }
  }

  const title = methodNameToTitle(fallbackTitle) || fallbackTitle;
  const description = buildHeuristicDescription(title, steps);

  return { title, description, steps };
}

function buildHeuristicDescription(title: string, steps: ParsedStep[]): string {
  const checks = steps.filter((s) => s.keyword === 'Then').map((s) => s.text);
  if (checks.length === 0) return `Verifies that ${title}.`;
  if (checks.length === 1) return `Verifies that ${checks[0]}.`;
  return `Verifies that ${checks.slice(0, -1).join(', ')} and ${checks[checks.length - 1]}.`;
}

// ─── LLM prompt ───────────────────────────────────────────────────────────────

const PROMPT_TEMPLATE = `You are a test documentation assistant. Given the test function below, produce a title, a short description, and numbered steps suitable for an Azure DevOps Test Case.

Rules:
- Title: one concise line (not the function name, a human-readable description)
- Description: 1-2 sentences explaining what the test verifies and any important preconditions. Do not repeat the title verbatim.
- Steps: numbered list. Actions → "N. Do X". Assertions → "N. Check: Y"
- Output ONLY the title, description, and numbered steps — no preamble or explanation.

Expected output format:
Title: <title>
Description: <1-2 sentence description>
1. <first action step>
2. <second action step>
N. Check: <expected result>

Test function:
{CODE}`;

function buildPrompt(code: string): string {
  return PROMPT_TEMPLATE.replace('{CODE}', code);
}

function parseAiResponse(
  raw: string,
  fallbackTitle: string
): { title: string; description: string; steps: ParsedStep[] } {
  const lines = raw.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  let title = fallbackTitle;
  let description = '';
  const steps: ParsedStep[] = [];

  for (const line of lines) {
    const titleM = line.match(/^Title:\s*(.+)$/i);
    if (titleM) { title = titleM[1].trim(); continue; }

    const descM = line.match(/^Description:\s*(.+)$/i);
    if (descM) { description = descM[1].trim(); continue; }

    const stepM = line.match(/^(\d+)\.\s+(.+)$/);
    if (stepM) {
      const text = stepM[2].trim();
      const checkM = text.match(/^[Cc]heck:\s+(.+)$/);
      steps.push(checkM
        ? { keyword: 'Then', text: checkM[1].trim() }
        : { keyword: 'Step', text }
      );
    }
  }

  return { title, description, steps };
}

// ─── Provider implementations ─────────────────────────────────────────────────

// ─── Local LLM session cache ──────────────────────────────────────────────────
// Llama model and context are expensive to load. Cache them keyed by model path
// so the same model is only loaded once per process even when summarizing many tests.

interface LlamaSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  LlamaChatSession: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any;
}

const llamaSessionCache = new Map<string, Promise<LlamaSession>>();

async function getLlamaSession(modelPath: string): Promise<LlamaSession> {
  const cached = llamaSessionCache.get(modelPath);
  if (cached) return cached;

  const promise = (async (): Promise<LlamaSession> => {
    // new Function bypasses TypeScript's CJS transform so the import() call is
    // emitted as a true ESM dynamic import at runtime, not as require().
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-explicit-any
    const esmImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const llamaModule: any = await esmImport('node-llama-cpp');

    const { getLlama, LlamaChatSession } = llamaModule;
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath });
    const context = await model.createContext();
    return { LlamaChatSession, context };
  })();

  llamaSessionCache.set(modelPath, promise);
  return promise;
}

/**
 * node-llama-cpp provider — runs a GGUF model directly in-process.
 * The llama context is cached per model path so it is only loaded once
 * for the whole push run, regardless of how many tests are summarized.
 */
async function localLlamaSummary(
  code: string,
  fallbackTitle: string,
  modelPath: string
): Promise<{ title: string; description: string; steps: ParsedStep[] }> {
  const { LlamaChatSession, context } = await getLlamaSession(modelPath);
  const session = new LlamaChatSession({ contextSequence: context.getSequence() });
  const response: string = await session.prompt(buildPrompt(code));
  return parseAiResponse(response, fallbackTitle);
}

async function ollamaSummary(
  code: string,
  fallbackTitle: string,
  model: string,
  baseUrl: string
): Promise<{ title: string; description: string; steps: ParsedStep[] }> {
  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: buildPrompt(code), stream: false }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = await res.json() as { response?: string };
  return parseAiResponse(data.response ?? '', fallbackTitle);
}

async function openaiSummary(
  code: string,
  fallbackTitle: string,
  model: string,
  apiKey: string,
  baseUrl: string
): Promise<{ title: string; description: string; steps: ParsedStep[] }> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: buildPrompt(code) }],
      temperature: 0,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return parseAiResponse(data.choices?.[0]?.message?.content ?? '', fallbackTitle);
}

async function anthropicSummary(
  code: string,
  fallbackTitle: string,
  model: string,
  apiKey: string
): Promise<{ title: string; description: string; steps: ParsedStep[] }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      messages: [{ role: 'user', content: buildPrompt(code) }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json() as { content?: Array<{ text?: string }> };
  return parseAiResponse(data.content?.[0]?.text ?? '', fallbackTitle);
}

function resolveEnvVar(value: string): string {
  if (value.startsWith('$')) return process.env[value.slice(1)] ?? value;
  return value;
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Generate a title, description, and steps for a test that has no doc comment.
 * Mutates nothing — returns new values; callers assign them.
 */
export async function summarizeTest(
  test: ParsedTest,
  localType: LocalType,
  opts: AiSummaryOpts
): Promise<{ title: string; description: string; steps: ParsedStep[] }> {
  // Extract the raw function body for pattern matching / LLM context
  let body = '';
  try {
    body = extractFunctionBody(test.filePath, test.line, localType);
  } catch {
    // Can't read body — heuristic will produce an empty step list
  }

  const fallbackTitle = test.title;

  if (opts.provider === 'heuristic' || !body) {
    return heuristicSummary(body, fallbackTitle);
  }

  // local provider requires a model path
  if (opts.provider === 'local' && !opts.model) {
    process.stderr.write(
      `  [ai-summary] local provider requires --ai-model <path/to/model.gguf>, falling back to heuristic\n`
    );
    return heuristicSummary(body, fallbackTitle);
  }

  const heuristicFallback = opts.heuristicFallback ?? true;

  try {
    switch (opts.provider) {
      case 'local':
        return await localLlamaSummary(body, fallbackTitle, opts.model!);
      case 'ollama':
        return await ollamaSummary(
          body, fallbackTitle,
          opts.model ?? 'qwen2.5-coder:7b',
          opts.baseUrl ?? 'http://localhost:11434'
        );
      case 'openai':
        return await openaiSummary(
          body, fallbackTitle,
          opts.model ?? 'gpt-4o-mini',
          resolveEnvVar(opts.apiKey ?? ''),
          opts.baseUrl ?? 'https://api.openai.com/v1'
        );
      case 'anthropic':
        return await anthropicSummary(
          body, fallbackTitle,
          opts.model ?? 'claude-haiku-4-5-20251001',
          resolveEnvVar(opts.apiKey ?? '')
        );
    }
  } catch (err: any) {
    if (heuristicFallback) {
      process.stderr.write(`  [ai-summary] ${opts.provider} failed (${err.message}), falling back to heuristic\n`);
      return heuristicSummary(body, fallbackTitle);
    }
    throw err;
  }

  return heuristicSummary(body, fallbackTitle);
}
