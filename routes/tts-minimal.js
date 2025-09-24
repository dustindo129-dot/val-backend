import express from 'express';

const router = express.Router();

console.log('📝 TTS Minimal route file loaded');

// Minimal test route
router.get('/test', (req, res) => {
    console.log('🎯 Minimal TTS test route hit');
    res.json({
        success: true,
        message: 'Minimal TTS route working',
        timestamp: new Date().toISOString()
    });
});

// Minimal voices route
router.get('/voices', (req, res) => {
    console.log('🎯 Minimal voices route hit');
    res.json({
        success: true,
        voices: ['vi-VN-Standard-A'],
        totalVoices: 1
    });
});

console.log('✅ TTS Minimal routes configured');

export default router;
