import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:saucedemo_app/main.dart';

void main() {
  group('SauceDemo Login', () {
    // @tc:33410
    // @smoke
    /// Valid credentials navigate to the inventory screen.
    ///
    /// 1. Launch the app on the login screen
    /// 2. Enter "standard_user" into the username field
    /// 3. Enter "secret_sauce" into the password field
    /// 4. Tap the Login button
    /// 5. Check: inventory screen is visible
    testWidgets('valid credentials navigate to inventory screen',
        (WidgetTester tester) async {
      await tester.pumpWidget(const SauceDemoApp());

      await tester.enterText(find.byKey(const Key('username')), 'standard_user');
      await tester.enterText(find.byKey(const Key('password')), 'secret_sauce');
      await tester.tap(find.byKey(const Key('login-button')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('inventory-screen')), findsOneWidget);
    });

    // @tc:33411
    /// Locked-out user sees an error message.
    ///
    /// 1. Launch the app on the login screen
    /// 2. Enter "locked_out_user" into the username field
    /// 3. Enter "secret_sauce" into the password field
    /// 4. Tap the Login button
    /// 5. Check: error message "Sorry, this user has been locked out." is visible
    testWidgets('locked out user sees error message',
        (WidgetTester tester) async {
      await tester.pumpWidget(const SauceDemoApp());

      await tester.enterText(find.byKey(const Key('username')), 'locked_out_user');
      await tester.enterText(find.byKey(const Key('password')), 'secret_sauce');
      await tester.tap(find.byKey(const Key('login-button')));
      await tester.pumpAndSettle();

      expect(
        find.text('Epic sadface: Sorry, this user has been locked out.'),
        findsOneWidget,
      );
    });

    // @tc:33412
    /// Empty username shows a validation error.
    ///
    /// 1. Launch the app on the login screen
    /// 2. Leave the username field empty
    /// 3. Enter "secret_sauce" into the password field
    /// 4. Tap the Login button
    /// 5. Check: error message "Username is required" is visible
    testWidgets('empty username shows validation error',
        (WidgetTester tester) async {
      await tester.pumpWidget(const SauceDemoApp());

      await tester.enterText(find.byKey(const Key('password')), 'secret_sauce');
      await tester.tap(find.byKey(const Key('login-button')));
      await tester.pumpAndSettle();

      expect(find.text('Epic sadface: Username is required'), findsOneWidget);
    });

    // @tc:33413
    /// Logout returns the user to the login screen.
    ///
    /// 1. Log in as standard_user
    /// 2. Tap the navigation menu icon
    /// 3. Tap "Logout"
    /// 4. Check: login screen is visible
    testWidgets('logout returns to login screen', (WidgetTester tester) async {
      await tester.pumpWidget(const SauceDemoApp());

      await tester.enterText(find.byKey(const Key('username')), 'standard_user');
      await tester.enterText(find.byKey(const Key('password')), 'secret_sauce');
      await tester.tap(find.byKey(const Key('login-button')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('inventory-screen')), findsOneWidget);
      await tester.tap(find.byKey(const Key('menu-button')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('logout-link')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('login-button')), findsOneWidget);
    });
  });
}
