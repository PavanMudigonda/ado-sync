# SauceDemo Login Functionality - Comprehensive Test Plan

## Application Overview

The SauceDemo application (https://www.saucedemo.com) is a demonstration e-commerce testing platform featuring a login-protected inventory system. The application provides:

- **Login Authentication**: Username and password-based authentication system
- **Multiple User Types**: Six different user profiles simulating various testing scenarios
- **Error Handling**: Comprehensive error messaging for different failure cases
- **User Interface**: Clean, simple login form with helpful credential information display
- **Post-Login Functionality**: Access to inventory/product catalog after successful authentication

The application provides six predefined user accounts (all with password `secret_sauce`):
- `standard_user`: Standard functionality user
- `locked_out_user`: Simulates account lockout scenario
- `problem_user`: User with application problems/bugs
- `performance_glitch_user`: User experiencing performance delays
- `error_user`: User that triggers error scenarios
- `visual_user`: User for visual/UI testing

## 1. Account Restriction Tests

### 1.1 Standard User Login

**Steps:**
1. Navigate to https://www.saucedemo.com
2. Click in the "Username" input field
3. Type "standard_user"
4. Click in the "Password" input field
5. Type "secret_sauce"
6. Click the "Login" button

**Expected Results:**
- User is redirected to inventory page (/inventory.html)
- Page displays "Products" heading
- Product grid is visible with items and "Add to cart" buttons
- Navigation menu (hamburger menu) is visible in top-left
- URL changes to https://www.saucedemo.com/inventory.html

---

### 1.2 Performance Glitch User Login

**Steps:**
1. Navigate to https://www.saucedemo.com
2. Enter "performance_glitch_user" in Username field
3. Enter "secret_sauce" in Password field
4. Click Login button
5. Wait up to 10 seconds for page to load

**Expected Results:**
- Login process takes significantly longer than normal (>5 seconds)
- Eventually redirects to inventory page
- All functionality works normally after the delay
- Useful for testing timeout handling and performance scenarios

---

## 2. Invalid Credentials Tests

### 2.1 Locked Out User Login Attempt

**Steps:**
1. Navigate to https://www.saucedemo.com
2. Enter "locked_out_user" in Username field
3. Enter "secret_sauce" in Password field
4. Click Login button

**Expected Results:**
- User remains on login page
- Error message appears: "Epic sadface: Sorry, this user has been locked out."
- Error message is displayed in red styling above the login form
- Username and Password fields remain populated
- Red error icons appear next to both input fields
- X button appears in error message for dismissal

---

### 2.2 Clear Locked Out Error Message

**Steps:**
1. Complete steps from 2.1 (locked out user login)
2. Click the X button in the error message

**Expected Results:**
- Error message disappears
- Red error icons next to input fields disappear
- Input fields remain populated with previous values
- User can attempt login again

---

## 3. Field Validation Tests

### 3.1 Invalid Username Test

**Steps:**
1. Navigate to https://www.saucedemo.com
2. Enter "invalid_user" in Username field
3. Enter "secret_sauce" in Password field
4. Click Login button

**Expected Results:**
- User remains on login page
- Error message appears: "Epic sadface: Username and password do not match any user in this service"
- Username and Password fields remain populated
- Red error icons appear next to both input fields

---

### 3.2 Invalid Password Test

**Steps:**
1. Navigate to https://www.saucedemo.com
2. Enter "standard_user" in Username field
3. Enter "wrong_password" in Password field
4. Click Login button

**Expected Results:**
- User remains on login page
- Error message appears: "Epic sadface: Username and password do not match any user in this service"
- Same error message as invalid username (security best practice)
- Input fields remain populated

---

### 3.3 Both Invalid Credentials Test

**Steps:**
1. Navigate to https://www.saucedemo.com
2. Enter "invalid_user" in Username field
3. Enter "wrong_password" in Password field
4. Click Login button

**Expected Results:**
- User remains on login page
- Error message appears: "Epic sadface: Username and password do not match any user in this service"
- Consistent error messaging regardless of which field is invalid

---

## 4. User Interface and Usability Tests

### 4.1 Empty Username Test

**Steps:**
1. Navigate to https://www.saucedemo.com
2. Leave Username field empty
3. Enter "secret_sauce" in Password field
4. Click Login button

**Expected Results:**
- User remains on login page
- Error message appears: "Epic sadface: Username is required"
- Red error icons appear next to both input fields
- Password field value remains populated

---

### 4.2 Empty Password Test

**Steps:**
1. Navigate to https://www.saucedemo.com
2. Enter "standard_user" in Username field
3. Leave Password field empty
4. Click Login button

**Expected Results:**
- **CRITICAL SECURITY FLAW**: Login succeeds with empty password
- User is redirected to inventory page
- **This represents a significant security vulnerability that should be flagged**

---

### 4.3 Both Fields Empty Test

**Steps:**
1. Navigate to https://www.saucedemo.com
2. Leave both Username and Password fields empty
3. Click Login button

**Expected Results:**
- User remains on login page
- Error message appears: "Epic sadface: Username is required"
- Red error icons appear next to both input fields
- Username validation takes precedence over password validation

---

## 5. Edge Cases and Special Scenarios

### 5.1 Login Page Elements Verification

**Steps:**
1. Navigate to https://www.saucedemo.com

**Expected Results:**
- Page title displays "Swag Labs"
- "Swag Labs" heading is prominently displayed
- Username input field with "Username" placeholder/label
- Password input field with "Password" placeholder/label
- Green "Login" button is visible and enabled
- Information panel shows "Accepted usernames are:" with list of valid usernames
- Information panel shows "Password for all users: secret_sauce"
- Page has clean, professional styling

---

### 5.2 Input Field Interaction

**Steps:**
1. Navigate to https://www.saucedemo.com
2. Click in Username field
3. Verify field receives focus
4. Type some text
5. Click in Password field
6. Verify field receives focus and text is masked
7. Type some text

**Expected Results:**
- Username field accepts text input normally
- Password field masks input with bullets/asterisks
- Fields have proper focus states (visual indication)
- Tab navigation works between fields

---

### 5.3 Error State Styling

**Steps:**
1. Navigate to https://www.saucedemo.com
2. Trigger any error (e.g., empty username)
3. Observe visual styling

**Expected Results:**
- Error message appears in red text
- Error message includes "Epic sadface:" prefix for consistent branding
- Red error icons appear next to input fields
- Error message includes X button for dismissal
- Error styling is visually prominent but not overwhelming

---

## 6. Accessibility and Cross-Browser Tests

### 6.1 Login Button Double-Click

**Steps:**
1. Navigate to https://www.saucedemo.com
2. Enter valid credentials (standard_user / secret_sauce)
3. Double-click the Login button rapidly

**Expected Results:**
- Login processes normally
- No duplicate requests or errors
- Single redirect to inventory page
- No unexpected behavior

---

### 6.2 Browser Refresh During Login

**Steps:**
1. Navigate to https://www.saucedemo.com
2. Enter credentials
3. Click Login
4. Immediately refresh the page during login process

**Expected Results:**
- Page returns to login form
- No partial login state
- User must re-authenticate

---

## 7. Accessibility Tests

### 7.1 Keyboard Navigation

**Steps:**
1. Navigate to https://www.saucedemo.com
2. Use Tab key to navigate through form elements
3. Use Enter key to submit form

**Expected Results:**
- Tab order is logical: Username → Password → Login button
- Enter key submits form from any field
- Focus indicators are visible
- All interactive elements are keyboard accessible

---

### 7.2 Mobile Responsiveness

**Steps:**
1. Navigate to https://www.saucedemo.com
2. Resize browser window to mobile dimensions (320px width)
3. Verify layout and functionality

**Expected Results:**
- Login form remains usable on mobile
- Text is readable without horizontal scrolling
- Touch targets are appropriately sized
- Information panel content is accessible

---

*Test Plan Version: 1.0*
*Last Updated: December 6, 2025*
*Total Test Cases: 15 scenarios across 7 categories*
