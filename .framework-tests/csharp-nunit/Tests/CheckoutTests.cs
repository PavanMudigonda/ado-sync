using NUnit.Framework;
using OpenQA.Selenium;
using OpenQA.Selenium.Chrome;

namespace SauceDemo.NUnit.Tests
{
    [TestFixture]
    public class CheckoutTests
    {
        private IWebDriver _driver;

        [SetUp]
        public void Setup()
        {
            _driver = new ChromeDriver();
            _driver.Navigate().GoToUrl("https://www.saucedemo.com");
            _driver.FindElement(By.Id("user-name")).SendKeys("standard_user");
            _driver.FindElement(By.Id("password")).SendKeys("secret_sauce");
            _driver.FindElement(By.Id("login-button")).Click();
            _driver.FindElement(By.CssSelector("[data-test='add-to-cart-sauce-labs-backpack']")).Click();
        }

        [TearDown]
        public void Teardown() => _driver.Quit();

        /// <summary>
        /// Happy path completes the checkout and shows order confirmation.
        /// 1. Navigate to cart page and click Checkout
        /// 2. Enter first name "Test", last name "User", postal code "12345"
        /// 3. Click Continue then click Finish
        /// 4. Check: confirmation message equals "Thank you for your order!"
        /// </summary>
        [Test]
        [Property("tc", "32969")]
        [Category("smoke")]
        public void HappyPath_CompletesOrderSuccessfully()
        {
            _driver.FindElement(By.ClassName("shopping_cart_link")).Click();
            _driver.FindElement(By.CssSelector("[data-test='checkout']")).Click();
            _driver.FindElement(By.Id("first-name")).SendKeys("Test");
            _driver.FindElement(By.Id("last-name")).SendKeys("User");
            _driver.FindElement(By.Id("postal-code")).SendKeys("12345");
            _driver.FindElement(By.CssSelector("[data-test='continue']")).Click();
            _driver.FindElement(By.CssSelector("[data-test='finish']")).Click();
            var confirmation = _driver.FindElement(By.ClassName("complete-header")).Text;
            Assert.That(confirmation, Is.EqualTo("Thank you for your order!"));
        }

        /// <summary>
        /// Missing first name on checkout form shows a validation error.
        /// 1. Navigate to cart page and click Checkout
        /// 2. Enter last name "User" and postal code "12345" without a first name
        /// 3. Click Continue
        /// 4. Check: error message contains "First Name is required"
        /// </summary>
        [Test]
        [Property("tc", "32970")]
        public void MissingFirstName_ShowsValidationError()
        {
            _driver.FindElement(By.ClassName("shopping_cart_link")).Click();
            _driver.FindElement(By.CssSelector("[data-test='checkout']")).Click();
            _driver.FindElement(By.Id("last-name")).SendKeys("User");
            _driver.FindElement(By.Id("postal-code")).SendKeys("12345");
            _driver.FindElement(By.CssSelector("[data-test='continue']")).Click();
            var error = _driver.FindElement(By.CssSelector("[data-test='error']")).Text;
            Assert.That(error, Does.Contain("First Name is required"));
        }

        /// <summary>
        /// Order summary page displays the correct item total.
        /// 1. Complete checkout step 1 with valid buyer information
        /// 2. Navigate to the order summary page
        /// 3. Check: item subtotal label contains "$29.99"
        /// </summary>
        [Test]
        [Property("tc", "32971")]
        public void TotalsPage_DisplaysCorrectItemTotal()
        {
            _driver.FindElement(By.ClassName("shopping_cart_link")).Click();
            _driver.FindElement(By.CssSelector("[data-test='checkout']")).Click();
            _driver.FindElement(By.Id("first-name")).SendKeys("Test");
            _driver.FindElement(By.Id("last-name")).SendKeys("User");
            _driver.FindElement(By.Id("postal-code")).SendKeys("12345");
            _driver.FindElement(By.CssSelector("[data-test='continue']")).Click();
            var subtotal = _driver.FindElement(By.ClassName("summary_subtotal_label")).Text;
            StringAssert.Contains("29.99", subtotal);
        }
    }
}
