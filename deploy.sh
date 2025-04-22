#!/bin/bash

echo "Installing dependencies..."
npm ci

echo "Applying mongoose ESM patch..."
node fix-mongoose.js || echo "mongoose patch skipped"

echo "Building frontend with Vite..."
cd ..
npm install
npm run build
# Verify that the build directory exists
if [ -d "dist/client" ]; then
  echo "✅ Frontend build complete in dist/client"
else
  echo "❌ Error: Frontend build directory not found"
  ls -la dist || echo "dist directory not found"
fi
cd server

echo "✅ Deployment build complete."
