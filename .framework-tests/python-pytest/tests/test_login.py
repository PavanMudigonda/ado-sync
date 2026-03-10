import pytest
from selenium import webdriver
from selenium.webdriver.common.by import By

BASE_URL = "https://www.saucedemo.com"


@pytest.fixture
def driver():
    d = webdriver.Chrome()
    d.get(BASE_URL)
    yield d
    d.quit()


@pytest.mark.tc(33045)
def test_valid_credentials_redirect_to_inventory(driver):
    """
    Valid credentials redirect to the inventory page.
    1. Navigate to https://www.saucedemo.com
    2. Enter username "standard_user" and password "secret_sauce"
    3. Click the login button
    4. Check: current URL contains "inventory.html"
    """
    driver.find_element(By.ID, "user-name").send_keys("standard_user")
    driver.find_element(By.ID, "password").send_keys("secret_sauce")
    driver.find_element(By.ID, "login-button").click()
    assert "inventory.html" in driver.current_url


@pytest.mark.tc(33046)
def test_locked_out_user_sees_error(driver):
    """
    Locked-out user sees an error banner.
    1. Navigate to https://www.saucedemo.com
    2. Enter username "locked_out_user" and password "secret_sauce"
    3. Click the login button
    4. Check: error banner text contains "locked out"
    """
    driver.find_element(By.ID, "user-name").send_keys("locked_out_user")
    driver.find_element(By.ID, "password").send_keys("secret_sauce")
    driver.find_element(By.ID, "login-button").click()
    error = driver.find_element(By.CSS_SELECTOR, "[data-test='error']").text
    assert "locked out" in error


@pytest.mark.tc(33047)
def test_empty_username_shows_validation_error(driver):
    """
    Empty username field shows a validation error.
    1. Navigate to https://www.saucedemo.com
    2. Enter password "secret_sauce" without filling in the username
    3. Click the login button
    4. Check: error message equals "Epic sadface: Username is required"
    """
    driver.find_element(By.ID, "password").send_keys("secret_sauce")
    driver.find_element(By.ID, "login-button").click()
    error = driver.find_element(By.CSS_SELECTOR, "[data-test='error']").text
    assert error == "Epic sadface: Username is required"
