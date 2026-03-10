// @ts-nocheck
import { test, expect } from '@playwright/test';

test.describe('SauceDemo Inventory', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('https://www.saucedemo.com');
    await page.fill('#user-name', 'standard_user');
    await page.fill('#password', 'secret_sauce');
    await page.click('#login-button');
    await page.waitForURL(/inventory\.html/);
  });

  /**
   * Inventory page shows six products.
   * 1. Log in as standard_user
   * 2. Check: the inventory list contains exactly 6 items
   */
  test('inventory page shows six products', {
    annotation: { type: 'tc', description: '33005' },
    tag: '@smoke',
  }, async ({ page }) => {
    const items = page.locator('.inventory_item');
    await expect(items).toHaveCount(6);
  });

  /**
   * Sort by price low to high reorders items.
   * 1. Select "Price (low to high)" from the sort dropdown
   * 2. Check: the first item price is "$9.99"
   */
  test('sort by price low to high reorders items', {
    annotation: { type: 'tc', description: '33006' },
  }, async ({ page }) => {
    await page.selectOption('.product_sort_container', 'lohi');
    const firstPrice = page.locator('.inventory_item_price').first();
    await expect(firstPrice).toHaveText('$9.99');
  });

  /**
   * Product detail page shows name and price.
   * 1. Click the first product name in the inventory list
   * 2. Check: product name label is visible
   * 3. Check: product price label is visible
   */
  test('product detail page shows name and price', {
    annotation: { type: 'tc', description: '33007' },
  }, async ({ page }) => {
    await page.locator('.inventory_item_name').first().click();
    await expect(page.locator('.inventory_details_name')).toBeVisible();
    await expect(page.locator('.inventory_details_price')).toBeVisible();
  });

});
