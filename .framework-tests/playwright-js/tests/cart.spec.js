// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = 'https://www.saucedemo.com';

async function login(page, user = 'standard_user') {
  await page.goto(BASE_URL);
  await page.fill('#user-name', user);
  await page.fill('#password', 'secret_sauce');
  await page.click('#login-button');
  await page.waitForURL(/inventory\.html/);
}

// ─── Core cart tests ──────────────────────────────────────────────────────────

test.describe('SauceDemo Cart', () => {

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  /**
   * Adding an item updates the cart badge to 1.
   * 1. Click "Add to cart" for Sauce Labs Backpack
   * 2. Check: shopping cart badge shows "1"
   */
  // @tags: smoke, regression
  test('adding an item updates the cart badge to 1', { annotation: { type: 'tc', description: '33023' } }, async ({ page }) => {
    await page.locator("[data-test='add-to-cart-sauce-labs-backpack']").click();
    await expect(page.locator('.shopping_cart_badge')).toHaveText('1');
  });

  /**
   * Removing one of two items decrements the cart badge to 1.
   * 1. Add Sauce Labs Backpack and Sauce Labs Bike Light to cart
   * 2. Remove Sauce Labs Bike Light
   * 3. Check: shopping cart badge shows "1"
   */
  // @tags: regression
  test('removing an item decrements the cart badge', { annotation: { type: 'tc', description: '33024' } }, async ({ page }) => {
    await page.locator("[data-test='add-to-cart-sauce-labs-backpack']").click();
    await page.locator("[data-test='add-to-cart-sauce-labs-bike-light']").click();
    await page.locator("[data-test='remove-sauce-labs-bike-light']").click();
    await expect(page.locator('.shopping_cart_badge')).toHaveText('1');
  });

  /**
   * Cart page shows the correct price for the added item.
   * 1. Add Sauce Labs Backpack to cart
   * 2. Navigate to the shopping cart
   * 3. Check: item price displayed is "$29.99"
   */
  // @tags: regression
  test('cart page shows correct price for added item', { annotation: { type: 'tc', description: '33025' } }, async ({ page }) => {
    await page.locator("[data-test='add-to-cart-sauce-labs-backpack']").click();
    await page.locator('.shopping_cart_link').click();
    await expect(page.locator('.inventory_item_price')).toHaveText('$29.99');
  });

  /**
   * Removing an item from the cart page clears the cart badge.
   * 1. Add Sauce Labs Backpack to cart
   * 2. Navigate to the shopping cart and click Remove
   * 3. Check: cart badge is no longer visible
   */
  test('removing an item from cart page hides the badge', { annotation: { type: 'tc', description: '33026' } }, async ({ page }) => {
    await page.locator("[data-test='add-to-cart-sauce-labs-backpack']").click();
    await page.locator('.shopping_cart_link').click();
    await page.locator("[data-test='remove-sauce-labs-backpack']").click();
    await expect(page.locator('.shopping_cart_badge')).not.toBeVisible();
  });

});

// ─── Parallel multi-item assertions ──────────────────────────────────────────

test.describe.parallel('SauceDemo Cart — multi-item', () => {

  /**
   * Adding all items shows correct badge count.
   * 1. Add Sauce Labs Backpack, Bike Light, Bolt T-Shirt, and Fleece Jacket
   * 2. Check: cart badge shows "4"
   */
  // @tags: regression
  test('badge shows correct count after adding four items', { annotation: { type: 'tc', description: '33027' } }, async ({ page }) => {
    await login(page);
    const items = [
      'add-to-cart-sauce-labs-backpack',
      'add-to-cart-sauce-labs-bike-light',
      'add-to-cart-sauce-labs-bolt-t-shirt',
      'add-to-cart-sauce-labs-fleece-jacket',
    ];
    for (const item of items) {
      await page.locator(`[data-test='${item}']`).click();
    }
    await expect(page.locator('.shopping_cart_badge')).toHaveText('4');
  });

  /**
   * Cart page lists all added items by name.
   * 1. Add Sauce Labs Backpack and Sauce Labs Bike Light
   * 2. Navigate to the shopping cart
   * 3. Check: both item names are visible in the cart
   */
  // @tags: regression
  test('cart page lists all added item names', { annotation: { type: 'tc', description: '33028' } }, async ({ page }) => {
    await login(page);
    await page.locator("[data-test='add-to-cart-sauce-labs-backpack']").click();
    await page.locator("[data-test='add-to-cart-sauce-labs-bike-light']").click();
    await page.locator('.shopping_cart_link').click();
    await expect(page.locator('.cart_item_label')).toHaveCount(2);
  });

});

// ─── test.fixme — pending feature ─────────────────────────────────────────────

test.describe('SauceDemo Cart — known issues', () => {

  /**
   * Saved cart persists after page reload.
   * 1. Add Sauce Labs Backpack to cart
   * 2. Reload the page
   * 3. Check: cart badge still shows "1" (session persistence)
   */
  // @tags: wip
  test.fixme('cart persists after page reload (session storage not implemented)', { annotation: { type: 'tc', description: '33029' } }, async ({ page }) => {
    await login(page);
    await page.locator("[data-test='add-to-cart-sauce-labs-backpack']").click();
    await page.reload();
    await expect(page.locator('.shopping_cart_badge')).toHaveText('1');
  });

});
