Feature: SauceDemo Inventory Page

  Background:
    Given I am logged in as "standard_user"

  @smoke
  @tc:32890
  Scenario: Inventory page displays products
    Then I see at least one product on the inventory page
    And each product has a name, description, price, and "Add to cart" button

  @tc:32891
  Scenario: Sort products by name A to Z
    When I select sort option "Name (A to Z)"
    Then the products are sorted alphabetically ascending by name

  @tc:32892
  Scenario: Sort products by name Z to A
    When I select sort option "Name (Z to A)"
    Then the products are sorted alphabetically descending by name

  @tc:32893
  Scenario: Sort products by price low to high
    When I select sort option "Price (low to high)"
    Then the products are sorted by price ascending

  @tc:32894
  Scenario: Sort products by price high to low
    When I select sort option "Price (high to low)"
    Then the products are sorted by price descending

  @tc:32895
  Scenario: Navigate to product detail page
    When I click on the product name "Sauce Labs Backpack"
    Then I am on the product detail page for "Sauce Labs Backpack"
    And I see the product description, price, and "Add to cart" button

  @tc:32896
  Scenario: Add to cart from product detail page
    Given I am on the product detail page for "Sauce Labs Backpack"
    When I click "Add to cart"
    Then the cart badge shows "1"
    And the button changes to "Remove"

  @tc:32897
  Scenario: Navigate back to inventory from product detail
    Given I am on the product detail page for "Sauce Labs Backpack"
    When I click "Back to products"
    Then I am on the inventory page

  @tc:32898
  Scenario: All six products are displayed
    Then I see exactly 6 products on the inventory page

  @tc:32899
  Scenario: Logout from inventory page
    When I open the burger menu
    And I click "Logout"
    Then I am on the login page
