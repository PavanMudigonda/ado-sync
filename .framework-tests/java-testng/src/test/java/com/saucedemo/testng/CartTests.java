package com.saucedemo.testng;

import org.openqa.selenium.By;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.chrome.ChromeDriver;
import org.testng.Assert;
import org.testng.annotations.*;

public class CartTests {

    private WebDriver driver;

    @BeforeMethod
    public void setUp() {
        driver = new ChromeDriver();
        driver.get("https://www.saucedemo.com");
        driver.findElement(By.id("user-name")).sendKeys("standard_user");
        driver.findElement(By.id("password")).sendKeys("secret_sauce");
        driver.findElement(By.id("login-button")).click();
    }

    @AfterMethod
    public void tearDown() {
        driver.quit();
    }

    /**
     * Adding a single item updates the cart badge to 1.
     * 1. Log in as standard_user and navigate to the inventory page
     * 2. Click add-to-cart for Sauce Labs Backpack
     * 3. Check: shopping cart badge text equals "1"
     */
    // @tc:32984
    @Test(groups = {"smoke"})
    public void addSingleItem_UpdatesBadgeToOne() {
        driver.findElement(By.cssSelector("[data-test='add-to-cart-sauce-labs-backpack']")).click();
        String badge = driver.findElement(By.className("shopping_cart_badge")).getText();
        Assert.assertEquals(badge, "1", "Cart badge should show 1 after adding one item");
    }

    /**
     * Adding three items shows count 3 on the cart badge.
     * 1. Log in and navigate to the inventory page
     * 2. Add Sauce Labs Backpack, Bike Light, and Bolt T-Shirt to cart
     * 3. Check: shopping cart badge text equals "3"
     */
    // @tc:32985
    @Test
    public void addThreeItems_BadgeShowsThree() {
        driver.findElement(By.cssSelector("[data-test='add-to-cart-sauce-labs-backpack']")).click();
        driver.findElement(By.cssSelector("[data-test='add-to-cart-sauce-labs-bike-light']")).click();
        driver.findElement(By.cssSelector("[data-test='add-to-cart-sauce-labs-bolt-t-shirt']")).click();
        String badge = driver.findElement(By.className("shopping_cart_badge")).getText();
        Assert.assertEquals(badge, "3");
    }

    /**
     * Cart page lists all added items.
     * 1. Log in and add Sauce Labs Backpack and Bike Light to cart
     * 2. Click the shopping cart icon
     * 3. Check: cart page shows exactly 2 cart items
     */
    // @tc:32986
    @Test
    public void cartPage_ListsAddedItems() {
        driver.findElement(By.cssSelector("[data-test='add-to-cart-sauce-labs-backpack']")).click();
        driver.findElement(By.cssSelector("[data-test='add-to-cart-sauce-labs-bike-light']")).click();
        driver.findElement(By.className("shopping_cart_link")).click();
        int cartItemCount = driver.findElements(By.className("cart_item")).size();
        Assert.assertEquals(cartItemCount, 2, "Cart should contain 2 items");
    }
}
