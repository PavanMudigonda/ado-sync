const { Selector } = require('testcafe');

const BASE_URL = 'https://www.saucedemo.com';

fixture('SauceDemo Cart')
  .page(BASE_URL)
  .beforeEach(async t => {
    // Sign in before each cart test
    await t
      .typeText('#user-name', 'standard_user')
      .typeText('#password', 'secret_sauce')
      .click('#login-button');
  });

/**
 * Adding an item updates the cart badge to 1.
 * 1. Tap "Add to cart" for Sauce Labs Backpack
 * 2. Check: cart badge shows "1"
 */
// @smoke
test.meta('tc', '33514')('adding an item updates the cart badge to 1', async t => {
  await t
    .click('[data-test="add-to-cart-sauce-labs-backpack"]')
    .expect(Selector('.shopping_cart_badge').innerText).eql('1');
});

/**
 * Removing an item decrements the cart badge.
 * 1. Add Sauce Labs Backpack and Sauce Labs Bike Light to the cart
 * 2. Remove Sauce Labs Bike Light
 * 3. Check: cart badge shows "1"
 */
test.meta('tc', '33515')('removing an item decrements the cart badge', async t => {
  await t
    .click('[data-test="add-to-cart-sauce-labs-backpack"]')
    .click('[data-test="add-to-cart-sauce-labs-bike-light"]')
    .click('[data-test="remove-sauce-labs-bike-light"]')
    .expect(Selector('.shopping_cart_badge').innerText).eql('1');
});

/**
 * Cart screen shows correct item name and price.
 * 1. Add Sauce Labs Backpack to the cart
 * 2. Open the shopping cart
 * 3. Check: item name "Sauce Labs Backpack" is visible
 * 4. Check: item price "$29.99" is visible
 */
test.meta('tc', '33516')('cart screen shows correct item name and price', async t => {
  await t
    .click('[data-test="add-to-cart-sauce-labs-backpack"]')
    .click('.shopping_cart_link')
    .expect(Selector('.inventory_item_name').withText('Sauce Labs Backpack').exists).ok()
    .expect(Selector('.inventory_item_price').withText('$29.99').exists).ok();
});

/**
 * Checkout flow completes successfully.
 * 1. Add Sauce Labs Backpack to the cart and open the cart
 * 2. Click Checkout and fill in First Name, Last Name, and Zip Code
 * 3. Click Continue, then Finish
 * 4. Check: confirmation message "Thank you for your order!" is visible
 */
test.meta({ tc: '33517', priority: 'high' })('checkout flow completes successfully', async t => {
  await t
    .click('[data-test="add-to-cart-sauce-labs-backpack"]')
    .click('.shopping_cart_link')
    .click('[data-test="checkout"]')
    .typeText('[data-test="firstName"]', 'Test')
    .typeText('[data-test="lastName"]', 'User')
    .typeText('[data-test="postalCode"]', '12345')
    .click('[data-test="continue"]')
    .click('[data-test="finish"]')
    .expect(Selector('.complete-header').innerText).eql('Thank you for your order!');
});
