#!/bin/bash

# Install backend dependencies
echo "Installing npm packages..."
npm install

# Apply the mongoose fix directly during build
echo "Patching Mongoose collection.js file..."
node fix-mongoose.js

echo "Build completed successfully"
