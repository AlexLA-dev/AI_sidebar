#!/bin/bash
#
# setup-xcode.sh — Integrates native Swift files into the generated Xcode project.
#
# Run this AFTER `safari-web-extension-converter` generates the ContextFlow project.
# It copies StoreKit, ExtensionMessageHandler, ContentView, and PrivacyInfo
# into the "Shared (App)" folder so they compile for both iOS and macOS.
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

# 3. Detect the target folder
# The converter creates "Shared (App)/" for universal builds.
# Files go ONLY there — NOT into "iOS (App)/" or "macOS (App)/"
# because native files use #if os() for platform differences.
# Duplicating into platform folders causes "Ambiguous use of init()" errors.

if [ -d "$XCODE_PROJECT/Shared (App)" ]; then
    APP_DIR="$XCODE_PROJECT/Shared (App)"
elif [ -d "$XCODE_PROJECT/ContextFlow" ] && [ ! -f "$XCODE_PROJECT/ContextFlow/project.pbxproj" ]; then
    APP_DIR="$XCODE_PROJECT/ContextFlow"
else
    echo "ERROR: Could not detect app target folder inside $XCODE_PROJECT"
    echo ""
    echo "Expected one of:"
    echo "  - Shared (App)/"
    echo "  - ContextFlow/"
    echo ""
    echo "Contents of $XCODE_PROJECT:"
    ls -la "$XCODE_PROJECT"
    exit 1
fi

echo "Xcode project:  $XCODE_PROJECT"
echo "Native sources: $SOURCES_DIR"
echo "Target dir:     $APP_DIR"
echo ""

# 4. Copy Swift source files
echo "Copying Swift files..."
for file in "$SOURCES_DIR"/*.swift; do
    filename=$(basename "$file")
    if [ -f "$APP_DIR/$filename" ]; then
        echo "  [update] $filename"
    else
        echo "  [new]    $filename"
    fi
    cp "$file" "$APP_DIR/$filename"
done

# 5. Copy PrivacyInfo.xcprivacy
echo "Copying PrivacyInfo.xcprivacy..."
if [ -f "$NATIVE_DIR/PrivacyInfo.xcprivacy" ]; then
    cp "$NATIVE_DIR/PrivacyInfo.xcprivacy" "$APP_DIR/PrivacyInfo.xcprivacy"
    echo "  [ok] PrivacyInfo.xcprivacy"
else
    echo "  [skip] PrivacyInfo.xcprivacy not found in native/"
fi

# 6. Warn about duplicates in platform folders
echo ""
HAS_DUPLICATES=false
for PLATFORM_DIR in "iOS (App)" "macOS (App)"; do
    DIR="$XCODE_PROJECT/$PLATFORM_DIR"
    if [ -d "$DIR" ]; then
        for fname in ContentView.swift StoreKitManager.swift ExtensionMessageHandler.swift PrivacyInfo.xcprivacy; do
            if [ -f "$DIR/$fname" ]; then
                if [ "$HAS_DUPLICATES" = false ]; then
                    echo "⚠️  WARNING: Found duplicate files in platform folders."
                    echo "   These cause 'Ambiguous use of init()' errors."
                    echo "   Remove them — files should ONLY be in '$APP_DIR'."
                    echo ""
                    HAS_DUPLICATES=true
                fi
                echo "   DELETE: $PLATFORM_DIR/$fname"
            fi
        done
    fi
done

echo ""
echo "=== Files copied to: $(basename "$APP_DIR")/ ==="
echo ""
echo "Now open Xcode and complete the setup:"
echo ""
echo "  1. CLEAN UP duplicates (if any warnings above):"
echo "     → In the Project Navigator, check 'iOS (App)' and 'macOS (App)' folders"
echo "     → If you see ContentView, StoreKitManager, ExtensionMessageHandler,"
echo "       or PrivacyInfo there — select them → Delete → 'Move to Trash'"
echo "     → Also remove any red (broken) file references at the project root"
echo ""
echo "  2. Add files from '$(basename "$APP_DIR")/' to the project:"
echo "     → Right-click '$(basename "$APP_DIR")' → 'Add Files to \"ContextFlow\"...'"
echo "     → Select: ContentView.swift, StoreKitManager.swift,"
echo "       ExtensionMessageHandler.swift, PrivacyInfo.xcprivacy"
echo "     → Check BOTH targets: ✅ ContextFlow (iOS)  ✅ ContextFlow (macOS)"
echo "     → Click 'Add'"
echo ""
echo "  3. Fix ViewController.swift (in Shared (App)):"
echo "     → Line 20: change 'NSViewController' to 'PlatformViewController'"
echo "     → class ViewController: PlatformViewController, WKNavigationDelegate {"
echo ""
echo "  4. Add In-App Purchase capability:"
echo "     → ContextFlow.xcodeproj → Signing & Capabilities → + → In-App Purchase"
echo ""
echo "  5. Build (Cmd+B) — errors should be resolved!"
echo ""
