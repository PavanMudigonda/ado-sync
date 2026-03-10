describe('SauceDemo Inventory', () => {
  beforeEach(async () => {
    await browser.url('https://www.saucedemo.com');
    await $('#user-name').setValue('standard_user');
    await $('#password').setValue('secret_sauce');
    await $('#login-button').click();
    await browser.waitUntil(() => browser.getUrl().then(u => u.includes('inventory')), { timeout: 5000 });
  });

  /**
   * Inventory page displays six products.
   * 1. Log in as standard_user and navigate to the inventory page
   * 2. Check: page shows exactly 6 inventory items
   */
  // @tc:32999
  it('inventory page displays six products', async () => {
    const items = await $$('.inventory_item');
    expect(items.length).toBe(6);
  });

  /**
   * Sorting by price low to high puts the cheapest item first.
   * 1. Log in and navigate to the inventory page
   * 2. Select "Price (low to high)" from the sort dropdown
   * 3. Check: first product price equals "$9.99"
   */
  // @tc:33000
  it('sort by price low to high shows cheapest item first', async () => {
    await $('.product_sort_container').selectByAttribute('value', 'lohi');
    const prices = await $$('.inventory_item_price');
    const firstPrice = await prices[0].getText();
    expect(firstPrice).toBe('$9.99');
  });

  /**
   * Clicking a product name opens the product detail page.
   * 1. Log in and navigate to the inventory page
   * 2. Click on the first inventory item name
   * 3. Check: product detail page with name and description is displayed
   */
  // @tc:33001
  it('clicking product name opens detail page', async () => {
    await $('.inventory_item_name').click();
    const detail = await $('.inventory_details_name');
    expect(await detail.isDisplayed()).toBe(true);
  });
});
