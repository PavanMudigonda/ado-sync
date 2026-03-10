import { device, element, by, expect as detoxExpect } from 'detox';

describe('SauceDemo Cart', () => {
  beforeAll(async () => {
    await device.launchApp();
  });

  beforeEach(async () => {
    await device.reloadReactNative();
    // Log in before each test
    await element(by.id('username')).typeText('standard_user');
    await element(by.id('password')).typeText('secret_sauce');
    await element(by.id('login-button')).tap();
    await detoxExpect(element(by.id('inventory-screen'))).toBeVisible();
  });

  /**
   * Adding an item updates the cart badge to 1.
   * 1. Log in and navigate to the inventory screen
   * 2. Tap "Add to Cart" for Sauce Labs Backpack
   * 3. Check: cart badge shows "1"
   */
  // @tc:33114
  it('adding an item updates the cart badge to 1', async () => {
    await element(by.id('add-to-cart-sauce-labs-backpack')).tap();
    await detoxExpect(element(by.id('shopping-cart-badge'))).toHaveText('1');
  });

  /**
   * Removing an item decrements the cart badge.
   * 1. Add Sauce Labs Backpack and Bike Light to cart
   * 2. Tap "Remove" for Sauce Labs Bike Light
   * 3. Check: cart badge shows "1"
   */
  // @tc:33115
  it('removing an item decrements the cart badge', async () => {
    await element(by.id('add-to-cart-sauce-labs-backpack')).tap();
    await element(by.id('add-to-cart-sauce-labs-bike-light')).tap();
    await element(by.id('remove-sauce-labs-bike-light')).tap();
    await detoxExpect(element(by.id('shopping-cart-badge'))).toHaveText('1');
  });

  /**
   * Cart screen shows correct item name and price.
   * 1. Add Sauce Labs Backpack to the cart
   * 2. Tap the cart icon to open the cart screen
   * 3. Check: item name "Sauce Labs Backpack" is visible
   * 4. Check: item price "$29.99" is visible
   */
  // @tc:33116
  it('cart screen shows correct item name and price', async () => {
    await element(by.id('add-to-cart-sauce-labs-backpack')).tap();
    await element(by.id('shopping-cart-link')).tap();
    await detoxExpect(element(by.text('Sauce Labs Backpack'))).toBeVisible();
    await detoxExpect(element(by.text('$29.99'))).toBeVisible();
  });
});
