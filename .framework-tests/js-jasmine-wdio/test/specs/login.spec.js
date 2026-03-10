describe('SauceDemo Login', () => {
  const BASE_URL = 'https://www.saucedemo.com';

  beforeEach(async () => {
    await browser.url(BASE_URL);
  });

  /**
   * Valid credentials navigate to the inventory page.
   * 1. Navigate to https://www.saucedemo.com
   * 2. Enter username "standard_user" and password "secret_sauce"
   * 3. Click the login button
   * 4. Check: URL contains "inventory.html"
   */
  // @tc:33002
  it('valid credentials navigate to inventory page', async () => {
    await $('#user-name').setValue('standard_user');
    await $('#password').setValue('secret_sauce');
    await $('#login-button').click();
    await expect(browser).toHaveUrlContaining('inventory.html');
  });

  /**
   * Locked-out user sees an error message.
   * 1. Navigate to https://www.saucedemo.com
   * 2. Enter username "locked_out_user" and password "secret_sauce"
   * 3. Click the login button
   * 4. Check: error banner text contains "locked out"
   */
  // @tc:33003
  it('locked out user sees error message', async () => {
    await $('#user-name').setValue('locked_out_user');
    await $('#password').setValue('secret_sauce');
    await $('#login-button').click();
    const error = await $("[data-test='error']").getText();
    await expect(error).toContain('locked out');
  });

  /**
   * Empty username field shows a validation error.
   * 1. Navigate to https://www.saucedemo.com
   * 2. Enter password "secret_sauce" without filling in the username
   * 3. Click the login button
   * 4. Check: error message equals "Epic sadface: Username is required"
   */
  // @tc:33004
  it('empty username field shows validation error', async () => {
    await $('#password').setValue('secret_sauce');
    await $('#login-button').click();
    const error = await $("[data-test='error']").getText();
    await expect(error).toEqual('Epic sadface: Username is required');
  });
});
