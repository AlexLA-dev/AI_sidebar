#!/bin/bash
#
# setup-xcode.sh — Integrates native Swift files into the generated Xcode project.
#
# Run this AFTER `safari-web-extension-converter` generates the ContextFlow project.
# Copies files to two locations:
#   - "Shared (App)/"      → ContentView, StoreKitManager, PrivacyInfo
#   - "Shared (Extension)/" → SafariWebExtensionHandler (replaces default), StoreKitManager
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

# App target gets: ContentView, StoreKitManager, PrivacyInfo
for fname in ContentView.swift StoreKitManager.swift; do
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

echo ""

# ── 6. Copy files to Extension target (Shared (Extension)) ──

echo "--- Extension target: $(basename "$EXT_DIR") ---"

# Extension target gets: SafariWebExtensionHandler (replaces default), StoreKitManager
for fname in SafariWebExtensionHandler.swift StoreKitManager.swift; do
    src="$SOURCES_DIR/$fname"
    if [ -f "$src" ]; then
        if [ -f "$EXT_DIR/$fname" ]; then echo "  [update] $fname"
        else echo "  [new]    $fname"; fi
        cp "$src" "$EXT_DIR/$fname"
    fi
done

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

# Warn about duplicates in platform folders
for PLATFORM_DIR in "iOS (App)" "macOS (App)"; do
    DIR="$XCODE_PROJECT/$PLATFORM_DIR"
    if [ -d "$DIR" ]; then
        for fname in ContentView.swift StoreKitManager.swift ExtensionMessageHandler.swift SafariWebExtensionHandler.swift PrivacyInfo.xcprivacy; do
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
echo "     → Delete duplicates in 'iOS (App)' and 'macOS (App)' folders"
echo ""
echo "  2. ADD files to App target (from '$(basename "$APP_DIR")'):"
echo "     → Right-click '$(basename "$APP_DIR")' → Add Files..."
echo "     → Select: ContentView.swift, StoreKitManager.swift, PrivacyInfo.xcprivacy"
echo "     → Targets: ✅ ContextFlow (iOS)  ✅ ContextFlow (macOS)"
echo ""
echo "  3. ADD files to Extension target (from '$(basename "$EXT_DIR")'):"
echo "     → Replace the existing SafariWebExtensionHandler.swift"
echo "       (delete old one first, then Add the new one)"
echo "     → Also add StoreKitManager.swift to the Extension target"
echo "     → Targets: ✅ ContextFlow Extension (iOS)  ✅ ContextFlow Extension (macOS)"
echo ""
echo "  4. Fix ViewController.swift (in $(basename "$APP_DIR")):"
echo "     → class ViewController: PlatformViewController, WKNavigationDelegate {"
echo "     → See RELEASE_GUIDE.md section 4.5 for the full code"
echo ""
echo "  5. Add In-App Purchase capability to BOTH targets:"
echo "     → App target: Signing & Capabilities → + → In-App Purchase"
echo "     → Extension target: Signing & Capabilities → + → In-App Purchase"
echo ""
echo "  6. Build (Cmd+B)"
echo ""
