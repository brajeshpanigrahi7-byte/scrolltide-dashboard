# ParkSense live hardware and payments
- [ ] Add the specified live tables, admin-only reads, realtime, settings defaults, and atomic payment/exit routines.
- [ ] Match the four ESP32 endpoints and compact response contracts exactly; accept telemetry extras and maintain live slot/device state.
- [ ] Add server-priced Razorpay orders, signed browser verification, signed webhooks, idempotent capture, extensions, and refund flagging.
- [ ] Rebuild the public mobile pay page around session codes, Razorpay Checkout, countdowns, extensions, and early exit.
- [ ] Replace remaining demo/static dashboard values with live data and add admin exit commands, settings, analytics export, and copyable connection URLs.
- [ ] Make Workflow derive its current state and timestamps from real device, session, and activity data.
- [ ] Add concrete rule tests, run existing tests, fix preview errors, and verify the main flows in the browser.
- [ ] Verify a real Razorpay payment (requires a customer payment and device request).
- [ ] Verify physical ESP32 behaviour with the owner's hardware; firmware contract is now supplied, hardware access is not.
