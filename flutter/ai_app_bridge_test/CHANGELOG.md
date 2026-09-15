## 0.3.8

- Add CLI-managed executor preparation for existing application projects, with generated test entrypoints and dependency compatibility checks.

## 0.3.7

- Align with the 0.3.7 unified release. The Android Host now skips null foreground records and resolves multiple windows using the system focused display; unresolved focus is reported as ambiguous. App runtime behavior is unchanged.

## 0.3.6

- Initial optional Android integration_test session, serial WidgetTester operations, observed element identity, cancellation, durable original receipts and exact process lifecycle.
- Uses the consumer's Flutter SDK test dependencies; no additional native Gradle plugin.
