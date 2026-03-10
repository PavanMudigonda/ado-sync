Feature: SauceDemo Cart — SpecFlow

  Background:
    Given I am logged in as "standard_user"

  @smoke
  @tc:32972
  Scenario: Adding an item increments the cart badge
    When I add "Sauce Labs Backpack" to the cart
    Then the cart badge shows "1"

  @tc:32973
  Scenario: Removing an item decrements the cart badge
    Given I have "Sauce Labs Backpack" and "Sauce Labs Bike Light" in the cart
    When I remove "Sauce Labs Bike Light" from the cart
    Then the cart badge shows "1"

  @tc:32974
  Scenario: Cart page shows correct item price
    When I add "Sauce Labs Backpack" to the cart
    And I open the cart
    Then the price of "Sauce Labs Backpack" is "$29.99"
