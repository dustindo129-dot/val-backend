#!/bin/bash

set -e  # Exit on any error

# Function to print error and exit
error_exit() {
    echo "❌ Error: $1" >&2
    exit 1
}

# Function to check if we're in the right directory
check_directory() {
    if [ ! -f "$1" ]; then
        error_exit "Not in the correct directory. Expected to find $1"
    fi
}

echo "🚀 Starting deployment process..."

# Determine the script's directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SERVER_DIR="$SCRIPT_DIR"

echo "📁 Script directory: $SCRIPT_DIR"
echo "📁 Project root: $PROJECT_ROOT"
echo "📁 Server directory: $SERVER_DIR"

# Navigate to server directory and verify
cd "$SERVER_DIR"
check_directory "package.json"
echo "✅ In server directory"

echo "📦 Installing server dependencies..."
npm ci || error_exit "Failed to install server dependencies"

echo "🔧 Applying mongoose ESM patch..."
if [ -f "fix-mongoose.js" ]; then
    node fix-mongoose.js || echo "⚠️  mongoose patch skipped"
else
    echo "⚠️  fix-mongoose.js not found, skipping patch"
fi

# Navigate to project root and verify
cd "$PROJECT_ROOT"
check_directory "package.json"
echo "✅ In project root directory"

echo "📦 Installing frontend dependencies..."
npm install || error_exit "Failed to install frontend dependencies"

echo "🏗️  Building frontend with Vite..."
npm run build || error_exit "Frontend build failed"

# Verify that the build directory exists
if [ -d "dist/client" ]; then
    echo "✅ Frontend build complete in dist/client"
    ls -la dist/client | head -10
else
    echo "❌ Error: Frontend build directory not found"
    ls -la dist 2>/dev/null || echo "dist directory not found"
    error_exit "Frontend build directory verification failed"
fi

# Return to server directory
cd "$SERVER_DIR"
echo "✅ Returned to server directory"

echo "🎉 Deployment build complete successfully!"
echo "📊 Build summary:"
echo "   - Server dependencies: ✅ Installed"
echo "   - Frontend dependencies: ✅ Installed"
echo "   - Frontend build: ✅ Complete"
echo "   - Build output: dist/client/"
