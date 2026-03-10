const { Builder, By, until } = require('selenium-webdriver');

const BASE_URL = 'https://www.saucedemo.com';

describe('SauceDemo Cart', () => {
  let driver;

  beforeEach(async () => {
    driver = await new Builder().forBrowser('chrome').build();
    await driver.get(BASE_URL);
    await driver.findElement(By.id('user-name')).sendKeys('standard_user');
    await driver.findElement(By.id('password')).sendKeys('secret_sauce');
    await driver.findElement(By.id('login-button')).click();
    await driver.wait(until.urlContains('inventory'), 5000);
  });

  afterEach(async () => {
    await driver.quit();
  });

  /**
   * Adding an item updates the cart badge to 1.
   * 1. Log in as standard_user and navigate to the inventory page
   * 2. Click add-to-cart for Sauce Labs Backpack
   * 3. Check: shopping cart badge text equals "1"
   */
  // @tc:32993
  it('adding an item updates the cart badge to 1', async () => {
    await driver.findElement(By.css("[data-test='add-to-cart-sauce-labs-backpack']")).click();
    const badge = await driver.findElement(By.className('shopping_cart_badge')).getText();
    expect(badge).toBe('1');
  });

  /**
   * Removing one item from two decrements the cart badge to 1.
   * 1. Add Sauce Labs Backpack and Bike Light to cart
   * 2. Click Remove for Sauce Labs Bike Light
   * 3. Check: shopping cart badge text equals "1"
   */
  // @tc:32994
  it('removing an item decrements the cart badge', async () => {
    await driver.findElement(By.css("[data-test='add-to-cart-sauce-labs-backpack']")).click();
    await driver.findElement(By.css("[data-test='add-to-cart-sauce-labs-bike-light']")).click();
    await driver.findElement(By.css("[data-test='remove-sauce-labs-bike-light']")).click();
    const badge = await driver.findElement(By.className('shopping_cart_badge')).getText();
    expect(badge).toBe('1');
  });

  /**
   * Cart page shows the correct price for the added item.
   * 1. Add Sauce Labs Backpack to cart and navigate to cart page
   * 2. Check: item price displayed equals "$29.99"
   */
  // @tc:32995
  it('cart page shows correct price for added item', async () => {
    await driver.findElement(By.css("[data-test='add-to-cart-sauce-labs-backpack']")).click();
    await driver.findElement(By.className('shopping_cart_link')).click();
    const price = await driver.findElement(By.className('inventory_item_price')).getText();
    expect(price).toBe('$29.99');
  });
});
