package com.saucedemo.app;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.rule.ActivityTestRule;

import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;

import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.action.ViewActions.closeSoftKeyboard;
import static androidx.test.espresso.action.ViewActions.typeText;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.matcher.ViewMatchers.isDisplayed;
import static androidx.test.espresso.matcher.ViewMatchers.withId;
import static androidx.test.espresso.matcher.ViewMatchers.withText;

@RunWith(AndroidJUnit4.class)
public class LoginInstrumentedTest {

    @Rule
    public ActivityTestRule<MainActivity> activityRule =
            new ActivityTestRule<>(MainActivity.class);

    @Before
    public void setUp() {
        // Ensure app starts on the login screen
    }

    /**
     * Valid credentials navigate to the inventory screen.
     * 1. Enter username "standard_user" into the username field
     * 2. Enter password "secret_sauce" into the password field
     * 3. Click the login button
     * 4. Check: inventory screen is displayed
     */
    // @tc:33210
    @Test
    public void validCredentialsNavigateToInventoryScreen() {
        onView(withId(R.id.username)).perform(typeText("standard_user"), closeSoftKeyboard());
        onView(withId(R.id.password)).perform(typeText("secret_sauce"), closeSoftKeyboard());
        onView(withId(R.id.login_button)).perform(click());
        onView(withId(R.id.inventory_container)).check(matches(isDisplayed()));
    }

    /**
     * Locked-out user sees an error message.
     * 1. Enter username "locked_out_user" into the username field
     * 2. Enter password "secret_sauce" into the password field
     * 3. Click the login button
     * 4. Check: error message contains "locked out"
     */
    // @tc:33211
    @Test
    public void lockedOutUserSeesErrorMessage() {
        onView(withId(R.id.username)).perform(typeText("locked_out_user"), closeSoftKeyboard());
        onView(withId(R.id.password)).perform(typeText("secret_sauce"), closeSoftKeyboard());
        onView(withId(R.id.login_button)).perform(click());
        onView(withId(R.id.error_message)).check(matches(isDisplayed()));
        onView(withId(R.id.error_message)).check(
                matches(withText("Epic sadface: Sorry, this user has been locked out.")));
    }

    /**
     * Empty username shows a validation error.
     * 1. Leave the username field empty
     * 2. Enter password "secret_sauce" into the password field
     * 3. Click the login button
     * 4. Check: error message reads "Epic sadface: Username is required"
     */
    // @tc:33212
    @Test
    public void emptyUsernameShowsValidationError() {
        onView(withId(R.id.password)).perform(typeText("secret_sauce"), closeSoftKeyboard());
        onView(withId(R.id.login_button)).perform(click());
        onView(withId(R.id.error_message)).check(
                matches(withText("Epic sadface: Username is required")));
    }

    /**
     * Logout returns the user to the login screen.
     * 1. Log in as standard_user
     * 2. Open the navigation drawer
     * 3. Tap the Logout option
     * 4. Check: login screen is displayed
     */
    // @tc:33213
    @Test
    public void logoutReturnsToLoginScreen() {
        onView(withId(R.id.username)).perform(typeText("standard_user"), closeSoftKeyboard());
        onView(withId(R.id.password)).perform(typeText("secret_sauce"), closeSoftKeyboard());
        onView(withId(R.id.login_button)).perform(click());
        onView(withId(R.id.inventory_container)).check(matches(isDisplayed()));
        onView(withId(R.id.menu_button)).perform(click());
        onView(withId(R.id.logout_link)).perform(click());
        onView(withId(R.id.login_button)).check(matches(isDisplayed()));
    }
}
