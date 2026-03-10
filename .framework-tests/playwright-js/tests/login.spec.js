// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = 'https://www.saucedemo.com';

test.describe('SauceDemo Login', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL);
  });

  /**
   * Valid credentials redirect to the inventory page.
   * 1. Enter username "standard_user" and password "secret_sauce"
   * 2. Click the login button
   * 3. Check: URL contains inventory.html
   */
  // @tags: smoke, regression
  test('valid credentials redirect to inventory page', async ({ page }) => {
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
  // @tags: regression
  test('locked out user sees error banner', { annotation: { type: 'tc', description: '33030' } }, async ({ page }) => {
    await page.fill('#user-name', 'locked_out_user');
    await page.fill('#password', 'secret_sauce');
    await page.click('#login-button');
    await expect(page.locator("[data-test='error']")).toContainText('locked out');
  });

  /**
   * Empty username field shows a validation error.
   * 1. Enter password "secret_sauce" without filling in the username
   * 2. Click the login button
   * 3. Check: error message reads "Epic sadface: Username is required"
   */
  test('empty username shows validation error', async ({ page }) => {
    await page.fill('#password', 'secret_sauce');
    await page.click('#login-button');
    await expect(page.locator("[data-test='error']")).toHaveText(
      'Epic sadface: Username is required'
    );
  });

  /**
   * Empty password field shows a validation error.
   * 1. Enter username "standard_user" without filling in the password
   * 2. Click the login button
   * 3. Check: error message reads "Epic sadface: Password is required"
   */
  test('empty password shows validation error', { annotation: { type: 'tc', description: '33032' } }, async ({ page }) => {
    await page.fill('#user-name', 'standard_user');
    await page.click('#login-button');
    await expect(page.locator("[data-test='error']")).toHaveText(
      'Epic sadface: Password is required'
    );
  });

});

// ─── test.describe.serial — login session tests must run in order ─────────────

test.describe.serial('SauceDemo Login — session', () => {

  /**
   * Logging out returns the user to the login page.
   * 1. Log in as standard_user
   * 2. Open the burger menu and click Logout
   * 3. Check: URL is the base SauceDemo URL (login page)
   */
  // @tags: smoke
  test('logout redirects back to login page', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.fill('#user-name', 'standard_user');
    await page.fill('#password', 'secret_sauce');
    await page.click('#login-button');
    await page.waitForURL(/inventory\.html/);
    await page.locator('#react-burger-menu-btn').click();
    await page.locator('#logout_sidebar_link').click();
    await expect(page).toHaveURL(BASE_URL + '/');
  });

  /**
   * Navigating to inventory while logged out redirects to login.
   * 1. Navigate directly to /inventory.html without logging in
   * 2. Check: browser is redirected back to the login page
   */
  test('unauthenticated access to inventory redirects to login', { annotation: { type: 'tc', description: '33034' } }, async ({ page }) => {
    await page.goto(BASE_URL + '/inventory.html');
    await expect(page).toHaveURL(BASE_URL + '/');
  });

});
