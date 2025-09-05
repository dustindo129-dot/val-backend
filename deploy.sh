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

# Determine the script's directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$SCRIPT_DIR"

echo "📁 Script directory: $SCRIPT_DIR"
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

# Check if we're in a deployment environment where frontend should be built
# Look for frontend package.json in possible locations
FRONTEND_LOCATIONS=(
    "../package.json"           # Local development setup
    "../../package.json"        # Alternative structure
    "/app/package.json"         # Docker deployment
    "/workspace/../package.json" # DigitalOcean App Platform
)

FRONTEND_FOUND=false
FRONTEND_DIR=""

for location in "${FRONTEND_LOCATIONS[@]}"; do
    if [ -f "$location" ]; then
        FRONTEND_DIR="$(dirname "$location")"
        FRONTEND_FOUND=true
        echo "✅ Found frontend package.json at: $location"
        
        # Verify this is actually our frontend package.json by checking for key indicators
        if grep -q '"name".*"val-frontend"' "$location" 2>/dev/null; then
            echo "✅ Verified: This is our val-frontend package.json"
        elif grep -q '"vite"' "$location" 2>/dev/null; then
            echo "✅ Verified: Contains Vite dependency (likely frontend)"
        else
            echo "⚠️  Warning: This may not be the correct frontend package.json"
            echo "📄 Package name: $(grep '"name"' "$location" 2>/dev/null || echo 'not found')"
        fi
        break
    fi
done

if [ "$FRONTEND_FOUND" = true ]; then
    echo "📁 Frontend directory: $FRONTEND_DIR"
    
    # Navigate to frontend directory
    cd "$FRONTEND_DIR"
    echo "✅ In frontend directory"

    echo "📦 Installing frontend dependencies..."
    npm install || error_exit "Failed to install frontend dependencies"

    echo "🔍 Checking available npm scripts..."
    npm run 2>/dev/null || echo "Scripts listed above"
    
    # Check if build script exists, if not, try to add it
    if ! grep -q '"build"' package.json 2>/dev/null; then
        echo "⚠️  Build script missing from package.json"
        echo "🔧 Attempting to add build script..."
        
        # Create a temporary backup and add build script
        cp package.json package.json.backup
        
        # Try to add build script if vite is available
        if grep -q '"vite"' package.json 2>/dev/null; then
            echo "📝 Adding 'build': 'vite build' script..."
            # Use node to properly modify the JSON
            node -e "
                const fs = require('fs');
                const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
                if (!pkg.scripts) pkg.scripts = {};
                if (!pkg.scripts.build) pkg.scripts.build = 'vite build';
                fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
                console.log('✅ Build script added successfully');
            " || echo "❌ Failed to add build script automatically"
        fi
    fi
    
    echo "🏗️  Building frontend with Vite..."
    
    # Try different build commands in order of preference
    if npm run build 2>/dev/null; then
        echo "✅ Built with 'npm run build'"
    elif npm run build:production 2>/dev/null; then
        echo "✅ Built with 'npm run build:production'"
    elif npm run build:prod 2>/dev/null; then
        echo "✅ Built with 'npm run build:prod'"
    elif npx vite build 2>/dev/null; then
        echo "✅ Built with 'npx vite build'"
    else
        echo "❌ No suitable build command found. Tried:"
        echo "   - npm run build"
        echo "   - npm run build:production"
        echo "   - npm run build:prod"
        echo "   - npx vite build"
        echo ""
        echo "📋 Available scripts in package.json:"
        cat package.json | grep -A 20 '"scripts"' || echo "Could not read scripts from package.json"
        error_exit "Frontend build failed - no working build command found"
    fi

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
    echo "   - Build output: $FRONTEND_DIR/dist/client/"
else
    echo "⚠️  Frontend package.json not found in any expected location"
    echo "   Searched locations:"
    for location in "${FRONTEND_LOCATIONS[@]}"; do
        echo "   - $location"
    done
    echo "🏗️  Skipping frontend build (server-only deployment)"
    echo "📊 Build summary:"
    echo "   - Server dependencies: ✅ Installed"
    echo "   - Frontend dependencies: ⏭️  Skipped (not found)"
    echo "   - Frontend build: ⏭️  Skipped (server-only deployment)"
    echo "🎉 Server-only deployment complete successfully!"
fi
