#!/bin/bash
# npm install --global @vscode/vsce
# install:
# code --install-extension /workspaces/Roo-CodeDev/roo-cline-testversion-XXX.vsix

# Define original and test names
ORIGINAL_NAME="roo-cline"
TEST_NAME="roo-cline-testversion" # VSIX names typically don't have spaces or special chars

ORIGINAL_DISPLAY_NAME="%extension.displayName%"
TEST_DISPLAY_NAME="Roo Code (Testversion)"

# Backup package.json
cp package.json package.json.bak

echo "Modifying package.json for test build..."
# Replace the name in package.json
sed -i 's/"name": "'"$ORIGINAL_NAME"'"/"name": "'"$TEST_NAME"'"/' package.json
# Replace the displayName in package.json
# Note: Using a different delimiter for sed because the replacement string contains '%'
sed -i 's#"displayName": "'"$ORIGINAL_DISPLAY_NAME"'"#"displayName": "'"$TEST_DISPLAY_NAME"'"#' package.json

echo "Packaging the extension..."
# Package the extension with vsce
vsce package

echo "Reverting package.json..."
# Revert the name change after packaging
mv package.json.bak package.json

echo "Done. Test version packaged."
echo "The VSIX file will be named something like: ${TEST_NAME}-<version>.vsix"