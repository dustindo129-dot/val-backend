// Fix Mongoose module resolution in ESM mode
// This script should be run before starting the application

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the collection.js file in mongoose
const collectionPath = path.resolve(__dirname, 'node_modules/mongoose/lib/collection.js');

// Check if the file exists
if (fs.existsSync(collectionPath)) {
  let content = fs.readFileSync(collectionPath, 'utf8');
  
  // Replace the require without extension with one that includes the extension
  content = content.replace(
    "const STATES = require('./connectionstate');",
    "const STATES = require('./connectionstate.js');"
  );
  
  // Write the modified content back to the file
  fs.writeFileSync(collectionPath, content, 'utf8');
  
  console.log('Successfully patched Mongoose collection.js file');
} else {
  console.error('Could not find Mongoose collection.js file');
} 