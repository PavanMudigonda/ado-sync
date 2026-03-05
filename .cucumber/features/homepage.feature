Feature: Playwright Home Page

  @tc:32870
  Scenario: Check title
    Given I am on Playwright home page
    When I click link "Get started"
    Then I see in title "Installation"
