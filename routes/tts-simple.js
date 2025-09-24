// Simplified TTS route for testing
import express from 'express';
import { auth } from '../middleware/auth.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const router = express.Router();

// Simple TTS generation using mock data
const generateSimpleTTS = async (text, userId) => {
    try {
        // Create cache directory if it doesn't exist
        const cacheDir = path.join(process.cwd(), 'public', 'tts-cache');
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }

        // Generate cache key
        const cacheKey = crypto.createHash('sha256').update(text).digest('hex');
        const cacheFilePath = path.join(cacheDir, `${cacheKey}.mp3`);

        // Create simple mock MP3 file
        const mockAudioData = Buffer.from([
            // MP3 Frame Header
            0xFF, 0xE0, 0x18, 0xC4,
            // Simple frame data
            ...Array(256).fill(0x00)
        ]);

        // Save to cache
        fs.writeFileSync(cacheFilePath, mockAudioData);

        const audioUrl = `${process.env.BACKEND_URL || 'http://localhost:5000'}/tts-cache/${cacheKey}.mp3`;
        
        console.log(`Generated simple TTS for user ${userId}: ${text.length} characters`);
        console.log(`Audio saved to: ${cacheFilePath}`);
        console.log(`Audio URL: ${audioUrl}`);

        return {
            audioUrl,
            characterCount: text.length,
            estimatedCostVND: Math.ceil(text.length * 0.098),
            voiceUsed: 'vi-VN-Standard-A',
            duration: Math.max(1, Math.ceil(text.length / 100)),
            cacheHit: false
        };
    } catch (error) {
        console.error('Simple TTS generation error:', error);
        throw error;
    }
};

// Test route with error handling
router.get('/test', (req, res) => {
    try {
        console.log('🧪 TTS Test route hit');
        res.json({
            success: true,
            message: 'TTS route is working',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Test route error:', error);
        res.status(500).json({
            success: false,
            message: 'Test route error',
            error: error.message
        });
    }
});

// Simple voices route
router.get('/voices', (req, res) => {
    try {
        const voices = {
            standard: [
                {
                    name: 'vi-VN-Standard-A',
                    gender: 'FEMALE',
                    description: 'Vietnamese female voice (Standard quality)',
                    sampleRate: 24000
                }
            ]
        };

        res.json({
            success: true,
            voices,
            totalVoices: 1
        });
    } catch (error) {
        console.error('Voices route error:', error);
        res.status(500).json({
            success: false,
            message: 'Error getting voices',
            error: error.message
        });
    }
});

// Simple pricing route
router.get('/pricing', (req, res) => {
    try {
        res.json({
            success: true,
            pricing: {
                costPerCharacterVND: 0.098,
                costPer1000CharactersVND: 98,
                freeQuotaPerMonth: 1000000
            }
        });
    } catch (error) {
        console.error('Pricing route error:', error);
        res.status(500).json({
            success: false,
            message: 'Error getting pricing',
            error: error.message
        });
    }
});

// Simple TTS generation route - with comprehensive logging
router.post('/generate', (req, res, next) => {
    console.log('=== TTS Route Hit (BEFORE AUTH) ===');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Request method:', req.method);
    console.log('Request URL:', req.url);
    console.log('Request headers:', {
        'content-type': req.headers['content-type'],
        'authorization': req.headers.authorization ? 'Bearer [TOKEN]' : 'No auth header',
        'user-agent': req.headers['user-agent']
    });
    console.log('Request body keys:', Object.keys(req.body || {}));
    next();
}, auth, async (req, res) => {
    console.log('=== TTS Route (AFTER AUTH SUCCESS) ===');
    console.log('User ID:', req.user?.id);
    console.log('User data:', req.user);
    console.log('Request body:', req.body);
    
    try {
        const { text, languageCode = 'vi-VN', voiceName = 'vi-VN-Standard-A' } = req.body;
        
        if (!text || text.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Text is required'
            });
        }

        if (text.length > 100000) {
            return res.status(400).json({
                success: false,
                message: 'Text too long (max 100,000 characters)'
            });
        }

        console.log(`Processing TTS request: ${text.length} characters`);
        
        const result = await generateSimpleTTS(text, req.user.id);
        
        console.log('TTS generation successful:', result);
        
        res.json({
            success: true,
            audioUrl: result.audioUrl,
            characterCount: result.characterCount,
            estimatedCostVND: result.estimatedCostVND,
            duration: result.duration,
            voiceUsed: result.voiceUsed,
            cacheHit: result.cacheHit
        });
        
    } catch (error) {
        console.error('TTS generation error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate TTS audio',
            error: error.message
        });
    }
});

export default router;
