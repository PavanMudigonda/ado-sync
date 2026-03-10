const { Selector } = require('testcafe');

fixture('SauceDemo Login')
  .page('https://www.saucedemo.com');

/**
 * Valid credentials navigate to the inventory page.
 * 1. Enter username "standard_user" into the username field
 * 2. Enter password "secret_sauce" into the password field
 * 3. Click the Login button
 * 4. Check: URL contains "inventory.html"
 */
// @smoke
test.meta('tc', '33510')('valid credentials navigate to inventory page', async t => {
  await t
    .typeText('#user-name', 'standard_user')
    .typeText('#password', 'secret_sauce')
    .click('#login-button')
    .expect(t.eval(() => window.location.href)).contains('inventory.html');
});

/**
 * Locked-out user sees an error message.
 * 1. Enter username "locked_out_user" into the username field
 * 2. Enter password "secret_sauce" into the password field
 * 3. Click the Login button
 * 4. Check: error banner is visible and contains "locked out"
 */
test.meta('tc', '33511')('locked out user sees error message', async t => {
  await t
    .typeText('#user-name', 'locked_out_user')
    .typeText('#password', 'secret_sauce')
    .click('#login-button')
    .expect(Selector('[data-test="error"]').innerText).contains('locked out');
});

/**
 * Empty username shows a validation error.
 * 1. Leave the username field empty
 * 2. Enter password "secret_sauce" into the password field
 * 3. Click the Login button
 * 4. Check: validation error "Epic sadface: Username is required" is visible
 */
test.meta('tc', '33512')('empty username shows validation error', async t => {
  await t
    .typeText('#password', 'secret_sauce')
    .click('#login-button')
    .expect(Selector('[data-test="error"]').innerText).eql('Epic sadface: Username is required');
});

/**
 * Logout returns the user to the login screen.
 * 1. Log in as standard_user
 * 2. Open the navigation menu
 * 3. Click Logout
 * 4. Check: login button is visible on the page
 */
test.meta({ tc: '33513', priority: 'high' })('logout returns to login screen', async t => {
  await t
    .typeText('#user-name', 'standard_user')
    .typeText('#password', 'secret_sauce')
    .click('#login-button')
    .click('#react-burger-menu-btn')
    .click('#logout_sidebar_link')
    .expect(Selector('#login-button').exists).ok();
});
