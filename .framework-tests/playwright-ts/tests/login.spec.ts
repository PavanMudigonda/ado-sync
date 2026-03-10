// @ts-nocheck
import { test, expect } from '@playwright/test';

const BASE_URL = 'https://www.saucedemo.com';

test.describe('SauceDemo Login', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL);
  });

  /**
   * Valid credentials redirect to the inventory page.
   * 1. Enter username "standard_user" and password "secret_sauce"
   * 2. Click the login button
   * 3. Check: URL contains /inventory.html
   */
  test('valid credentials redirect to inventory page', {
    annotation: { type: 'tc', description: '33008' },
    tag: '@smoke',
  }, async ({ page }) => {
    await page.fill('#user-name', 'standard_user');
    await page.fill('#password', 'secret_sauce');
    await page.click('#login-button');
    await expect(page).toHaveURL(/inventory\.html/);
  });

  /**
   * Locked-out user sees an error banner.
   * 1. Enter username "locked_out_user" and password "secret_sauce"
   * 2. Click the login button
   * 3. Check: error banner contains "locked out"
   */
  test('locked out user sees error banner', {
    annotation: { type: 'tc', description: '33009' },
  }, async ({ page }) => {
    await page.fill('#user-name', 'locked_out_user');
    await page.fill('#password', 'secret_sauce');
    await page.click('#login-button');
    await expect(page.locator("[data-test='error']")).toContainText('locked out');
  });

  /**
   * Empty username shows a validation error.
   * 1. Leave username empty, enter password "secret_sauce"
   * 2. Click the login button
   * 3. Check: error message is "Epic sadface: Username is required"
   */
  test('empty username shows validation error', {
    annotation: { type: 'tc', description: '33010' },
  }, async ({ page }) => {
    await page.fill('#password', 'secret_sauce');
    await page.click('#login-button');
    await expect(page.locator("[data-test='error']")).toHaveText(
      'Epic sadface: Username is required'
    );
  });

});
