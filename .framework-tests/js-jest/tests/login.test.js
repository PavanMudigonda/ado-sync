const { Builder, By, until } = require('selenium-webdriver');

const BASE_URL = 'https://www.saucedemo.com';

describe('SauceDemo Login', () => {
  let driver;

  beforeEach(async () => {
    driver = await new Builder().forBrowser('chrome').build();
    await driver.get(BASE_URL);
  });

  afterEach(async () => {
    await driver.quit();
  });

  /**
   * Valid credentials redirect to the inventory page.
   * 1. Navigate to https://www.saucedemo.com
   * 2. Enter username "standard_user" and password "secret_sauce"
   * 3. Click the login button and wait for navigation
   * 4. Check: current URL contains "inventory.html"
   */
  // @tc:32996
  it('valid credentials redirect to inventory page', async () => {
    await driver.findElement(By.id('user-name')).sendKeys('standard_user');
    await driver.findElement(By.id('password')).sendKeys('secret_sauce');
    await driver.findElement(By.id('login-button')).click();
    await driver.wait(until.urlContains('inventory'), 5000);
    const url = await driver.getCurrentUrl();
    expect(url).toContain('inventory.html');
  });

  /**
   * Locked-out user sees an error banner.
   * 1. Navigate to https://www.saucedemo.com
   * 2. Enter username "locked_out_user" and password "secret_sauce"
   * 3. Click the login button
   * 4. Check: error banner text contains "locked out"
   */
  // @tc:32997
  it('locked out user sees error banner', async () => {
    await driver.findElement(By.id('user-name')).sendKeys('locked_out_user');
    await driver.findElement(By.id('password')).sendKeys('secret_sauce');
    await driver.findElement(By.id('login-button')).click();
    const error = await driver.findElement(By.css("[data-test='error']")).getText();
    expect(error).toContain('locked out');
  });

  /**
   * Empty username field shows a validation error.
   * 1. Navigate to https://www.saucedemo.com
   * 2. Enter password "secret_sauce" without filling in the username
   * 3. Click the login button
   * 4. Check: error message equals "Epic sadface: Username is required"
   */
  // @tc:32998
  it('empty username shows validation error', async () => {
    await driver.findElement(By.id('password')).sendKeys('secret_sauce');
    await driver.findElement(By.id('login-button')).click();
    const error = await driver.findElement(By.css("[data-test='error']")).getText();
    expect(error).toBe('Epic sadface: Username is required');
  });
});
