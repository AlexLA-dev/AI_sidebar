# App Store Review Checklist — ContextFlow

Use this checklist before each App Store submission to avoid common rejection reasons.

---

## Guideline 3.1.1 — In-App Purchase

- [x] Safari (App Store) build uses StoreKit 2 for subscriptions (not Stripe)
- [x] Chrome build uses Stripe (allowed, not distributed via App Store)
- [x] "Restore Purchases" button present on paywall (required)
- [x] Localized pricing from StoreKit shown (not hardcoded USD)
- [x] Payment footer says "Payment charged to your Apple ID" (not Stripe)
- [ ] **ACTION**: Create subscription products in App Store Connect:
  - `com.contextflow.byok.monthly` — BYOK License ($1.99/mo)
  - `com.contextflow.pro.monthly` — Pro Subscription ($6.99/mo)
- [ ] **ACTION**: Create a Subscription Group in App Store Connect
- [ ] **ACTION**: Configure App Store Server Notifications v2 URL:
  `https://aisidebar.netlify.app/.netlify/functions/appstore-verify`

## Guideline 2.1 — App Completeness

- [ ] Test full purchase flow in Sandbox environment
- [ ] Verify subscription status syncs correctly after purchase
- [ ] Verify subscription status syncs correctly after restore
- [ ] Test cancellation flow (Settings > Subscriptions)
- [ ] Test expiration / grace period handling

## Guideline 5.1.1 — Data Collection and Storage

- [x] Privacy manifest (`PrivacyInfo.xcprivacy`) included
- [x] Only email collected (for account auth) — linked, not tracked
- [x] Usage data collected (rate limiting) — linked, not tracked
- [x] `NSPrivacyTracking = false` (no cross-app tracking)
- [ ] **ACTION**: Fill in App Privacy section in App Store Connect matching the privacy manifest

## Guideline 5.1.2 — Data Use and Sharing

- [x] API key stored locally only, never sent to ContextFlow servers
- [x] User data processed on Supabase (disclosed in privacy policy)
- [x] Chat content sent to OpenAI API (disclosed in privacy policy)
- [ ] **ACTION**: Add privacy policy URL in App Store Connect
- [ ] **ACTION**: Add terms of service URL

## Guideline 2.3 — Accurate Metadata

- [ ] App description mentions it's a Safari extension
- [ ] Screenshots show the sidebar in Safari
- [ ] Category: Productivity
- [ ] Age rating: 4+ (no objectionable content)

## Guideline 4.0 — Design

- [x] Extension UI uses native-feeling design (Tailwind, no jarring web UI)
- [x] Dark mode supported
- [x] Accessible: sr-only labels, proper contrast ratios
- [ ] **ACTION**: Test on both macOS and iOS Safari (if supporting iOS)

## Guideline 2.5.1 — Software Requirements (Safari Extension)

- [ ] **ACTION**: Create Xcode project wrapping the Plasmo extension
  - Main app target (container) with StoreKit 2
  - Safari Web Extension target
  - App Group shared container (if needed for offline status)
- [ ] **ACTION**: Sign with appropriate provisioning profiles
- [ ] **ACTION**: Set minimum deployment target (macOS 13+ / iOS 16+ for StoreKit 2)

## Guideline 3.1.2 — Subscriptions

- [x] Auto-renewable subscriptions (monthly)
- [ ] **ACTION**: Include required subscription metadata in App Store Connect:
  - Subscription purpose description
  - Subscription terms (billing, renewal, cancellation)
- [ ] **ACTION**: Link to subscription management in Settings panel (done in code)

## Environment Variables for Production

Set these in Netlify Dashboard before going live:

```
APPSTORE_BUNDLE_ID=com.contextflow.app
APPSTORE_KEY_ID=<from App Store Connect>
APPSTORE_ISSUER_ID=<from App Store Connect>
APPSTORE_ENVIRONMENT=production
```

## Pre-Submission Smoke Test

1. Build Safari extension via Plasmo: `pnpm build --target=safari-mv3`
2. Archive in Xcode with Release configuration
3. Test in-app purchase with Sandbox Apple ID
4. Verify subscription activates in ContextFlow sidebar
5. Verify "Restore Purchases" works on clean install
6. Verify subscription management link opens correctly
7. Run Xcode Analyze — fix all warnings
8. Validate archive before uploading to App Store Connect
