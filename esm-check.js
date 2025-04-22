#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const readdir = promisify(fs.readdir);
const readFile = promisify(fs.readFile);
const stat = promisify(fs.stat);

// Directories to exclude
const excludeDirs = ['node_modules', '.git', '.do'];

async function findJsFiles(dir) {
  const files = [];
  const entries = await readdir(dir);
  
  for (const entry of entries) {
    if (excludeDirs.includes(entry)) continue;
    
    const fullPath = path.join(dir, entry);
    const stats = await stat(fullPath);
    
    if (stats.isDirectory()) {
      const subFiles = await findJsFiles(fullPath);
      files.push(...subFiles);
    } else if (entry.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  
  return files;
}

async function checkEsmImports(file) {
  const content = await readFile(file, 'utf8');
  const importRegex = /\s*import\s+.+\s+from\s+['"].+['"];?/g;
  const exportRegex = /\s*export\s+(?:default\s+)?(?:const|let|var|function|class)/g;
  
  const importMatches = content.match(importRegex) || [];
  const exportMatches = content.match(exportRegex) || [];
  
  return {
    file,
    importMatches,
    exportMatches,
    hasEsmSyntax: importMatches.length > 0 || exportMatches.length > 0
  };
}

async function main() {
  try {
    const jsFiles = await findJsFiles('.');
    const results = await Promise.all(jsFiles.map(checkEsmImports));
    
    const filesWithEsm = results.filter(r => r.hasEsmSyntax);
    
    if (filesWithEsm.length > 0) {
      console.log('Files using ESM syntax that need to be converted to CommonJS:');
      filesWithEsm.forEach(({ file, importMatches, exportMatches }) => {
        console.log(`\n${file}:`);
        
        if (importMatches.length > 0) {
          console.log('  Import statements:');
          importMatches.forEach(m => console.log(`    ${m.trim()}`));
        }
        
        if (exportMatches.length > 0) {
          console.log('  Export statements:');
          exportMatches.forEach(m => console.log(`    ${m.trim()}`));
        }
      });
    } else {
      console.log('No files with ESM syntax found.');
    }
  } catch (err) {
    console.error('Error:', err);
  }
}

main(); 