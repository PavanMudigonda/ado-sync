// @ts-nocheck
import { test, expect } from '@playwright/test';

const BASE_URL = 'https://www.saucedemo.com';

/** Shared login helper */
async function login(page, user = 'standard_user') {
  await page.goto(BASE_URL);
  await page.fill('#user-name', user);
  await page.fill('#password', 'secret_sauce');
  await page.click('#login-button');
  await page.waitForURL(/inventory\.html/);
}

// ─── Nested describes ────────────────────────────────────────────────────────
// Demonstrates: test.describe containing a nested test.describe block.
// Both outer and inner suite names are captured as describe context.

test.describe('SauceDemo Checkout', () => {

  test.describe('Step 1 — Cart & information', () => {

    test.beforeEach(async ({ page }) => {
      await login(page);
      await page.locator("[data-test='add-to-cart-sauce-labs-backpack']").click();
      await page.locator('.shopping_cart_link').click();
    });

    /**
     * Cart shows correct item count before checkout.
     * 1. Add Sauce Labs Backpack to cart
     * 2. Navigate to shopping cart
     * 3. Check: cart list contains exactly one item
     */
    test('cart contains one item before checkout', {
      annotation: { type: 'tc', description: '33015' },
    }, async ({ page }) => {
      await expect(page.locator('.cart_item')).toHaveCount(1);
    });

    /**
     * Checkout information form accepts valid buyer details.
     * 1. Click Checkout button
     * 2. Fill First Name, Last Name, and Zip Code
     * 3. Click Continue
     * 4. Check: step-two page is shown
     */
    test('valid buyer information advances to step two', {
      annotation: { type: 'tc', description: '33016' },
    }, async ({ page }) => {
      await page.locator("[data-test='checkout']").click();
      await page.fill("[data-test='firstName']", 'Jane');
      await page.fill("[data-test='lastName']", 'Doe');
      await page.fill("[data-test='postalCode']", '10001');
      await page.locator("[data-test='continue']").click();
      await expect(page).toHaveURL(/checkout-step-two/);
    });

  });

  test.describe('Step 2 — Order summary', () => {

    test.beforeEach(async ({ page }) => {
      await login(page);
      await page.locator("[data-test='add-to-cart-sauce-labs-backpack']").click();
      await page.locator('.shopping_cart_link').click();
      await page.locator("[data-test='checkout']").click();
      await page.fill("[data-test='firstName']", 'Jane');
      await page.fill("[data-test='lastName']", 'Doe');
      await page.fill("[data-test='postalCode']", '10001');
      await page.locator("[data-test='continue']").click();
    });

    /**
     * Order summary page shows item total.
     * 1. Complete checkout step 1
     * 2. Check: item total label is visible on step-two page
     */
    test('order summary page displays item total', {
      annotation: { type: 'tc', description: '33017' },
    }, async ({ page }) => {
      await expect(page.locator('.summary_subtotal_label')).toBeVisible();
    });

    /**
     * Finish button completes the order and shows confirmation.
     * 1. Click Finish on the order summary page
     * 2. Check: confirmation heading contains "Thank you"
     */
    test('finish button shows order confirmation', {
      annotation: { type: 'tc', description: '33018' },
    }, async ({ page }) => {
      await page.locator("[data-test='finish']").click();
      await expect(page.locator('.complete-header')).toHaveText('Thank you for your order!');
    });

  });

});

// ─── test.describe.parallel ──────────────────────────────────────────────────
// Demonstrates: test.describe.parallel — all tests in this suite run
// concurrently in separate workers (Playwright >= 1.10).

test.describe.parallel('SauceDemo Checkout — parallel assertions', () => {

  /**
   * Tax is applied on the order summary page.
   * 1. Log in as standard_user
   * 2. Add Sauce Labs Backpack to cart and proceed through checkout step 1
   * 3. Check: tax label is visible on the summary page
   */
  test('order summary includes a tax line', {
    annotation: { type: 'tc', description: '33019' },
    tag: '@regression',
  }, async ({ page }) => {
    await login(page);
    await page.locator("[data-test='add-to-cart-sauce-labs-backpack']").click();
    await page.locator('.shopping_cart_link').click();
    await page.locator("[data-test='checkout']").click();
    await page.fill("[data-test='firstName']", 'A');
    await page.fill("[data-test='lastName']", 'B');
    await page.fill("[data-test='postalCode']", '00000');
    await page.locator("[data-test='continue']").click();
    await expect(page.locator('.summary_tax_label')).toBeVisible();
  });

  /**
   * Cancel button on step 1 returns the user to the cart.
   * 1. Log in as standard_user and navigate to cart
   * 2. Click Checkout then click Cancel
   * 3. Check: URL contains /cart
   */
  test('cancel on step 1 returns to cart', {
    annotation: { type: 'tc', description: '33020' },
    tag: '@regression',
  }, async ({ page }) => {
    await login(page);
    await page.locator('.shopping_cart_link').click();
    await page.locator("[data-test='checkout']").click();
    await page.locator("[data-test='cancel']").click();
    await expect(page).toHaveURL(/cart/);
  });

});

// ─── test.fixme ───────────────────────────────────────────────────────────────
// Demonstrates: test.fixme — declared as a known broken test.
// azure-test-sync syncs it to Azure DevOps as a regular test case.

test.describe('SauceDemo Checkout — known issues', () => {

  /**
   * Promo code field is visible on the order summary page.
   * 1. Complete checkout steps 1 and 2
   * 2. Check: promo-code input is visible (feature not yet implemented)
   */
  test.fixme('promo code field is shown on order summary (not yet implemented)', {
    annotation: [
      { type: 'tc', description: '33021' },
      { type: 'issue', description: 'promo-code feature not yet implemented' },
    ],
    tag: '@wip',
  }, async ({ page }) => {
    await login(page);
    await page.locator("[data-test='add-to-cart-sauce-labs-backpack']").click();
    await page.locator('.shopping_cart_link').click();
    await page.locator("[data-test='checkout']").click();
    await page.fill("[data-test='firstName']", 'Jane');
    await page.fill("[data-test='lastName']", 'Doe');
    await page.fill("[data-test='postalCode']", '10001');
    await page.locator("[data-test='continue']").click();
    await expect(page.locator("[data-test='promo-code']")).toBeVisible();
  });

});

// ─── test.fail ────────────────────────────────────────────────────────────────
// Demonstrates: test.fail — the test is expected to fail.

test.describe('SauceDemo Checkout — expected failures', () => {

  /**
   * Checkout with an empty cart shows a warning (currently fails silently).
   * 1. Log in and go directly to checkout without adding items
   * 2. Click Checkout
   * 3. Check: empty-cart warning message is displayed
   */
  test.fail('empty cart checkout shows a warning (known failure)', {
    annotation: { type: 'tc', description: '33022' },
    tag: '@regression',
  }, async ({ page }) => {
    await login(page);
    await page.locator('.shopping_cart_link').click();
    await page.locator("[data-test='checkout']").click();
    await expect(page.locator("[data-test='error']")).toBeVisible();
  });

});
