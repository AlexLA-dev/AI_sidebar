#!/bin/bash
#
# setup-xcode.sh — Copies native Swift files into the generated Xcode project.
#
# Run this AFTER safari-web-extension-converter has generated the ContextFlow
# Xcode project. It copies StoreKit files, ContentView, ViewController,
# and PrivacyInfo.xcprivacy into the correct locations.
#
# Usage:
#   ./scripts/setup-xcode.sh
#
# The script assumes it is run from the repository root (AI_sidebar/).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
XCODE_PROJECT="$REPO_ROOT/ContextFlow"
MAIN_TARGET="$XCODE_PROJECT/ContextFlow"
NATIVE_SOURCES="$REPO_ROOT/native/ContextFlow/Sources"
NATIVE_ROOT="$REPO_ROOT/native/ContextFlow"

# --- Validate prerequisites ---

if [ ! -d "$XCODE_PROJECT" ]; then
    echo "ERROR: ContextFlow Xcode project not found at $XCODE_PROJECT"
    echo ""
    echo "Run the converter first:"
    echo "  xcrun safari-web-extension-converter ./build/safari-mv3-prod \\"
    echo "    --app-name \"ContextFlow\" \\"
    echo "    --bundle-identifier \"com.contextflow.app\" \\"
    echo "    --swift --copy-resources --force"
    exit 1
fi

if [ ! -d "$MAIN_TARGET" ]; then
    echo "ERROR: Main target folder not found at $MAIN_TARGET"
    echo "The converter may have generated a different folder structure."
    echo "Check the contents of $XCODE_PROJECT and adjust the script."
    exit 1
fi

# --- Copy Swift source files ---

echo "Copying Swift files into $MAIN_TARGET ..."

cp "$NATIVE_SOURCES/ContentView.swift"              "$MAIN_TARGET/"
cp "$NATIVE_SOURCES/StoreKitManager.swift"           "$MAIN_TARGET/"
cp "$NATIVE_SOURCES/ExtensionMessageHandler.swift"   "$MAIN_TARGET/"

# Replace the auto-generated ViewController.swift with ours
# (hosts the SwiftUI ContentView via NSHostingView / UIHostingController)
cp "$NATIVE_SOURCES/ViewController.swift"            "$MAIN_TARGET/"

echo "Copying PrivacyInfo.xcprivacy ..."
cp "$NATIVE_ROOT/PrivacyInfo.xcprivacy"              "$MAIN_TARGET/"

echo ""
echo "=== Files copied successfully ==="
echo ""
echo "Now open the Xcode project and add the new files to the build target:"
echo ""
echo "  open $XCODE_PROJECT/ContextFlow.xcodeproj"
echo ""
echo "In Xcode:"
echo "  1. Right-click the 'ContextFlow' group (main target) in the Project Navigator"
echo "  2. Select 'Add Files to \"ContextFlow\"...'"
echo "  3. Navigate to: $MAIN_TARGET"
echo "  4. Select these files (they are now IN the project folder):"
echo "       - ContentView.swift"
echo "       - StoreKitManager.swift"
echo "       - ExtensionMessageHandler.swift"
echo "       - PrivacyInfo.xcprivacy"
echo "     (Do NOT re-add ViewController.swift — it was replaced in place)"
echo "  5. Make sure 'Target: ContextFlow' is checked"
echo "  6. Click 'Add'"
echo ""
echo "  7. Add capability: Signing & Capabilities → + Capability → In-App Purchase"
echo "  8. Build with Cmd+B to verify no errors"
echo ""
