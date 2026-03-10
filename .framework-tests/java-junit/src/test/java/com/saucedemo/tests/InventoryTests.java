package com.saucedemo.tests;

import org.junit.jupiter.api.*;
import org.junit.jupiter.api.Tag;
import org.openqa.selenium.By;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.chrome.ChromeDriver;

import static org.junit.jupiter.api.Assertions.*;

public class InventoryTests {

    private WebDriver driver;

    @BeforeEach
    void setUp() {
        driver = new ChromeDriver();
        driver.get("https://www.saucedemo.com");
        driver.findElement(By.id("user-name")).sendKeys("standard_user");
        driver.findElement(By.id("password")).sendKeys("secret_sauce");
        driver.findElement(By.id("login-button")).click();
    }

    @AfterEach
    void tearDown() {
        driver.quit();
    }

    /**
     * Inventory page shows six products.
     * 1. Log in as standard_user and navigate to the inventory page
     * 2. Check: page contains exactly 6 inventory items
     */
    @Tag("tc:32978")
    @Test
    @Tag("smoke")
    void inventoryPage_ShowsSixProducts() {
        int count = driver.findElements(By.className("inventory_item")).size();
        assertEquals(6, count, "Expected 6 products on inventory page");
    }

    /**
     * Sorting by price low to high puts the cheapest item first.
     * 1. Log in and navigate to the inventory page
     * 2. Select "Price (low to high)" from the sort dropdown
     * 3. Check: first item price equals "$9.99"
     */
    @Tag("tc:32979")
    @Test
    void sortByPriceLowToHigh_FirstItemIsCheapest() {
        driver.findElement(By.className("product_sort_container"))
              .findElement(By.xpath("//option[@value='lohi']")).click();
        String firstPrice = driver.findElements(By.className("inventory_item_price"))
                                  .get(0).getText();
        assertEquals("$9.99", firstPrice);
    }

    /**
     * Product detail page shows item name and price.
     * 1. Log in and navigate to the inventory page
     * 2. Click on the first inventory item name
     * 3. Check: product name and price are visible on the detail page
     */
    @Tag("tc:32980")
    @Test
    void productDetailPage_ShowsCorrectInfo() {
        driver.findElement(By.className("inventory_item_name")).click();
        assertTrue(driver.findElement(By.className("inventory_details_name")).isDisplayed());
        assertTrue(driver.findElement(By.className("inventory_details_price")).isDisplayed());
    }
}
