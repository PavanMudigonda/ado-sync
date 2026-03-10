import pytest
from selenium import webdriver
from selenium.webdriver.common.by import By

BASE_URL = "https://www.saucedemo.com"


@pytest.fixture
def logged_in_driver():
    d = webdriver.Chrome()
    d.get(BASE_URL)
    d.find_element(By.ID, "user-name").send_keys("standard_user")
    d.find_element(By.ID, "password").send_keys("secret_sauce")
    d.find_element(By.ID, "login-button").click()
    yield d
    d.quit()


@pytest.mark.tc(33042)
def test_add_item_updates_cart_badge(logged_in_driver):
    """
    Adding an item updates the cart badge to 1.
    1. Log in as standard_user and navigate to the inventory page
    2. Click add-to-cart for Sauce Labs Backpack
    3. Check: shopping cart badge text equals "1"
    """
    logged_in_driver.find_element(
        By.CSS_SELECTOR, "[data-test='add-to-cart-sauce-labs-backpack']"
    ).click()
    badge = logged_in_driver.find_element(By.CLASS_NAME, "shopping_cart_badge").text
    assert badge == "1"


@pytest.mark.tc(33043)
def test_remove_item_decrements_cart_badge(logged_in_driver):
    """
    Removing one item from two decrements the cart badge to 1.
    1. Add Sauce Labs Backpack and Bike Light to cart
    2. Click Remove for Sauce Labs Bike Light
    3. Check: shopping cart badge text equals "1"
    """
    logged_in_driver.find_element(
        By.CSS_SELECTOR, "[data-test='add-to-cart-sauce-labs-backpack']"
    ).click()
    logged_in_driver.find_element(
        By.CSS_SELECTOR, "[data-test='add-to-cart-sauce-labs-bike-light']"
    ).click()
    logged_in_driver.find_element(
        By.CSS_SELECTOR, "[data-test='remove-sauce-labs-bike-light']"
    ).click()
    badge = logged_in_driver.find_element(By.CLASS_NAME, "shopping_cart_badge").text
    assert badge == "1"


@pytest.mark.tc(33044)
def test_cart_page_shows_correct_price(logged_in_driver):
    """
    Cart page shows the correct price for the added item.
    1. Add Sauce Labs Backpack to cart
    2. Click the shopping cart icon to open the cart page
    3. Check: item price displayed equals "$29.99"
    """
    logged_in_driver.find_element(
        By.CSS_SELECTOR, "[data-test='add-to-cart-sauce-labs-backpack']"
    ).click()
    logged_in_driver.find_element(By.CLASS_NAME, "shopping_cart_link").click()
    price = logged_in_driver.find_element(By.CLASS_NAME, "inventory_item_price").text
    assert price == "$29.99"
