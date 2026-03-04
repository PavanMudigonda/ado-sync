# SauceDemo — Basic Checkout Operations Test Plan

## Executive summary

This document describes a comprehensive, runnable test plan for basic checkout flows on the Sauce Labs demo app (https://www.saucedemo.com/). It focuses on the core user journeys needed to validate add-to-cart, cart management, checkout information, order completion, and common error & edge cases. The plan assumes tests run from a fresh browser state (no prior auth or cart items).

Scope:
- Login and authentication checks relevant to checkout
- Adding/removing items from cart
- Checkout flow (Checkout: Information -> Overview -> Finish)
- Totals/tax verification and itemization
- Error handling and negative scenarios (missing info, locked-out accounts)
- Small robustness checks (navigation, persistence, performance user)

Out of scope:
- Accessibility conformance tests beyond simple ARIA checks
- Load/stress testing beyond a single user/session
- Payment gateway or third-party integrations (not part of the demo)

## Test environment & prerequisites

Assumptions:
- Always start from a fresh browser session (clear cookies/localStorage) unless the scenario states otherwise.
- Tests run against https://www.saucedemo.com/ (latest)
- Valid public test credentials (visible on the login page):
  - Username: `standard_user`
  - Password: `secret_sauce`
- Other relevant accounts (for negative/edge cases): `locked_out_user`, `problem_user`, `performance_glitch_user`.

Recommended test platforms: latest Chrome, Firefox, and Safari (desktop). Mobile/responsive checks can be added later.

Test data examples:
- Basic user: standard_user / secret_sauce
- Checkout info happy path: First Name: `Test`; Last Name: `User`; Postal Code: `12345`

## Page areas and primary controls (quick reference)

- Login page
  - Username input
  - Password input
  - Login button
- Inventory page (product list)
  - Product Add to cart buttons (per item)
  - Cart icon / badge (top-right)
  - Filter/sort dropdown
- Cart page
  - List of added items
  - Remove button (per item)
  - Continue Shopping / Checkout buttons
- Checkout: Your Information
  - First Name, Last Name, Postal Code inputs
  - Cancel, Continue buttons
- Checkout: Overview
  - Itemized list, Item total, Tax, Total
  - Finish button
- Checkout: Complete
  - Confirmation message ("THANK YOU FOR YOUR ORDER")
  - Back Home button

## Test scenarios

Each scenario assumes a blank/fresh state unless noted. Steps are written so any tester can follow them manually or translate them to automated tests.

### 1. Login (happy path)

Assumption: Fresh browser session, user at `https://www.saucedemo.com/`.

Steps:
1. Enter username `standard_user` in the Username field.
2. Enter password `secret_sauce` in the Password field.
3. Click `Login`.

Expected results:
- User is redirected to `/inventory.html`.
- Product list is visible.

Success criteria: Redirect to inventory and product cards render.
Failure conditions: Remains on login page or an error message appears.

---

### 2. Add a single item to cart and complete checkout (happy path)

Assumptions: Logged in as `standard_user`. Fresh session.

Steps:
1. From the inventory page, click `Add to cart` for the product "Sauce Labs Backpack".
2. Verify the cart badge increments to `1`.
3. Click the cart icon to go to the cart page.
4. Verify the added item appears in the cart with the correct name and price.
5. Click `Checkout`.
6. On the Checkout: Your Information page, fill First Name `Test`, Last Name `User`, Postal Code `12345`.
7. Click `Continue`.
8. On the Overview page, verify:
   - The item appears with the same name and price.
   - Item total equals the sum of item prices.
   - Tax is displayed and > 0.
   - Total equals item total + tax.
9. Click `Finish`.

Expected results:
- After Finish, user sees the completion page with text like "THANK YOU FOR YOUR ORDER".
- Cart badge is cleared (often back to zero) after completion or on returning home.

Success criteria: Order completes and confirmation page is shown.
Failure conditions: Price mismatch, missing tax, incomplete flow, or errors on Finish.

---

### 3. Add multiple items and verify totals (2 or more items)

Assumptions: Logged in as `standard_user`.

Steps:
1. Add 3 different items to the cart (e.g., Backpack, Bike Light, Bolt T-Shirt).
2. Verify the cart badge shows `3`.
3. Go to cart, verify 3 items listed with individual prices.
4. Click `Checkout` -> fill information -> `Continue`.
5. On Overview, compute expected item total (sum of prices). Verify displayed Item total equals computed value.
6. Verify Tax calculation and that Total = Item total + Tax.
7. Finish and confirm completion page.

Expected results:
- Item total, tax, and total are correct and consistent with item prices.

Edge checks:
- If any price text uses currency formatting (e.g., `$`), parse accordingly.

Failure conditions: Any mismatch in totals or missing items.

---

### 4. Remove an item from the cart before checkout

Assumptions: Logged in as `standard_user` and at least 2 items in cart.

Steps:
1. Add two items.
2. Open cart and click `Remove` for one item.
3. Verify cart badge decrements accordingly.
4. Proceed to Checkout -> fill info -> Continue.
5. Verify Overview only lists the remaining item and totals match.

Expected results:
- Removed item not present at overview and totals adjusted.

Failure conditions: Removed item still appears or totals don't change.

---

### 5. Checkout with missing required fields (negative)

Assumptions: Logged in and at least one item in cart.

Steps:
1. Start Checkout.
2. Leave First Name blank; fill Last Name and Postal Code.
3. Click `Continue`.
4. Repeat for each required field left blank in isolation.

Expected results:
- The form prevents progress and shows an inline error/message indicating required fields.

Success criteria: Each required field blocks continuation when empty.
Failure condition: Form submits with missing data or no error is shown.

---

### 6. Direct checkout URL access without items in cart (edge case)

Assumptions: Fresh session, logged in as `standard_user`, cart empty.

Steps:
1. From inventory, navigate manually to `/checkout-step-one.html` (paste URL).

Expected results:
- Either the app redirects to cart/inventory or shows an appropriate empty-cart behavior. It should not allow a successful order without items.

Failure conditions: The app allows a checkout flow to finish with no items or throws an unexpected error.

---

### 7. Locked out user (login negative test relevant to checkout)

Assumptions: Fresh session.

Steps:
1. Attempt login with username `locked_out_user` and password `secret_sauce`.

Expected results:
- Login is blocked and a message appears indicating account is locked.
- No access to inventory or checkout pages.

Success criteria: Proper error message and no redirect.

---

### 8. Problem user / visual anomalies (UI correctness)

Context: The `problem_user` account may show UI problems intentionally.

Steps:
1. Login with `problem_user` / `secret_sauce`.
2. Browse inventory, add an item to cart, navigate to cart.

Expected results:
- Identify visual or functional anomalies (images missing, incorrect product pages, inconsistent behavior). Document findings with screenshots.

Success criteria: Any anomalies are captured as bugs with reproduction steps.

---

### 9. Performance glitch user (slow-loading) — robustness check

Context: `performance_glitch_user` is intended to simulate slow responses.

Steps:
1. Login with `performance_glitch_user` / `secret_sauce`.
2. Time page load for inventory and checkout steps (use stopwatch or automated timing).

Expected results:
- App remains usable though slower; no failures or data corruption.

Failure conditions: Timeouts, JS errors, or broken UI navigation.

---

### 10. End-to-end persistence check (refresh during checkout)

Assumptions: Logged in, items in cart.

Steps:
1. Add an item to cart and go to Checkout: Your Information.
2. Fill in First/Last/Postal but do not submit.
3. Refresh the browser.

Expected results:
- Determine whether the app retains the typed checkout info and cart state across refreshes.

Success criteria: Cart state persists (items remain); checkout inputs may or may not persist depending on app design — document observed behavior.

Failure conditions: Cart items are lost unexpectedly or the app crashes.

---

## Test data matrix (quick)

- standard_user: happy paths (#1, #2, #3, #4, #10)
- locked_out_user: negative (#7)
- problem_user: UI anomaly (#8)
- performance_glitch_user: load/timeout checks (#9)

## Reporting / success criteria

- Tests marked PASS when UI and data states match expected results and totals calculations are correct.
- Tests marked FAIL when any of the failure conditions listed in each scenario occur.
- For any failing visual or performance tests, capture a screenshot and console logs and include steps to reproduce.

## Optional automation suggestions

- Automate these scenarios using Playwright or Cypress. Create small helpers:
  - login(username, password)
  - addToCart(itemName)
  - openCart()
  - checkout(info)
  - computePricesFromUI()
- Add unit tests for parsing price strings to numbers to avoid formatting errors during automated verification.

## Attachments / Evidence

- For manual runs: collect screenshots of any failures.
- For automated runs: capture Playwright traces (or browser console logs) when a test fails.

---

## Appendix: Quick run checklist for a tester

1. Start fresh browser session (clear site data).
2. Run Login (scenario 1).
3. Run Add & Checkout (scenario 2).
4. Run Multi-item totals check (scenario 3).
5. Run Remove item (scenario 4).
6. Run Checkout form negative checks (scenario 5).
7. Run Locked out and problem user checks (7 & 8).
8. Capture issues and files.


---

End of document.
