import XCTest

class LoginUITests: XCTestCase {

    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    override func tearDownWithError() throws {
        app.terminate()
    }

    /// Valid credentials navigate to the inventory screen.
    ///
    /// 1. Launch the app and land on the login screen
    /// 2. Enter "standard_user" into the username field
    /// 3. Enter "secret_sauce" into the password field
    /// 4. Tap the Login button
    /// 5. Check: inventory screen is visible
    // @tc:33310
    func testValidCredentialsNavigateToInventoryScreen() {
        app.textFields["Username"].typeText("standard_user")
        app.secureTextFields["Password"].typeText("secret_sauce")
        app.buttons["Login"].tap()
        XCTAssertTrue(app.otherElements["inventoryScreen"].waitForExistence(timeout: 5))
    }

    /// Locked-out user sees an error message.
    ///
    /// 1. Launch the app and land on the login screen
    /// 2. Enter "locked_out_user" into the username field
    /// 3. Enter "secret_sauce" into the password field
    /// 4. Tap the Login button
    /// 5. Check: error message is displayed
    // @tc:33311
    func testLockedOutUserSeesErrorMessage() {
        app.textFields["Username"].typeText("locked_out_user")
        app.secureTextFields["Password"].typeText("secret_sauce")
        app.buttons["Login"].tap()
        XCTAssertTrue(app.staticTexts["Epic sadface: Sorry, this user has been locked out."].exists)
    }

    /// Empty username shows a validation error.
    ///
    /// 1. Launch the app and land on the login screen
    /// 2. Leave the username field empty
    /// 3. Enter "secret_sauce" into the password field
    /// 4. Tap the Login button
    /// 5. Check: error message "Epic sadface: Username is required" is visible
    // @tc:33312
    func testEmptyUsernameShowsValidationError() {
        app.secureTextFields["Password"].typeText("secret_sauce")
        app.buttons["Login"].tap()
        XCTAssertTrue(app.staticTexts["Epic sadface: Username is required"].exists)
    }

    /// Logout returns the user to the login screen.
    ///
    /// 1. Log in as standard_user
    /// 2. Tap the navigation menu button
    /// 3. Tap "Logout"
    /// 4. Check: login screen is visible
    // @tc:33313
    func testLogoutReturnsToLoginScreen() {
        app.textFields["Username"].typeText("standard_user")
        app.secureTextFields["Password"].typeText("secret_sauce")
        app.buttons["Login"].tap()
        XCTAssertTrue(app.otherElements["inventoryScreen"].waitForExistence(timeout: 5))
        app.buttons["Open Menu"].tap()
        app.buttons["Logout"].tap()
        XCTAssertTrue(app.buttons["Login"].waitForExistence(timeout: 3))
    }
}
