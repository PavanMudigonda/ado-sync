import XCTest

class CartUITests: XCTestCase {

    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        // Sign in before each test
        app.textFields["Username"].typeText("standard_user")
        app.secureTextFields["Password"].typeText("secret_sauce")
        app.buttons["Login"].tap()
        XCTAssertTrue(app.otherElements["inventoryScreen"].waitForExistence(timeout: 5))
    }

    override func tearDownWithError() throws {
        app.terminate()
    }

    /// Adding an item updates the cart badge to 1.
    ///
    /// 1. Log in and navigate to the inventory screen
    /// 2. Tap "Add to Cart" for Sauce Labs Backpack
    /// 3. Check: cart badge shows "1"
    // @tc:33314
    func testAddingItemUpdatesCartBadgeToOne() {
        app.buttons["Add to Cart, Sauce Labs Backpack"].tap()
        XCTAssertEqual(app.staticTexts["cartBadge"].label, "1")
    }

    /// Removing an item decrements the cart badge.
    ///
    /// 1. Add Sauce Labs Backpack to the cart
    /// 2. Add Sauce Labs Bike Light to the cart
    /// 3. Tap "Remove" for Sauce Labs Bike Light
    /// 4. Check: cart badge shows "1"
    // @tc:33315
    func testRemovingItemDecrementsCartBadge() {
        app.buttons["Add to Cart, Sauce Labs Backpack"].tap()
        app.buttons["Add to Cart, Sauce Labs Bike Light"].tap()
        app.buttons["Remove, Sauce Labs Bike Light"].tap()
        XCTAssertEqual(app.staticTexts["cartBadge"].label, "1")
    }

    /// Cart screen shows correct item name and price.
    ///
    /// 1. Add Sauce Labs Backpack to the cart
    /// 2. Tap the cart icon to open the cart screen
    /// 3. Check: item name "Sauce Labs Backpack" is visible
    /// 4. Check: item price "$29.99" is visible
    // @tc:33316
    func testCartScreenShowsCorrectItemNameAndPrice() {
        app.buttons["Add to Cart, Sauce Labs Backpack"].tap()
        app.buttons["Cart"].tap()
        XCTAssertTrue(app.staticTexts["Sauce Labs Backpack"].exists)
        XCTAssertTrue(app.staticTexts["$29.99"].exists)
    }

    /// Checkout flow completes successfully.
    ///
    /// 1. Add Sauce Labs Backpack to the cart
    /// 2. Open the cart and tap Checkout
    /// 3. Enter first name, last name, and zip code
    /// 4. Tap Continue, then Finish
    /// 5. Check: order confirmation message is visible
    // @tc:33317
    func testCheckoutFlowCompletesSuccessfully() {
        app.buttons["Add to Cart, Sauce Labs Backpack"].tap()
        app.buttons["Cart"].tap()
        app.buttons["Checkout"].tap()
        app.textFields["First Name"].typeText("Test")
        app.textFields["Last Name"].typeText("User")
        app.textFields["Zip/Postal Code"].typeText("12345")
        app.buttons["Continue"].tap()
        app.buttons["Finish"].tap()
        XCTAssertTrue(app.staticTexts["Thank you for your order!"].exists)
    }
}
