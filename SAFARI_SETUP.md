# Safari Extension Setup Guide

This guide explains how to build and publish ContextFlow for Safari on the Mac App Store.

## Prerequisites

- macOS 12.0 or later
- Xcode 14.0 or later
- Apple Developer Account ($99/year)
- Node.js 18+

## Step 1: Build the Safari Extension

```bash
cd AI_sidebar
npm install
npm run build:safari
```

This creates the Safari extension in `build/safari-mv3-prod/`.

## Step 2: Convert to Xcode Project

Safari extensions require a native macOS app wrapper. Use Apple's converter:

```bash
xcrun safari-web-extension-converter build/safari-mv3-prod \
  --project-location ./safari-xcode \
  --app-name "ContextFlow" \
  --bundle-identifier com.alexla.contextflow \
  --swift
```

This creates an Xcode project in `safari-xcode/`.

## Step 3: Configure Xcode Project

1. Open `safari-xcode/ContextFlow.xcodeproj` in Xcode

2. **Signing & Capabilities:**
   - Select "ContextFlow" target
   - Go to "Signing & Capabilities" tab
   - Select your Team (Apple Developer account)
   - Set Bundle Identifier: `com.alexla.contextflow`

3. **Extension Target:**
   - Select "ContextFlow Extension" target
   - Set Bundle Identifier: `com.alexla.contextflow.extension`
   - Same Team as main app

4. **App Category:**
   - Select main target → General → App Category: "Productivity"

## Step 4: Test Locally

1. In Xcode, select Product → Run (⌘R)
2. The app will launch and prompt to enable the extension
3. Go to Safari → Settings → Extensions → Enable "ContextFlow"

## Step 5: Archive & Submit

1. **Archive:**
   - Product → Archive
   - Wait for build to complete

2. **Distribute:**
   - In Organizer, select the archive
   - Click "Distribute App"
   - Choose "App Store Connect"
   - Upload

3. **App Store Connect:**
   - Go to https://appstoreconnect.apple.com
   - Create new app "ContextFlow"
   - Fill in metadata:
     - Name: ContextFlow - AI Sidebar
     - Subtitle: Smart AI for any webpage
     - Description: (same as Chrome Web Store)
     - Keywords: AI, assistant, browser, productivity
     - Privacy Policy URL: https://aisidebar.netlify.app/privacy-policy.html
   - Add screenshots (1280x800 for Mac)
   - Submit for review

## Important Notes

### Safari Differences from Chrome

| Feature | Chrome | Safari |
|---------|--------|--------|
| Side Panel | ✅ Native | ❌ Opens in new tab |
| windows API | ✅ Full | ⚠️ Limited |
| Permissions | sidePanel | (ignored) |

### File Structure After Conversion

```
safari-xcode/
├── ContextFlow/           # macOS app
│   ├── AppDelegate.swift
│   ├── ViewController.swift
│   └── Assets.xcassets/   # Add app icons here
├── ContextFlow Extension/ # Safari extension
│   └── Resources/         # Your extension files
└── ContextFlow.xcodeproj
```

### App Icons Required

For Mac App Store, you need icons in these sizes:
- 16x16, 32x32, 64x64, 128x128, 256x256, 512x512, 1024x1024

Use Xcode's Asset Catalog to add them.

## Troubleshooting

### "Extension not showing in Safari"
1. Safari → Settings → Extensions → Enable ContextFlow
2. If not listed, check Xcode console for errors

### "Build failed: signing issues"
1. Ensure both targets use the same Team
2. Check bundle identifiers are unique

### "Network requests blocked"
Safari has stricter CORS. Ensure your Netlify functions have proper headers:
```
Access-Control-Allow-Origin: *
```

## Resources

- [Safari Web Extensions](https://developer.apple.com/documentation/safariservices/safari_web_extensions)
- [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Plasmo Safari Target](https://docs.plasmo.com/framework/workflows/build#safari)
