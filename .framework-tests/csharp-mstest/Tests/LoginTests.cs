using Microsoft.VisualStudio.TestTools.UnitTesting;
using OpenQA.Selenium;
using OpenQA.Selenium.Chrome;

namespace SauceDemo.MSTest.Tests
{
    [TestClass]
    public class LoginTests
    {
        private IWebDriver _driver;
        private const string BaseUrl = "https://www.saucedemo.com";

        [TestInitialize]
        public void Setup() => _driver = new ChromeDriver();

        [TestCleanup]
        public void Teardown() => _driver.Quit();

        /// <summary>
        /// Valid credentials redirect to the inventory page.
        /// 1. Navigate to https://www.saucedemo.com
        /// 2. Enter username "standard_user" and password "secret_sauce"
        /// 3. Click the login button
        /// 4. Check: URL contains "inventory.html"
        /// </summary>
        [TestMethod]
        [TestProperty("tc", "32966")]
        [TestCategory("smoke")]
        public void ValidCredentials_RedirectsToInventory()
        {
            _driver.Navigate().GoToUrl(BaseUrl);
            _driver.FindElement(By.Id("user-name")).SendKeys("standard_user");
            _driver.FindElement(By.Id("password")).SendKeys("secret_sauce");
            _driver.FindElement(By.Id("login-button")).Click();
            StringAssert.Contains(_driver.Url, "inventory.html");
        }

        /// <summary>
        /// Locked-out user sees an error banner.
        /// 1. Navigate to https://www.saucedemo.com
        /// 2. Enter username "locked_out_user" and password "secret_sauce"
        /// 3. Click the login button
        /// 4. Check: error banner text contains "locked out"
        /// </summary>
        [TestMethod]
        [TestProperty("tc", "32967")]
        public void LockedOutUser_ShowsErrorBanner()
        {
            _driver.Navigate().GoToUrl(BaseUrl);
            _driver.FindElement(By.Id("user-name")).SendKeys("locked_out_user");
            _driver.FindElement(By.Id("password")).SendKeys("secret_sauce");
            _driver.FindElement(By.Id("login-button")).Click();
            var error = _driver.FindElement(By.CssSelector("[data-test='error']")).Text;
            StringAssert.Contains(error, "locked out");
        }

        /// <summary>
        /// Empty username field shows a validation error.
        /// 1. Navigate to https://www.saucedemo.com
        /// 2. Enter password "secret_sauce" without filling in the username
        /// 3. Click the login button
        /// 4. Check: error message equals "Epic sadface: Username is required"
        /// </summary>
        [TestMethod]
        [TestProperty("tc", "32968")]
        public void EmptyUsername_ShowsValidationError()
        {
            _driver.Navigate().GoToUrl(BaseUrl);
            _driver.FindElement(By.Id("password")).SendKeys("secret_sauce");
            _driver.FindElement(By.Id("login-button")).Click();
            var error = _driver.FindElement(By.CssSelector("[data-test='error']")).Text;
            Assert.AreEqual("Epic sadface: Username is required", error);
        }
    }
}
