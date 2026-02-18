#!/bin/bash
#
# setup-xcode.sh — Integrates native Swift files AND extension web resources
# into the generated Xcode project.
#
# Run this AFTER `safari-web-extension-converter` generates the ContextFlow project.
# Copies files to three locations:
#   - "Shared (App)/"              → ContentView, StoreKitManager, SharedDefaults, ViewController, PrivacyInfo
#   - "Shared (Extension)/"        → SafariWebExtensionHandler, SharedDefaults
#   - "Shared (Extension)/Resources/" → JS/HTML/CSS from build/safari-mv3-prod/
#
# Usage:
#   cd AI_sidebar
#   bash scripts/setup-xcode.sh [path-to-xcode-project]
#
# If no path is given, defaults to ./ContextFlow (relative to repo root).
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# The generated Xcode project folder (contains ContextFlow.xcodeproj)
XCODE_PROJECT="${1:-$REPO_ROOT/ContextFlow}"

# Source files from the repo
NATIVE_DIR="$REPO_ROOT/native/ContextFlow"
SOURCES_DIR="$NATIVE_DIR/Sources"

# Plasmo build output (JS/HTML/CSS for the Safari extension)
BUILD_DIR="$REPO_ROOT/build/safari-mv3-prod"

echo "=== ContextFlow Xcode Setup ==="
echo ""

# 1. Check that the Xcode project exists
if [ ! -d "$XCODE_PROJECT/ContextFlow.xcodeproj" ]; then
    echo "ERROR: Xcode project not found at $XCODE_PROJECT"
    echo ""
    echo "Have you run the converter yet? Run this first:"
    echo ""
    echo "  xcrun safari-web-extension-converter ./build/safari-mv3-prod \\"
    echo "    --app-name \"ContextFlow\" \\"
    echo "    --bundle-identifier \"com.contextflow.app\" \\"
    echo "    --swift \\"
    echo "    --copy-resources \\"
    echo "    --force"
    echo ""
    exit 1
fi

# 2. Check that native source files exist
if [ ! -d "$SOURCES_DIR" ]; then
    echo "ERROR: Native source files not found at $SOURCES_DIR"
    exit 1
fi

# 3. Detect the App target folder
if [ -d "$XCODE_PROJECT/Shared (App)" ]; then
    APP_DIR="$XCODE_PROJECT/Shared (App)"
elif [ -d "$XCODE_PROJECT/ContextFlow" ] && [ ! -f "$XCODE_PROJECT/ContextFlow/project.pbxproj" ]; then
    APP_DIR="$XCODE_PROJECT/ContextFlow"
else
    echo "ERROR: Could not detect app target folder inside $XCODE_PROJECT"
    echo ""
    echo "Contents of $XCODE_PROJECT:"
    ls -la "$XCODE_PROJECT"
    exit 1
fi

# 4. Detect the Extension target folder
if [ -d "$XCODE_PROJECT/Shared (Extension)" ]; then
    EXT_DIR="$XCODE_PROJECT/Shared (Extension)"
elif [ -d "$XCODE_PROJECT/ContextFlow Extension" ]; then
    EXT_DIR="$XCODE_PROJECT/ContextFlow Extension"
else
    echo "ERROR: Could not detect extension target folder inside $XCODE_PROJECT"
    echo ""
    echo "Contents of $XCODE_PROJECT:"
    ls -la "$XCODE_PROJECT"
    exit 1
fi

echo "Xcode project:  $XCODE_PROJECT"
echo "Native sources: $SOURCES_DIR"
echo "App target:     $APP_DIR"
echo "Extension dir:  $EXT_DIR"
echo ""

# ── 5. Copy files to App target (Shared (App)) ──

echo "--- App target: $(basename "$APP_DIR") ---"

# App target gets: ViewController, ContentView, StoreKitManager, SharedDefaults
for fname in ViewController.swift ContentView.swift StoreKitManager.swift SharedDefaults.swift; do
    src="$SOURCES_DIR/$fname"
    if [ -f "$src" ]; then
        if [ -f "$APP_DIR/$fname" ]; then echo "  [update] $fname"
        else echo "  [new]    $fname"; fi
        cp "$src" "$APP_DIR/$fname"
    fi
done

if [ -f "$NATIVE_DIR/PrivacyInfo.xcprivacy" ]; then
    cp "$NATIVE_DIR/PrivacyInfo.xcprivacy" "$APP_DIR/PrivacyInfo.xcprivacy"
    echo "  [ok]     PrivacyInfo.xcprivacy"
fi

# Copy StoreKit Configuration file to project root (for Xcode scheme setup)
if [ -f "$NATIVE_DIR/ContextFlow.storekit" ]; then
    cp "$NATIVE_DIR/ContextFlow.storekit" "$XCODE_PROJECT/ContextFlow.storekit"
    echo "  [ok]     ContextFlow.storekit → project root"
fi

# Copy Assets.xcassets (AppIcon) — replaces the converter-generated empty one
if [ -d "$NATIVE_DIR/Assets.xcassets" ]; then
    # Find the existing Assets.xcassets in the App target
    if [ -d "$APP_DIR/Assets.xcassets" ]; then
        # Merge: copy our AppIcon into existing catalog
        cp -R "$NATIVE_DIR/Assets.xcassets/AppIcon.appiconset" "$APP_DIR/Assets.xcassets/AppIcon.appiconset"
        echo "  [ok]     AppIcon.appiconset → Assets.xcassets"
    else
        # No existing catalog — copy the whole thing
        cp -R "$NATIVE_DIR/Assets.xcassets" "$APP_DIR/Assets.xcassets"
        echo "  [ok]     Assets.xcassets (new)"
    fi
fi

echo ""

# ── 6. Copy files to Extension target (Shared (Extension)) ──

echo "--- Extension target: $(basename "$EXT_DIR") ---"

# Extension target gets: SafariWebExtensionHandler, SharedDefaults
# NOTE: StoreKit is no longer needed in the extension — purchases happen in the app.
# The extension only reads subscription status from SharedDefaults (App Group).
for fname in SafariWebExtensionHandler.swift SharedDefaults.swift; do
    src="$SOURCES_DIR/$fname"
    if [ -f "$src" ]; then
        if [ -f "$EXT_DIR/$fname" ]; then echo "  [update] $fname"
        else echo "  [new]    $fname"; fi
        cp "$src" "$EXT_DIR/$fname"
    fi
done

# ── 6b. Copy extension web resources (JS/HTML/CSS) ──

echo "--- Extension web resources ---"

if [ -d "$BUILD_DIR" ]; then
    # Detect the Resources folder inside the Extension target
    if [ -d "$EXT_DIR/Resources" ]; then
        RES_DIR="$EXT_DIR/Resources"
    else
        # Fallback: create Resources if it doesn't exist
        RES_DIR="$EXT_DIR/Resources"
        mkdir -p "$RES_DIR"
    fi

    # Count files before copy
    BEFORE_COUNT=$(find "$RES_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')

    # Copy all built extension files (JS, HTML, CSS, manifest, icons, etc.)
    cp -R "$BUILD_DIR"/* "$RES_DIR"/

    AFTER_COUNT=$(find "$RES_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
    echo "  [ok]     Copied build/safari-mv3-prod/* → $(basename "$EXT_DIR")/Resources/"
    echo "           ($AFTER_COUNT files in Resources)"
else
    echo "  [SKIP]   build/safari-mv3-prod/ not found — run 'pnpm build:safari' first!"
    echo "           Without this step, the extension JS/HTML/CSS will NOT be updated."
fi

echo ""

# ── 7. Warn about duplicates / stale files ──

HAS_WARNINGS=false

# Warn about ExtensionMessageHandler.swift (no longer needed)
for dir in "$APP_DIR" "$EXT_DIR"; do
    if [ -f "$dir/ExtensionMessageHandler.swift" ]; then
        if [ "$HAS_WARNINGS" = false ]; then echo "WARNINGS:"; HAS_WARNINGS=true; fi
        echo "  ExtensionMessageHandler.swift in $(basename "$dir") is OBSOLETE"
        echo "  → Delete it from Xcode (it was replaced by SafariWebExtensionHandler)"
    fi
done

# Warn about old StoreKitManager in Extension (no longer needed there)
if [ -f "$EXT_DIR/StoreKitManager.swift" ]; then
    if [ "$HAS_WARNINGS" = false ]; then echo "WARNINGS:"; HAS_WARNINGS=true; fi
    echo "  StoreKitManager.swift in $(basename "$EXT_DIR") is NO LONGER NEEDED"
    echo "  → Delete it from the Extension target (purchases happen in the App now)"
fi

# Warn about duplicates in platform folders
for PLATFORM_DIR in "iOS (App)" "macOS (App)"; do
    DIR="$XCODE_PROJECT/$PLATFORM_DIR"
    if [ -d "$DIR" ]; then
        for fname in ContentView.swift StoreKitManager.swift SharedDefaults.swift ExtensionMessageHandler.swift SafariWebExtensionHandler.swift PrivacyInfo.xcprivacy; do
            if [ -f "$DIR/$fname" ]; then
                if [ "$HAS_WARNINGS" = false ]; then echo "WARNINGS:"; HAS_WARNINGS=true; fi
                echo "  Duplicate: $PLATFORM_DIR/$fname → DELETE from Xcode"
            fi
        done
    fi
done

echo ""
echo "=== Setup complete ==="
echo ""
echo "In Xcode:"
echo ""
echo "  1. CLEAN UP:"
echo "     → Delete any red (broken) file references at the project root"
echo "     → Delete ExtensionMessageHandler.swift if present (obsolete)"
echo "     → Delete StoreKitManager.swift from Extension target (no longer needed there)"
echo "     → Delete duplicates in 'iOS (App)' and 'macOS (App)' folders"
echo ""
echo "  2. ADD files to App target (from '$(basename "$APP_DIR")'):"
echo "     → Right-click '$(basename "$APP_DIR")' → Add Files..."
echo "     → Select: ViewController.swift, ContentView.swift, StoreKitManager.swift,"
echo "       SharedDefaults.swift, PrivacyInfo.xcprivacy"
echo "     → Targets: ✅ ContextFlow (iOS)  ✅ ContextFlow (macOS)"
echo "     NOTE: ViewController.swift REPLACES the converter-generated one"
echo ""
echo "  2b. APP ICON (already copied by this script):"
echo "     → Open Assets.xcassets in '$(basename "$APP_DIR")'"
echo "     → Verify AppIcon shows the ContextFlow icon (sparkles on gradient)"
echo "     → If empty: drag icon-1024.png from AppIcon.appiconset into the slot"
echo ""
echo "  3. ADD files to Extension target (from '$(basename "$EXT_DIR")'):"
echo "     → Replace the existing SafariWebExtensionHandler.swift"
echo "       (delete old one first, then Add the new one)"
echo "     → Also add SharedDefaults.swift to the Extension target"
echo "     → Targets: ✅ ContextFlow Extension (iOS)  ✅ ContextFlow Extension (macOS)"
echo ""
echo "  4. SET deployment targets:"
echo "     → Select project (blue icon) → Build Settings → search 'deployment'"
echo "     → macOS Deployment Target: 12.0"
echo "     → iOS Deployment Target: 15.0"
echo ""
echo "  5. ADD capabilities:"
echo "     a) In-App Purchase (App targets only):"
echo "        → ContextFlow (iOS): Signing & Capabilities → + → In-App Purchase"
echo "        → ContextFlow (macOS): Signing & Capabilities → + → In-App Purchase"
echo ""
echo "     b) App Groups (ALL 4 targets):"
echo "        → Add group: group.com.contextflow.shared"
echo "        → ContextFlow (iOS):                ✅ App Groups"
echo "        → ContextFlow (macOS):               ✅ App Groups"
echo "        → ContextFlow Extension (iOS):       ✅ App Groups"
echo "        → ContextFlow Extension (macOS):     ✅ App Groups"
echo ""
echo "  6. REGISTER URL Scheme (App targets):"
echo "     → Select ContextFlow (macOS) target → Info → URL Types"
echo "     → Click +, set URL Schemes: contextflow"
echo "     → Repeat for ContextFlow (iOS)"
echo ""
echo "  7. ENABLE StoreKit testing (for local dev):"
echo "     → Product → Scheme → Edit Scheme → Run → Options"
echo "     → StoreKit Configuration → select 'ContextFlow.storekit'"
echo "     → Do this for BOTH macOS and iOS schemes"
echo ""
echo "  8. Build (Cmd+B)"
echo ""
