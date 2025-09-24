// Simple test to check if TTS routes are working
import fetch from 'node-fetch';

console.log('Testing TTS Routes...\n');

// Test the voices endpoint (no auth required)
async function testVoicesEndpoint() {
    try {
        console.log('1. Testing GET /api/tts/voices');
        const response = await fetch('http://localhost:5000/api/tts/voices');
        const data = await response.json();
        
        if (response.ok) {
            console.log('✅ Voices endpoint working');
            console.log('Available voices:', data.voices.standard.length + data.voices.wavenet.length + data.voices.neural2.length);
        } else {
            console.log('❌ Voices endpoint failed:', response.status, data);
        }
    } catch (error) {
        console.log('❌ Voices endpoint error:', error.message);
    }
}

// Test the pricing endpoint
async function testPricingEndpoint() {
    try {
        console.log('\n2. Testing GET /api/tts/pricing');
        const response = await fetch('http://localhost:5000/api/tts/pricing');
        const data = await response.json();
        
        if (response.ok) {
            console.log('✅ Pricing endpoint working');
            console.log('Cost per 1000 chars:', data.pricing.costPer1000CharactersVND, 'VND');
        } else {
            console.log('❌ Pricing endpoint failed:', response.status, data);
        }
    } catch (error) {
        console.log('❌ Pricing endpoint error:', error.message);
    }
}

// Test basic server connectivity
async function testServerConnectivity() {
    try {
        console.log('\n3. Testing server connectivity');
        const response = await fetch('http://localhost:5000/api/tts/voices');
        console.log('✅ Server is responding on port 5000');
        console.log('Response status:', response.status);
    } catch (error) {
        console.log('❌ Server not responding:', error.message);
        console.log('Make sure your server is running with: npm run dev');
    }
}

async function runTests() {
    await testServerConnectivity();
    await testVoicesEndpoint();
    await testPricingEndpoint();
    
    console.log('\n📋 Test Summary:');
    console.log('If all tests pass, the TTS routes are working correctly.');
    console.log('If tests fail, check your server logs for errors.');
    console.log('\nNext step: Test TTS generation with authentication');
}

runTests().catch(console.error);
