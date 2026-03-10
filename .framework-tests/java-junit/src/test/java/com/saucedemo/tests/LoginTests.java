package com.saucedemo.tests;

import org.junit.jupiter.api.*;
import org.junit.jupiter.api.Tag;
import org.openqa.selenium.By;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.chrome.ChromeDriver;

import static org.junit.jupiter.api.Assertions.*;

@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
public class LoginTests {

    private WebDriver driver;

    @BeforeEach
    void setUp() {
        driver = new ChromeDriver();
        driver.get("https://www.saucedemo.com");
    }

    @AfterEach
    void tearDown() {
        driver.quit();
    }

    /**
     * Valid credentials redirect to the inventory page.
     * 1. Navigate to https://www.saucedemo.com
     * 2. Enter username "standard_user" and password "secret_sauce"
     * 3. Click the login button
     * 4. Check: current URL contains "inventory.html"
     */
    @Tag("tc:32981")
    @Test
    @Tag("smoke")
    void validCredentials_redirectsToInventory() {
        driver.findElement(By.id("user-name")).sendKeys("standard_user");
        driver.findElement(By.id("password")).sendKeys("secret_sauce");
        driver.findElement(By.id("login-button")).click();
        assertTrue(driver.getCurrentUrl().contains("inventory.html"),
            "Expected URL to contain inventory.html");
    }

    /**
     * Locked-out user sees an error banner.
     * 1. Navigate to https://www.saucedemo.com
     * 2. Enter username "locked_out_user" and password "secret_sauce"
     * 3. Click the login button
     * 4. Check: error banner text contains "locked out"
     */
    @Tag("tc:32982")
    @Test
    void lockedOutUser_showsErrorBanner() {
        driver.findElement(By.id("user-name")).sendKeys("locked_out_user");
        driver.findElement(By.id("password")).sendKeys("secret_sauce");
        driver.findElement(By.id("login-button")).click();
        String error = driver.findElement(By.cssSelector("[data-test='error']")).getText();
        assertTrue(error.contains("locked out"), "Expected locked out message");
    }

    /**
     * Empty username field shows a validation error.
     * 1. Navigate to https://www.saucedemo.com
     * 2. Enter password "secret_sauce" without filling in the username
     * 3. Click the login button
     * 4. Check: error message equals "Epic sadface: Username is required"
     */
    @Tag("tc:32983")
    @Test
    void emptyUsername_showsValidationError() {
        driver.findElement(By.id("password")).sendKeys("secret_sauce");
        driver.findElement(By.id("login-button")).click();
        String error = driver.findElement(By.cssSelector("[data-test='error']")).getText();
        assertEquals("Epic sadface: Username is required", error);
    }
}
