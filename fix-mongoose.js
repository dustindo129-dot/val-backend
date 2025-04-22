import fs from 'fs';

const filePath = './node_modules/mongoose/lib/collection.js';
let content = fs.readFileSync(filePath, 'utf-8');

if (!content.includes(`require('./connectionstate.js')`)) {
  const patchedContent = content.replace(
    `require('./connectionstate')`,
    `require('./connectionstate.js')`
  );
  fs.writeFileSync(filePath, patchedContent);
  console.log('✅ mongoose patched successfully.');
} else {
  console.log('mongoose already patched.');
} 