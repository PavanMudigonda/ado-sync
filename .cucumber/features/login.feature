Feature: SauceDemo Login

  Background:
    Given I am on the SauceDemo login page

  @smoke
  @tc:32900
  Scenario: Successful login with valid credentials
    When I enter username "standard_user" and password "secret_sauce"
    And I click the Login button
    Then I am redirected to the inventory page
    And the product list is visible

  @tc:32901
  Scenario: Login fails with locked out user
    When I enter username "locked_out_user" and password "secret_sauce"
    And I click the Login button
    Then I see an error message "Epic sadface: Sorry, this user has been locked out."
    And I remain on the login page

  @tc:32902
  Scenario: Login fails with invalid username
    When I enter username "invalid_user" and password "secret_sauce"
    And I click the Login button
    Then I see an error message "Epic sadface: Username and password do not match any user in this service."

  @tc:32903
  Scenario: Login fails with invalid password
    When I enter username "standard_user" and password "wrong_password"
    And I click the Login button
    Then I see an error message "Epic sadface: Username and password do not match any user in this service."

  @tc:32904
  Scenario: Login fails with empty username
    When I leave username empty and enter password "secret_sauce"
    And I click the Login button
    Then I see an error message "Epic sadface: Username is required"

  @tc:32905
  Scenario: Login fails with empty password
    When I enter username "standard_user" and leave password empty
    And I click the Login button
    Then I see an error message "Epic sadface: Password is required"

  @tc:32906
  Scenario: Login fails with both fields empty
    When I leave username empty and leave password empty
    And I click the Login button
    Then I see an error message "Epic sadface: Username is required"

  @tc:32907
  Scenario Outline: Login with all valid test user accounts
    When I enter username "<username>" and password "secret_sauce"
    And I click the Login button
    Then I am redirected to the inventory page

    Examples:
      | username                |
      | standard_user           |
      | performance_glitch_user |
      | problem_user            |
      | error_user              |

  @tc:32908
  Scenario: Problem user can log in but may have UI anomalies
    When I enter username "problem_user" and password "secret_sauce"
    And I click the Login button
    Then I am redirected to the inventory page

  @tc:32909
  Scenario: Performance glitch user experiences slow login
    When I enter username "performance_glitch_user" and password "secret_sauce"
    And I click the Login button
    Then I am eventually redirected to the inventory page within 10 seconds
