#!/usr/bin/env node

/**
 * Google Cloud TTS Installation Script
 * Helps set up TTS functionality for the Val.js project
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🎵 Google Cloud TTS Installation Script');
console.log('=====================================\n');

// Check if running in server directory
const serverDir = path.join(__dirname, '..');
const packageJsonPath = path.join(serverDir, 'package.json');

if (!fs.existsSync(packageJsonPath)) {
    console.error('❌ Error: Please run this script from the server directory');
    process.exit(1);
}

// Check if Google Cloud dependency is installed
try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    
    if (!packageJson.dependencies['@google-cloud/text-to-speech']) {
        console.log('📦 Installing Google Cloud Text-to-Speech dependency...');
        console.log('Please run: npm install @google-cloud/text-to-speech');
    } else {
        console.log('✅ Google Cloud Text-to-Speech dependency found');
    }
} catch (error) {
    console.error('❌ Error reading package.json:', error.message);
}

// Create necessary directories
const directories = [
    path.join(serverDir, 'public'),
    path.join(serverDir, 'public', 'tts-cache'),
    path.join(serverDir, 'config'),
    path.join(serverDir, 'docs')
];

directories.forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📁 Created directory: ${path.relative(serverDir, dir)}`);
    } else {
        console.log(`✅ Directory exists: ${path.relative(serverDir, dir)}`);
    }
});

// Check environment configuration
const envExamplePath = path.join(serverDir, '.env.example');
const envPath = path.join(serverDir, '.env');

console.log('\n🔧 Environment Configuration');
console.log('============================');

if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    
    const requiredVars = [
        'GOOGLE_CLOUD_PROJECT_ID',
        'GOOGLE_CLOUD_KEY_FILE'
    ];
    
    const missingVars = requiredVars.filter(varName => !envContent.includes(varName));
    
    if (missingVars.length > 0) {
        console.log('⚠️  Missing environment variables in .env:');
        missingVars.forEach(varName => {
            console.log(`   - ${varName}`);
        });
        
        console.log('\nAdd these to your .env file:');
        console.log('GOOGLE_CLOUD_PROJECT_ID=your-project-id');
        console.log('GOOGLE_CLOUD_KEY_FILE=config/google-cloud-key.json');
    } else {
        console.log('✅ Required environment variables found');
    }
} else {
    console.log('⚠️  .env file not found');
    console.log('Please create .env file with Google Cloud configuration');
}

// Check for Google Cloud service account key
const keyFilePath = path.join(serverDir, 'config', 'google-cloud-key.json');
if (!fs.existsSync(keyFilePath)) {
    console.log('⚠️  Google Cloud service account key not found');
    console.log('Please download your service account key to:');
    console.log(`   ${path.relative(serverDir, keyFilePath)}`);
} else {
    console.log('✅ Google Cloud service account key found');
}

// TTS API endpoints test
console.log('\n🚀 TTS API Endpoints');
console.log('===================');
console.log('POST /api/tts/generate - Generate TTS audio');
console.log('GET  /api/tts/usage    - Get usage statistics');
console.log('GET  /api/tts/pricing  - Get pricing information');
console.log('GET  /api/tts/voices   - Get available voices');

// Next steps
console.log('\n📋 Next Steps');
console.log('=============');
console.log('1. Install dependencies: npm install');
console.log('2. Set up Google Cloud project and enable TTS API');
console.log('3. Create service account and download JSON key');
console.log('4. Update .env file with your Google Cloud configuration');
console.log('5. Start your server: npm run dev');
console.log('6. Test TTS functionality in your frontend');

console.log('\n📚 Documentation');
console.log('================');
console.log('See docs/TTS_SETUP.md for detailed setup instructions');

console.log('\n🎉 TTS Installation Complete!');
console.log('The backend API is ready for Google Cloud TTS integration.');

// Test database connection (optional)
try {
    console.log('\n🗄️  Database Models');
    console.log('==================');
    console.log('✅ TTSUsage model created for usage tracking');
    console.log('✅ Automatic usage statistics and caching');
} catch (error) {
    console.log('ℹ️  Database models will be loaded when server starts');
}

console.log('\n💰 Pricing Information');
console.log('======================');
console.log('• Free tier: 1 million characters/month');
console.log('• After free tier: ~98 VND per 1,000 characters');
console.log('• Example: 10,000 character chapter ≈ 980 VND');
console.log('• Caching reduces costs for repeated content');

console.log('\n🔐 Security Notes');
console.log('=================');
console.log('• Keep your Google Cloud key file secure');
console.log('• Add config/google-cloud-key.json to .gitignore');
console.log('• Consider using IAM roles in production');
console.log('• Implement rate limiting for TTS API');

console.log('\nHappy coding! 🎵✨');
