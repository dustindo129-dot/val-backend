#!/bin/bash

echo "Installing dependencies..."
npm ci

echo "Applying mongoose ESM patch..."
node fix-mongoose.js || echo "mongoose patch skipped"

echo "✅ Deployment build complete." 