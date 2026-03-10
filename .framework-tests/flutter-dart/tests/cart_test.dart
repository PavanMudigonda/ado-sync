import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:saucedemo_app/main.dart';

/// Sign in as standard_user before running cart tests.
Future<void> signIn(WidgetTester tester) async {
  await tester.pumpWidget(const SauceDemoApp());
  await tester.enterText(find.byKey(const Key('username')), 'standard_user');
  await tester.enterText(find.byKey(const Key('password')), 'secret_sauce');
  await tester.tap(find.byKey(const Key('login-button')));
  await tester.pumpAndSettle();
}

void main() {
  group('SauceDemo Cart', () {
    // @tc:33414
    // @smoke
    /// Adding an item updates the cart badge to 1.
    ///
    /// 1. Log in as standard_user
    /// 2. Tap "Add to Cart" for Sauce Labs Backpack
    /// 3. Check: cart badge shows "1"
    testWidgets('adding an item updates the cart badge to 1',
        (WidgetTester tester) async {
      await signIn(tester);

      await tester.tap(find.byKey(const Key('add-to-cart-sauce-labs-backpack')));
      await tester.pumpAndSettle();

      expect(find.text('1'), findsOneWidget);
    });

    // @tc:33415
    /// Removing an item decrements the cart badge.
    ///
    /// 1. Log in and add Sauce Labs Backpack to the cart
    /// 2. Add Sauce Labs Bike Light to the cart
    /// 3. Tap "Remove" for Sauce Labs Bike Light
    /// 4. Check: cart badge shows "1"
    testWidgets('removing an item decrements the cart badge',
        (WidgetTester tester) async {
      await signIn(tester);

      await tester.tap(find.byKey(const Key('add-to-cart-sauce-labs-backpack')));
      await tester.tap(find.byKey(const Key('add-to-cart-sauce-labs-bike-light')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('remove-sauce-labs-bike-light')));
      await tester.pumpAndSettle();

      expect(find.text('1'), findsOneWidget);
    });

    // @tc:33416
    /// Cart screen shows correct item name and price.
    ///
    /// 1. Log in and add Sauce Labs Backpack to the cart
    /// 2. Tap the cart icon to open the cart screen
    /// 3. Check: item name "Sauce Labs Backpack" is visible
    /// 4. Check: item price "$29.99" is visible
    testWidgets('cart screen shows correct item name and price',
        (WidgetTester tester) async {
      await signIn(tester);

      await tester.tap(find.byKey(const Key('add-to-cart-sauce-labs-backpack')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('shopping-cart-link')));
      await tester.pumpAndSettle();

      expect(find.text('Sauce Labs Backpack'), findsOneWidget);
      expect(find.text('\$29.99'), findsOneWidget);
    });

    // @tc:33417
    /// Checkout flow completes successfully.
    ///
    /// 1. Log in and add Sauce Labs Backpack to the cart
    /// 2. Open the cart and tap Checkout
    /// 3. Enter first name "Test", last name "User", and zip "12345"
    /// 4. Tap Continue, then Finish
    /// 5. Check: confirmation message "Thank you for your order!" is visible
    testWidgets('checkout flow completes successfully',
        (WidgetTester tester) async {
      await signIn(tester);

      await tester.tap(find.byKey(const Key('add-to-cart-sauce-labs-backpack')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('shopping-cart-link')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('checkout')));
      await tester.pumpAndSettle();

      await tester.enterText(find.byKey(const Key('first-name')), 'Test');
      await tester.enterText(find.byKey(const Key('last-name')), 'User');
      await tester.enterText(find.byKey(const Key('postal-code')), '12345');
      await tester.tap(find.byKey(const Key('continue')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('finish')));
      await tester.pumpAndSettle();

      expect(find.text('Thank you for your order!'), findsOneWidget);
    });
  });
}
