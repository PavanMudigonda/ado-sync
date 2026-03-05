Feature: SauceDemo Checkout Flow

  Background:
    Given I am logged in as "standard_user"

  @smoke
  @tc:32879
  Scenario: Complete checkout with a single item (happy path)
    Given I have "Sauce Labs Backpack" in my cart
    When I open the cart
    And I click "Checkout"
    And I fill in First Name "Test" Last Name "User" Postal Code "12345"
    And I click "Continue"
    Then I am on the checkout overview page
    And I see "Sauce Labs Backpack" in the order summary
    When I click "Finish"
    Then I see the order confirmation message "Thank you for your order!"

  @tc:32880
  Scenario: Checkout with multiple items verifies totals
    Given I have the following items in my cart:
      | item                       | price |
      | Sauce Labs Backpack        | 29.99 |
      | Sauce Labs Bike Light      | 9.99  |
      | Sauce Labs Bolt T-Shirt    | 15.99 |
    When I proceed to the checkout overview
    Then the item total displayed equals the sum of item prices
    And tax is displayed and greater than zero
    And the order total equals item total plus tax

  @tc:32881
  Scenario: Checkout is blocked when First Name is missing
    Given I have "Sauce Labs Backpack" in my cart
    When I open the cart and click "Checkout"
    And I fill in Last Name "User" Postal Code "12345" but leave First Name empty
    And I click "Continue"
    Then I see an error message "Error: First Name is required"

  @tc:32882
  Scenario: Checkout is blocked when Last Name is missing
    Given I have "Sauce Labs Backpack" in my cart
    When I open the cart and click "Checkout"
    And I fill in First Name "Test" Postal Code "12345" but leave Last Name empty
    And I click "Continue"
    Then I see an error message "Error: Last Name is required"

  @tc:32883
  Scenario: Checkout is blocked when Postal Code is missing
    Given I have "Sauce Labs Backpack" in my cart
    When I open the cart and click "Checkout"
    And I fill in First Name "Test" Last Name "User" but leave Postal Code empty
    And I click "Continue"
    Then I see an error message "Error: Postal Code is required"

  @tc:32884
  Scenario: Cancelling checkout returns to cart
    Given I have "Sauce Labs Backpack" in my cart
    When I open the cart and click "Checkout"
    And I click "Cancel" on the checkout information page
    Then I am on the cart page
    And my cart still contains "Sauce Labs Backpack"

  @tc:32885
  Scenario: Cancelling overview returns to inventory
    Given I have "Sauce Labs Backpack" in my cart
    When I proceed to the checkout overview
    And I click "Cancel" on the overview page
    Then I am on the inventory page

  @tc:32886
  Scenario: Direct navigation to checkout step without items
    When I navigate directly to "/checkout-step-one.html"
    Then the app does not allow completing an order with an empty cart

  @tc:32887
  Scenario: Cart is cleared after a successful order
    Given I have "Sauce Labs Backpack" in my cart
    When I complete checkout with name "Test User" and postal code "12345"
    And I click "Back Home"
    Then I am on the inventory page
    And the cart badge is not visible

  @tc:32888
  Scenario: Checkout summary shows correct tax calculation
    Given I have "Sauce Labs Fleece Jacket" in my cart
    When I proceed to the checkout overview
    Then the tax shown equals 8% of the item total
    And the total equals item total plus tax

  @tc:32889
  Scenario Outline: Checkout with different valid user accounts
    Given I am logged in as "<username>"
    And I have "Sauce Labs Backpack" in my cart
    When I complete checkout with name "Test User" and postal code "12345"
    Then I see the order confirmation message "Thank you for your order!"

    Examples:
      | username                |
      | standard_user           |
      | performance_glitch_user |
