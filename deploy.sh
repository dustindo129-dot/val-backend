#!/bin/bash

echo "Installing dependencies..."
npm ci

echo "Applying mongoose ESM patch..."
node fix-mongoose.js || echo "mongoose patch skipped"

echo "Building frontend with Vite..."
cd ..
npm install
npm run build
cd server

echo "✅ Deployment build complete."
