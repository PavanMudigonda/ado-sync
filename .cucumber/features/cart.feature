Feature: SauceDemo Shopping Cart

  Background:
    Given I am logged in as "standard_user"

  @smoke
  @tc:32871
  Scenario: Add a single item to the cart
    When I click "Add to cart" for "Sauce Labs Backpack"
    Then the cart badge shows "1"
    And the cart contains "Sauce Labs Backpack"

  @tc:32872
  Scenario: Add multiple items to the cart
    When I click "Add to cart" for "Sauce Labs Backpack"
    And I click "Add to cart" for "Sauce Labs Bike Light"
    And I click "Add to cart" for "Sauce Labs Bolt T-Shirt"
    Then the cart badge shows "3"
    And the cart contains "Sauce Labs Backpack"
    And the cart contains "Sauce Labs Bike Light"
    And the cart contains "Sauce Labs Bolt T-Shirt"

  @tc:32873
  Scenario: Remove an item from the cart
    Given I have "Sauce Labs Backpack" and "Sauce Labs Bike Light" in my cart
    When I open the cart
    And I click "Remove" for "Sauce Labs Bike Light"
    Then the cart badge shows "1"
    And the cart does not contain "Sauce Labs Bike Light"
    And the cart contains "Sauce Labs Backpack"

  @tc:32874
  Scenario: Remove all items from the cart
    Given I have "Sauce Labs Backpack" in my cart
    When I open the cart
    And I click "Remove" for "Sauce Labs Backpack"
    Then the cart badge is not visible

  @tc:32875
  Scenario: Cart persists after navigating back to inventory
    Given I have "Sauce Labs Backpack" in my cart
    When I click "Continue Shopping" from the cart
    Then I am on the inventory page
    And the cart badge shows "1"

  @tc:32876
  Scenario: Add to cart button changes to Remove after adding
    When I click "Add to cart" for "Sauce Labs Backpack"
    Then the button for "Sauce Labs Backpack" shows "Remove"

  @tc:32877
  Scenario: Cart badge increments correctly for each added item
    When I click "Add to cart" for "Sauce Labs Backpack"
    Then the cart badge shows "1"
    When I click "Add to cart" for "Sauce Labs Bike Light"
    Then the cart badge shows "2"

  @tc:32878
  Scenario: Correct item price is shown in the cart
    When I click "Add to cart" for "Sauce Labs Backpack"
    And I open the cart
    Then the price of "Sauce Labs Backpack" in the cart is "$29.99"
