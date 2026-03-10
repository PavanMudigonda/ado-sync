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
public class CartInstrumentedTest {

    @Rule
    public ActivityTestRule<MainActivity> activityRule =
            new ActivityTestRule<>(MainActivity.class);

    @Before
    public void signIn() {
        onView(withId(R.id.username)).perform(typeText("standard_user"), closeSoftKeyboard());
        onView(withId(R.id.password)).perform(typeText("secret_sauce"), closeSoftKeyboard());
        onView(withId(R.id.login_button)).perform(click());
        onView(withId(R.id.inventory_container)).check(matches(isDisplayed()));
    }

    /**
     * Adding an item updates the cart badge to 1.
     * 1. Log in and navigate to the inventory screen
     * 2. Tap "Add to Cart" for Sauce Labs Backpack
     * 3. Check: cart badge displays "1"
     */
    // @tc:33214
    @Test
    public void addingItemUpdatesCartBadgeToOne() {
        onView(withId(R.id.add_to_cart_sauce_labs_backpack)).perform(click());
        onView(withId(R.id.shopping_cart_badge)).check(matches(withText("1")));
    }

    /**
     * Removing an item decrements the cart badge.
     * 1. Add Sauce Labs Backpack to cart
     * 2. Add Sauce Labs Bike Light to cart
     * 3. Tap "Remove" for Sauce Labs Bike Light
     * 4. Check: cart badge displays "1"
     */
    // @tc:33215
    @Test
    public void removingItemDecrementsCartBadge() {
        onView(withId(R.id.add_to_cart_sauce_labs_backpack)).perform(click());
        onView(withId(R.id.add_to_cart_sauce_labs_bike_light)).perform(click());
        onView(withId(R.id.remove_sauce_labs_bike_light)).perform(click());
        onView(withId(R.id.shopping_cart_badge)).check(matches(withText("1")));
    }

    /**
     * Cart screen shows correct item name and price.
     * 1. Add Sauce Labs Backpack to the cart
     * 2. Navigate to the cart screen
     * 3. Check: item name "Sauce Labs Backpack" is displayed
     * 4. Check: item price "$29.99" is displayed
     */
    // @tc:33216
    @Test
    public void cartScreenShowsCorrectItemNameAndPrice() {
        onView(withId(R.id.add_to_cart_sauce_labs_backpack)).perform(click());
        onView(withId(R.id.shopping_cart_link)).perform(click());
        onView(withText("Sauce Labs Backpack")).check(matches(isDisplayed()));
        onView(withText("$29.99")).check(matches(isDisplayed()));
    }
}
