import express from 'express';
import { auth } from '../middleware/auth.js';
import { generateTTS, getTTSUsage, getTTSPricing } from '../services/ttsService.js';
import { body, validationResult } from 'express-validator';

const router = express.Router();

// TTS routes middleware
router.use((req, res, next) => {
    next();
});

// Validation middleware for TTS generation
const validateTTSRequest = [
    body('text')
        .trim()
        .isLength({ min: 1, max: 500000 })
        .withMessage('Text must be between 1 and 500,000 characters'),
    body('languageCode')
        .optional()
        .isIn(['vi-VN', 'vi'])
        .withMessage('Language code must be vi-VN or vi'),
    body('voiceName')
        .optional()
        .custom((value) => {
            // Accept new simplified names or legacy Google Cloud format
            const validVoices = ['nu', 'nam'];
            const legacyPattern = /^vi-VN-(Standard|Wavenet|Neural2)-(A|B|C|D)$/;
            return validVoices.includes(value) || legacyPattern.test(value);
        })
        .withMessage('Invalid Vietnamese voice name (use "nu" or "nam")'),
    body('audioConfig.speakingRate')
        .optional()
        .isFloat({ min: 0.25, max: 4.0 })
        .withMessage('Speaking rate must be between 0.25 and 4.0'),
    body('audioConfig.pitch')
        .optional()
        .isFloat({ min: -20.0, max: 20.0 })
        .withMessage('Pitch must be between -20.0 and 20.0'),
    body('audioConfig.volumeGainDb')
        .optional()
        .isFloat({ min: -96.0, max: 16.0 })
        .withMessage('Volume gain must be between -96.0 and 16.0 dB')
];

/**
 * @route POST /api/tts/generate
 * @desc Generate TTS audio from text using Google Cloud TTS
 * @access Private (requires authentication)
 */
router.post('/generate', [auth, ...validateTTSRequest], async (req, res) => {
    
    try {
        // Check for validation errors
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        const {
            text,
            languageCode = 'vi-VN',
            voiceName = 'nu', // Default to female voice
            audioConfig = {},
            chapterInfo = {}
        } = req.body;

        const userId = req.user.id;
        const characterCount = text.length;

        // Default audio configuration
        const defaultAudioConfig = {
            audioEncoding: 'MP3',
            speakingRate: 1.0,
            pitch: 0.0,
            volumeGainDb: 0.0,
            ...audioConfig
        };

        // Generate TTS audio
        const result = await generateTTS({
            text,
            languageCode,
            voiceName,
            audioConfig: defaultAudioConfig,
            userId,
            characterCount,
            chapterInfo
        });

        // TTS generation completed successfully
        res.json({
            success: true,
            audioUrl: result.audioUrl,
            characterCount: result.characterCount,
            estimatedCostVND: result.estimatedCostVND,
            duration: result.duration,
            voiceUsed: result.voiceUsed,
            cacheHit: result.cacheHit || false
        });

    } catch (error) {
        console.error('TTS generation error:', error.message);
        
        // Handle specific error types
        if (error.message.includes('quota')) {
            return res.status(429).json({
                success: false,
                message: 'TTS quota exceeded. Please try again later.',
                error: 'QUOTA_EXCEEDED'
            });
        }
        
        if (error.message.includes('authentication')) {
            return res.status(401).json({
                success: false,
                message: 'Authentication failed with Google Cloud TTS.',
                error: 'AUTH_FAILED'
            });
        }

        if (error.message.includes('billing')) {
            return res.status(402).json({
                success: false,
                message: 'Billing account required for TTS service.',
                error: 'BILLING_REQUIRED'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Failed to generate TTS audio. Please try again.',
            error: 'GENERATION_FAILED'
        });
    }
});

/**
 * @route GET /api/tts/usage
 * @desc Get TTS usage statistics for the authenticated user
 * @access Private
 */
router.get('/usage', auth, async (req, res) => {
    try {
        const userId = req.user.id;
        const { period = 'month' } = req.query; // month, week, day
        
        const usage = await getTTSUsage(userId, period);
        
        res.json({
            success: true,
            usage: {
                totalCharacters: usage.totalCharacters,
                totalRequests: usage.totalRequests,
                totalCostVND: usage.totalCostVND,
                period: period,
                startDate: usage.startDate,
                endDate: usage.endDate,
                remainingQuota: usage.remainingQuota
            }
        });
    } catch (error) {
        console.error('TTS usage retrieval error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve TTS usage.'
        });
    }
});

/**
 * @route GET /api/tts/pricing
 * @desc Get current TTS pricing information
 * @access Public
 */
router.get('/pricing', async (req, res) => {
    try {
        const pricing = await getTTSPricing();
        
        res.json({
            success: true,
            pricing: {
                costPerCharacterVND: pricing.costPerCharacterVND,
                costPer1000CharactersVND: pricing.costPer1000CharactersVND,
                freeQuotaPerMonth: pricing.freeQuotaPerMonth,
                supportedVoices: pricing.supportedVoices,
                qualityLevel: pricing.qualityLevel, // Changed from qualityLevels to qualityLevel
                lastUpdated: pricing.lastUpdated
            }
        });
    } catch (error) {
        console.error('TTS pricing retrieval error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve TTS pricing.'
        });
    }
});

/**
 * @route GET /api/tts/test
 * @desc Test TTS system with a simple phrase
 * @access Private
 */
router.get('/test', auth, async (req, res) => {
    try {
        const testText = 'Xin chào, đây là bài kiểm tra Text-to-Speech.';
        
        console.log('TTS test request from user:', req.user.id);
        
        const result = await generateTTS({
            text: testText,
            languageCode: 'vi-VN',
            voiceName: 'nu', // Use simplified voice name
            audioConfig: {
                audioEncoding: 'MP3',
                speakingRate: 1.0,
                pitch: 0.0,
                volumeGainDb: 0.0
            },
            userId: req.user.id,
            characterCount: testText.length
        });

        res.json({
            success: true,
            message: 'TTS test successful',
            testText,
            result
        });
    } catch (error) {
        console.error('TTS test error:', error);
        res.status(500).json({
            success: false,
            message: 'TTS test failed',
            error: error.message
        });
    }
});

/**
 * @route GET /api/tts/voices
 * @desc Get available Vietnamese voices
 * @access Public
 */
router.get('/voices', async (req, res) => {
    try {
        const voices = [
            {
                value: 'nu',
                label: 'Nữ',
                gender: 'FEMALE',
                description: 'Giọng nữ tiếng Việt (Standard quality)',
                googleVoice: 'vi-VN-Standard-A',
                sampleRate: 24000
            },
            {
                value: 'nam',
                label: 'Nam',
                gender: 'MALE',
                description: 'Giọng nam tiếng Việt (Standard quality)',
                googleVoice: 'vi-VN-Standard-D',
                sampleRate: 24000
            }
        ];

        res.json({
            success: true,
            voices,
            recommendedVoice: 'nu',
            totalVoices: voices.length,
            quality: 'Standard'
        });
    } catch (error) {
        console.error('TTS voices retrieval error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve available voices.'
        });
    }
});

export default router;
