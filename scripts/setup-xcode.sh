#!/bin/bash
#
# setup-xcode.sh — Integrates native Swift files into the generated Xcode project.
#
# Run this AFTER `safari-web-extension-converter` generates the ContextFlow project.
# It copies StoreKit, ExtensionMessageHandler, ContentView, and PrivacyInfo
# into the correct locations so Xcode can find them.
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

# 3. Detect the generated project structure
# The converter creates different folder layouts depending on version/flags:
#   - Modern (universal): "Shared (App)/", "iOS (App)/", "macOS (App)/"
#   - Modern (single):    "Shared (App)/"
#   - Legacy:             "ContextFlow/" (inner folder matching app name)
APP_DIRS=()

if [ -d "$XCODE_PROJECT/Shared (App)" ]; then
    APP_DIRS+=("$XCODE_PROJECT/Shared (App)")
fi
if [ -d "$XCODE_PROJECT/iOS (App)" ]; then
    APP_DIRS+=("$XCODE_PROJECT/iOS (App)")
fi
if [ -d "$XCODE_PROJECT/macOS (App)" ]; then
    APP_DIRS+=("$XCODE_PROJECT/macOS (App)")
fi
if [ -d "$XCODE_PROJECT/ContextFlow" ] && [ ! -f "$XCODE_PROJECT/ContextFlow/project.pbxproj" ]; then
    # Inner "ContextFlow" folder exists and is NOT the .xcodeproj bundle
    APP_DIRS+=("$XCODE_PROJECT/ContextFlow")
fi

if [ ${#APP_DIRS[@]} -eq 0 ]; then
    echo "ERROR: Could not detect app target folder inside $XCODE_PROJECT"
    echo ""
    echo "Expected one of:"
    echo "  - Shared (App)/"
    echo "  - iOS (App)/ + macOS (App)/"
    echo "  - ContextFlow/"
    echo ""
    echo "Contents of $XCODE_PROJECT:"
    ls -la "$XCODE_PROJECT"
    exit 1
fi

echo "Xcode project:  $XCODE_PROJECT"
echo "Native sources: $SOURCES_DIR"
echo "Target dirs:    ${APP_DIRS[*]}"
echo ""

# 4. Copy Swift source files into each target folder
for APP_DIR in "${APP_DIRS[@]}"; do
    echo "--- Copying to: $APP_DIR ---"

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

    echo "Copying PrivacyInfo.xcprivacy..."
    if [ -f "$NATIVE_DIR/PrivacyInfo.xcprivacy" ]; then
        cp "$NATIVE_DIR/PrivacyInfo.xcprivacy" "$APP_DIR/PrivacyInfo.xcprivacy"
        echo "  [ok] PrivacyInfo.xcprivacy"
    else
        echo "  [skip] PrivacyInfo.xcprivacy not found in native/"
    fi
    echo ""
done

echo "=== Files copied successfully ==="
echo ""
echo "Now open Xcode and complete the setup:"
echo ""
echo "  1. In Xcode, for EACH app folder that received files:"
echo "     → Right-click the folder → 'Add Files to \"ContextFlow\"...'"
echo "     → Select ALL newly copied files:"
echo "       - ContentView.swift"
echo "       - StoreKitManager.swift"
echo "       - ExtensionMessageHandler.swift"
echo "       - PrivacyInfo.xcprivacy"
echo "     → Make sure BOTH targets are checked:"
echo "       ✅ ContextFlow (iOS)"
echo "       ✅ ContextFlow (macOS)"
echo "     → Click 'Add'"
echo ""
echo "  2. Add In-App Purchase capability:"
echo "     → Click ContextFlow.xcodeproj in navigator"
echo "     → Select target 'ContextFlow'"
echo "     → Signing & Capabilities → + Capability → In-App Purchase"
echo ""
echo "  3. Set deployment targets (General tab):"
echo "     → macOS: 13.0"
echo "     → iOS: 16.0"
echo ""
echo "  4. Connect ExtensionMessageHandler to WebView:"
echo "     → Open ViewController.swift"
echo "     → See RELEASE_GUIDE.md section 4.5 for the code changes"
echo ""
echo "  5. Build (Cmd+B) — errors should be resolved!"
echo ""
