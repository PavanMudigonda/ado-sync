using Microsoft.VisualStudio.TestTools.UnitTesting;
using OpenQA.Selenium;
using OpenQA.Selenium.Chrome;

namespace SauceDemo.MSTest.Tests
{
    [TestClass]
    public class CartTests
    {
        private IWebDriver _driver;

        [TestInitialize]
        public void Setup()
        {
            _driver = new ChromeDriver();
            _driver.Navigate().GoToUrl("https://www.saucedemo.com");
            _driver.FindElement(By.Id("user-name")).SendKeys("standard_user");
            _driver.FindElement(By.Id("password")).SendKeys("secret_sauce");
            _driver.FindElement(By.Id("login-button")).Click();
        }

        [TestCleanup]
        public void Teardown() => _driver.Quit();

        /// <summary>
        /// Adding an item updates the cart badge to 1.
        /// 1. Log in as standard_user and navigate to the inventory page
        /// 2. Click add-to-cart for Sauce Labs Backpack
        /// 3. Check: shopping cart badge text equals "1"
        /// </summary>
        [TestMethod]
        [TestProperty("tc", "32963")]
        [TestCategory("smoke")]
        public void AddItem_UpdatesCartBadge()
        {
            _driver.FindElement(By.CssSelector("[data-test='add-to-cart-sauce-labs-backpack']")).Click();
            var badge = _driver.FindElement(By.ClassName("shopping_cart_badge")).Text;
            Assert.AreEqual("1", badge);
        }

        /// <summary>
        /// Removing one item from two decrements the cart badge to 1.
        /// 1. Add Sauce Labs Backpack and Bike Light to cart
        /// 2. Click Remove for Sauce Labs Bike Light
        /// 3. Check: shopping cart badge text equals "1"
        /// </summary>
        [TestMethod]
        [TestProperty("tc", "32964")]
        public void RemoveItem_DecrementsCartBadge()
        {
            _driver.FindElement(By.CssSelector("[data-test='add-to-cart-sauce-labs-backpack']")).Click();
            _driver.FindElement(By.CssSelector("[data-test='add-to-cart-sauce-labs-bike-light']")).Click();
            _driver.FindElement(By.CssSelector("[data-test='remove-sauce-labs-bike-light']")).Click();
            var badge = _driver.FindElement(By.ClassName("shopping_cart_badge")).Text;
            Assert.AreEqual("1", badge);
        }

        /// <summary>
        /// Cart page shows the correct price for the added item.
        /// 1. Add Sauce Labs Backpack to cart
        /// 2. Click the shopping cart icon to open the cart page
        /// 3. Check: item price displayed equals "$29.99"
        /// </summary>
        [TestMethod]
        [TestProperty("tc", "32965")]
        public void CartPage_ShowsCorrectItemPrice()
        {
            _driver.FindElement(By.CssSelector("[data-test='add-to-cart-sauce-labs-backpack']")).Click();
            _driver.FindElement(By.ClassName("shopping_cart_link")).Click();
            var price = _driver.FindElement(By.ClassName("inventory_item_price")).Text;
            Assert.AreEqual("$29.99", price);
        }
    }
}
