// Validation script to test TTS route accessibility
console.log('🔍 TTS Route Validation Script');
console.log('===============================\n');

// Test 1: Basic server connectivity
console.log('Test 1: Basic server connectivity');
try {
    const response = await fetch('http://localhost:5000/api/tts/test');
    console.log('✅ Server responds to TTS test route');
    console.log('Response status:', response.status);
    const data = await response.json();
    console.log('Response data:', data);
} catch (error) {
    console.log('❌ Server connectivity failed:', error.message);
}

console.log('\nTest 2: Voices endpoint');
try {
    const response = await fetch('http://localhost:5000/api/tts/voices');
    console.log('✅ Voices endpoint accessible');
    console.log('Response status:', response.status);
} catch (error) {
    console.log('❌ Voices endpoint failed:', error.message);
}

console.log('\nTest 3: TTS Generate (without auth - should fail)');
try {
    const response = await fetch('http://localhost:5000/api/tts/generate', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            text: 'Test text'
        })
    });
    console.log('Response status:', response.status);
    if (response.status === 401) {
        console.log('✅ Auth required (expected behavior)');
    } else {
        console.log('❓ Unexpected response status');
    }
} catch (error) {
    console.log('❌ Generate endpoint failed:', error.message);
}

console.log('\n📋 Validation Complete');
console.log('If Test 1 and 2 pass, server and routes are working.');
console.log('If Test 3 returns 401, authentication is working correctly.');
