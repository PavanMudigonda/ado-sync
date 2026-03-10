Feature: SauceDemo Login — SpecFlow

  Background:
    Given I open the SauceDemo login page

  @smoke
  @tc:32975
  Scenario: Valid credentials navigate to inventory
    When I log in as "standard_user" with password "secret_sauce"
    Then I am on the inventory page

  @tc:32976
  Scenario: Locked out user sees error message
    When I log in as "locked_out_user" with password "secret_sauce"
    Then I see the error "Epic sadface: Sorry, this user has been locked out."

  @tc:32977
  Scenario: Empty credentials show username required error
    When I submit the login form without credentials
    Then I see the error "Epic sadface: Username is required"
