import { device, element, by, expect as detoxExpect } from 'detox';

const credentials = {
  validUser: 'standard_user',
  lockedUser: 'locked_out_user',
  password: 'secret_sauce',
};

describe('SauceDemo Login', () => {
  beforeAll(async () => {
    await device.launchApp();
  });

  beforeEach(async () => {
    await device.reloadReactNative();
  });

  /**
   * Valid credentials navigate to the inventory screen.
   * 1. Launch the app and land on the login screen
   * 2. Enter username "standard_user" into the username field
   * 3. Enter password "secret_sauce" into the password field
   * 4. Tap the Login button
   * 5. Check: inventory screen is visible
   */
  // @tc:33110
  it('valid credentials navigate to inventory screen', async () => {
    await element(by.id('username')).typeText(credentials.validUser);
    await element(by.id('password')).typeText(credentials.password);
    await element(by.id('login-button')).tap();
    await detoxExpect(element(by.id('inventory-screen'))).toBeVisible();
  });

  /**
   * Locked-out user sees an error message.
   * 1. Launch the app and land on the login screen
   * 2. Enter username "locked_out_user" into the username field
   * 3. Enter password "secret_sauce" into the password field
   * 4. Tap the Login button
   * 5. Check: error message contains "locked out"
   */
  // @tc:33111
  it('locked out user sees error message', async () => {
    await element(by.id('username')).typeText(credentials.lockedUser);
    await element(by.id('password')).typeText(credentials.password);
    await element(by.id('login-button')).tap();
    await detoxExpect(element(by.id('error-message'))).toBeVisible();
    await detoxExpect(element(by.id('error-message'))).toHaveText(
      'Epic sadface: Sorry, this user has been locked out.'
    );
  });

  /**
   * Empty username shows a validation error.
   * 1. Launch the app and land on the login screen
   * 2. Leave the username field empty
   * 3. Enter password "secret_sauce" into the password field
   * 4. Tap the Login button
   * 5. Check: validation error "Username is required" is visible
   */
  // @tc:33112
  it('empty username shows validation error', async () => {
    await element(by.id('password')).typeText(credentials.password);
    await element(by.id('login-button')).tap();
    await detoxExpect(element(by.id('error-message'))).toHaveText(
      'Epic sadface: Username is required'
    );
  });

  /**
   * Logout returns the user to the login screen.
   * 1. Log in as standard_user
   * 2. Open the navigation menu
   * 3. Tap "Logout"
   * 4. Check: login screen is visible
   */
  // @tc:33113
  it('logout returns to login screen', async () => {
    await element(by.id('username')).typeText(credentials.validUser);
    await element(by.id('password')).typeText(credentials.password);
    await element(by.id('login-button')).tap();
    await detoxExpect(element(by.id('inventory-screen'))).toBeVisible();
    await element(by.id('react-burger-menu-btn')).tap();
    await element(by.id('logout_sidebar_link')).tap();
    await detoxExpect(element(by.id('login-button'))).toBeVisible();
  });
});
