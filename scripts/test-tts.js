#!/usr/bin/env node

/**
 * TTS System Test Script
 * Tests the TTS functionality without requiring frontend interaction
 */

import dotenv from 'dotenv';
import { generateTTS } from '../services/ttsService.js';
import fs from 'fs';
import path from 'path';

// Load environment variables
dotenv.config();

console.log('🎵 TTS System Test');
console.log('==================\n');

// Test parameters
const testText = 'Xin chào, đây là bài kiểm tra Text-to-Speech cho hệ thống Val.js. Hệ thống này sẽ chuyển đổi văn bản tiếng Việt thành giọng nói.';
const testUserId = 'test-user-123';

async function runTTSTest() {
    try {
        console.log('📝 Test Text:', testText);
        console.log('📊 Character Count:', testText.length);
        console.log('👤 Test User ID:', testUserId);
        console.log('');

        console.log('🔄 Generating TTS audio...');
        const startTime = Date.now();

        const result = await generateTTS({
            text: testText,
            languageCode: 'vi-VN',
            voiceName: 'vi-VN-Standard-A',
            audioConfig: {
                audioEncoding: 'MP3',
                speakingRate: 1.0,
                pitch: 0.0,
                volumeGainDb: 0.0
            },
            userId: testUserId,
            characterCount: testText.length
        });

        const endTime = Date.now();
        const processingTime = endTime - startTime;

        console.log('✅ TTS Generation Successful!');
        console.log('');
        console.log('📋 Results:');
        console.log('  Audio URL:', result.audioUrl);
        console.log('  Character Count:', result.characterCount);
        console.log('  Estimated Cost (VND):', result.estimatedCostVND);
        console.log('  Voice Used:', result.voiceUsed);
        console.log('  Duration (seconds):', result.duration);
        console.log('  Cache Hit:', result.cacheHit);
        console.log('  Processing Time (ms):', processingTime);

        // Check if audio file exists
        const audioPath = result.audioUrl.replace(/^.*\/tts-cache\//, 'public/tts-cache/');
        const fullAudioPath = path.join(process.cwd(), audioPath);
        
        console.log('');
        console.log('📁 File System Check:');
        console.log('  Expected Path:', fullAudioPath);
        
        if (fs.existsSync(fullAudioPath)) {
            const stats = fs.statSync(fullAudioPath);
            console.log('  ✅ Audio file exists');
            console.log('  📏 File Size:', stats.size, 'bytes');
            console.log('  📅 Created:', stats.birthtime.toISOString());
        } else {
            console.log('  ❌ Audio file not found');
        }

        // Test cache directory
        const cacheDir = path.join(process.cwd(), 'public/tts-cache');
        console.log('');
        console.log('📂 Cache Directory Check:');
        console.log('  Directory:', cacheDir);
        
        if (fs.existsSync(cacheDir)) {
            const files = fs.readdirSync(cacheDir);
            console.log('  ✅ Cache directory exists');
            console.log('  📄 Files in cache:', files.length);
            files.forEach(file => {
                const filePath = path.join(cacheDir, file);
                const stats = fs.statSync(filePath);
                console.log(`    - ${file} (${stats.size} bytes)`);
            });
        } else {
            console.log('  ❌ Cache directory not found');
        }

        console.log('');
        console.log('🎉 Test completed successfully!');
        return true;

    } catch (error) {
        console.error('❌ TTS Test Failed:');
        console.error('  Error:', error.message);
        console.error('  Stack:', error.stack);
        return false;
    }
}

async function checkEnvironment() {
    console.log('🔧 Environment Check:');
    console.log('  Node Version:', process.version);
    console.log('  Google Cloud Project ID:', process.env.GOOGLE_CLOUD_PROJECT_ID || 'Not set');
    console.log('  Google Cloud Key File:', process.env.GOOGLE_CLOUD_KEY_FILE || 'Not set');
    
    // Check if Google Cloud key file exists
    if (process.env.GOOGLE_CLOUD_KEY_FILE) {
        const keyPath = path.resolve(process.env.GOOGLE_CLOUD_KEY_FILE);
        console.log('  Key File Path:', keyPath);
        console.log('  Key File Exists:', fs.existsSync(keyPath) ? '✅' : '❌');
    }
    
    console.log('');
}

async function main() {
    await checkEnvironment();
    
    const success = await runTTSTest();
    
    console.log('');
    if (success) {
        console.log('🎊 All tests passed! TTS system is working correctly.');
        console.log('');
        console.log('💡 Next steps:');
        console.log('  1. Start your server: npm run dev');
        console.log('  2. Test TTS from frontend');
        console.log('  3. Check browser console for any errors');
        console.log('  4. Test with actual chapter content');
    } else {
        console.log('💥 Tests failed. Please check the errors above.');
        console.log('');
        console.log('🔧 Troubleshooting:');
        console.log('  1. Ensure Google Cloud credentials are set up');
        console.log('  2. Check if Text-to-Speech API is enabled');
        console.log('  3. Verify service account permissions');
        console.log('  4. Check server logs for detailed errors');
    }
    
    process.exit(success ? 0 : 1);
}

// Run the test
main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
