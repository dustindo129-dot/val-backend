import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

// Google Cloud TTS client will be initialized later
let TextToSpeechClient = null;

// Google Cloud TTS client (will be initialized when credentials are added)
let ttsClient = null;

// TTS Usage tracking (in-memory for now, should be moved to database)
const usageCache = new Map();

// Configuration
const TTS_CONFIG = {
    costPerCharacterUSD: 0.000004, // $4 per 1M characters
    usdToVndRate: 24500, // Approximate exchange rate
    freeQuotaPerMonth: 1000000, // 1M characters free per month
    cacheDirectory: path.join(process.cwd(), 'public', 'tts-cache'),
    maxCacheSizeMB: 1000, // 1GB cache limit
    cacheExpiryHours: 168 // 7 days
};

// Calculate cost in VND
const calculateCostVND = (characterCount) => {
    const costUSD = characterCount * TTS_CONFIG.costPerCharacterUSD;
    return Math.ceil(costUSD * TTS_CONFIG.usdToVndRate);
};

// Generate cache key for TTS request
const generateCacheKey = (text, voiceName, audioConfig) => {
    const content = JSON.stringify({ text, voiceName, audioConfig });
    return crypto.createHash('sha256').update(content).digest('hex');
};

// Ensure cache directory exists
const ensureCacheDirectory = () => {
    if (!fs.existsSync(TTS_CONFIG.cacheDirectory)) {
        fs.mkdirSync(TTS_CONFIG.cacheDirectory, { recursive: true });
    }
};

// Clean old cache files
const cleanCache = () => {
    try {
        const now = Date.now();
        const maxAge = TTS_CONFIG.cacheExpiryHours * 60 * 60 * 1000;
        
        const files = fs.readdirSync(TTS_CONFIG.cacheDirectory);
        files.forEach(file => {
            const filePath = path.join(TTS_CONFIG.cacheDirectory, file);
            const stats = fs.statSync(filePath);
            
            if (now - stats.mtime.getTime() > maxAge) {
                fs.unlinkSync(filePath);
            }
        });
    } catch (error) {
        console.error('Error cleaning TTS cache:', error);
    }
};


// Initialize Google Cloud TTS client
const initializeTTSClient = async () => {
    try {
        // Import Google Cloud TTS
        const { TextToSpeechClient: TtsClient } = await import('@google-cloud/text-to-speech');
        TextToSpeechClient = TtsClient;
        
        let clientConfig = {
            projectId: process.env.GOOGLE_CLOUD_PROJECT_ID || 'tts-valvrareteam',
            quotaProjectId: process.env.GOOGLE_CLOUD_PROJECT_ID || 'tts-valvrareteam',
        };

        // Priority 1: Use service account JSON from environment variable (recommended for DigitalOcean)
        if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
            try {
                const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
                clientConfig.credentials = credentials;
                console.log('🔐 Using credentials from GOOGLE_APPLICATION_CREDENTIALS_JSON');
                console.log('📧 Service account email:', credentials.client_email);
            } catch (parseError) {
                console.error('❌ Failed to parse GOOGLE_APPLICATION_CREDENTIALS_JSON:', parseError.message);
                console.error('Make sure the JSON is properly formatted and escaped');
                throw parseError;
            }
        }
        // Priority 2: Use file path (if GOOGLE_APPLICATION_CREDENTIALS is set)
        else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
            console.log('🔐 Using credentials from file:', process.env.GOOGLE_APPLICATION_CREDENTIALS);
            // The client library will automatically use this file path
        }
        // Priority 3: Use individual credential fields (alternative method)
        else if (process.env.GOOGLE_CLOUD_PRIVATE_KEY && process.env.GOOGLE_CLOUD_CLIENT_EMAIL) {
            clientConfig.credentials = {
                client_email: process.env.GOOGLE_CLOUD_CLIENT_EMAIL,
                private_key: process.env.GOOGLE_CLOUD_PRIVATE_KEY.replace(/\\n/g, '\n'),
            };
            console.log('🔐 Using credentials from separate env variables');
            console.log('📧 Service account email:', process.env.GOOGLE_CLOUD_CLIENT_EMAIL);
        }
        else {
            console.warn('⚠️  No Google Cloud credentials found. TTS will use mock responses.');
            console.warn('⚠️  Set one of the following:');
            console.warn('    - GOOGLE_APPLICATION_CREDENTIALS_JSON (full JSON as string)');
            console.warn('    - GOOGLE_APPLICATION_CREDENTIALS (path to JSON file)');
            console.warn('    - GOOGLE_CLOUD_CLIENT_EMAIL + GOOGLE_CLOUD_PRIVATE_KEY');
        }
        
        ttsClient = new TextToSpeechClient(clientConfig);
        
        // Test the connection by listing voices
        try {
            const [result] = await ttsClient.listVoices({ languageCode: 'vi-VN' });
            console.log('✅ Google Cloud TTS client initialized successfully');
            console.log(`✅ Available Vietnamese voices: ${result.voices.length}`);
            return true;
        } catch (testError) {
            console.error('❌ TTS client created but failed to list voices:', testError.message);
            console.error('This usually means credentials are invalid or API is not enabled');
            throw testError;
        }
    } catch (error) {
        console.error('❌ Failed to initialize Google Cloud TTS client:', error.message);
        if (error.code === 7) {
            console.error('❌ Permission denied - check if Cloud Text-to-Speech API is enabled');
        }
        console.log('⚠️  TTS will use mock responses until credentials are configured');
        return false;
    }
};

// Mock TTS generation for development (replace with real Google Cloud TTS)
const generateMockTTS = async (request) => {
    const { text, voiceName, audioConfig } = request;
    const characterCount = text.length;
    
    // Simulate processing time
    await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
    
    // Create a proper minimal MP3 file that browsers can play
    // This is a valid MP3 file header with a very short silent audio segment
    const mockAudioData = Buffer.from([
        // MP3 Frame Header (FFE0 = MPEG-1, Layer III, no protection, 128kbps, 44.1kHz, stereo)
        0xFF, 0xE0, 0x18, 0xC4,
        // MP3 frame data (minimal silent frame)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00
    ]);
    
    console.log(`Generated mock TTS audio: ${characterCount} characters, ${mockAudioData.length} bytes`);
    
    return {
        audioContent: mockAudioData,
        characterCount,
        voiceUsed: voiceName,
        duration: Math.max(1, Math.ceil(characterCount / 100)) // More realistic: 100 chars per second
    };
};

// Map simplified voice names to Google Cloud TTS voice IDs
const VOICE_MAP = {
    'nu': 'vi-VN-Standard-A',
    'nam': 'vi-VN-Standard-D',
    // Legacy support for old voice names
    'vi-VN-Standard-A': 'vi-VN-Standard-A',
    'vi-VN-Standard-D': 'vi-VN-Standard-D'
};

// Map Google voice IDs to simplified names for cache filenames
const getSimplifiedVoiceName = (voiceName) => {
    if (voiceName === 'nu' || voiceName === 'nam') return voiceName;
    if (voiceName === 'vi-VN-Standard-A') return 'nu';
    if (voiceName === 'vi-VN-Standard-D') return 'nam';
    return 'nu'; // Default to female voice
};

// Generate TTS audio using Google Cloud TTS
export const generateTTS = async (request) => {

    const {
        text,
        languageCode = 'vi-VN',
        voiceName: requestedVoice = 'nu',
        audioConfig = {},
        userId,
        characterCount,
        chapterInfo = {}
    } = request;
    
    // Map simplified voice name to Google Cloud TTS voice ID
    const voiceName = VOICE_MAP[requestedVoice] || VOICE_MAP['nu'];

    try {
        ensureCacheDirectory();
        
        // Generate meaningful filename with full info
        const { novelSlug, novelTitle, moduleTitle, chapterTitle, chapterId, voiceName: voiceNameFromInfo } = chapterInfo;
        
        // Helper function to clean text for filename
        const cleanForFilename = (text, maxLength = 50) => {
            if (!text) return '';
            return text
                .toLowerCase()
                .normalize('NFD') // Decompose Vietnamese characters
                .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
                .replace(/đ/g, 'd') // Handle Vietnamese đ specifically
                .replace(/[^a-z0-9\s]/g, '') // Keep only letters, numbers, spaces
                .replace(/\s+/g, '-') // Replace spaces with hyphens
                .replace(/-+/g, '-') // Replace multiple hyphens with single
                .replace(/^-|-$/g, '') // Remove leading/trailing hyphens
                .substring(0, maxLength);
        };
        
        // Extract voice identifier from voice name (simplified to just "nu" or "nam")
        const extractVoiceId = (voiceName) => {
            if (!voiceName) return 'nu'; // Default to female
            // Use the simplified voice name helper
            return getSimplifiedVoiceName(voiceName);
        };

        let filename;
        if (chapterId || moduleTitle || chapterTitle || novelTitle) {
            // Use novel title if available, otherwise fall back to slug
            const novelPart = novelTitle ? cleanForFilename(novelTitle, 50) : 
                              (novelSlug ? novelSlug.substring(0, 50) : 'novel');
            
            const modulePart = moduleTitle ? cleanForFilename(moduleTitle, 20) : 'module';
            const chapterPart = chapterTitle ? cleanForFilename(chapterTitle, 30) : 'chapter';
            const voicePart = extractVoiceId(voiceNameFromInfo || voiceName);
            const hashPart = generateCacheKey(text, voiceName, audioConfig).substring(0, 8);
            
            filename = `${novelPart}-${modulePart}-${chapterPart}-${voicePart}-${hashPart}.mp3`.replace(/--+/g, '-');
        } else {
            // Fallback to hash-based filename only if no info available
            const cacheKey = generateCacheKey(text, voiceName, audioConfig);
            filename = `${cacheKey}.mp3`;
        }
        
        const cacheFilePath = path.join(TTS_CONFIG.cacheDirectory, filename);
        
        // Check if cached version exists
        if (fs.existsSync(cacheFilePath)) {
            const cacheResult = {
                audioUrl: `${process.env.BACKEND_URL}/tts-cache/${filename}`,
                characterCount,
                estimatedCostVND: 0, // No cost for cached content
                voiceUsed: voiceName,
                cacheHit: true,
                duration: Math.ceil(characterCount / 10)
            };
            // Cache hit - return cached audio URL
            return cacheResult;
        }

        // Prepare TTS request
        const ttsRequest = {
            input: { text },
            voice: {
                languageCode,
                name: voiceName
            },
            audioConfig: {
                audioEncoding: 'MP3',
                speakingRate: audioConfig.speakingRate || 1.0,
                pitch: audioConfig.pitch || 0.0,
                volumeGainDb: audioConfig.volumeGainDb || 0.0,
                sampleRateHertz: 24000
            }
        };

        let ttsResponse;
        
        if (ttsClient) {
            // Use real Google Cloud TTS
            // Check if text exceeds Google Cloud TTS limit (5000 bytes)
            const textBytes = Buffer.byteLength(text, 'utf8');
            
            try {
                if (textBytes > 5000) {
                    // Text exceeds limit, chunk into smaller pieces
                    
                    // Split text into chunks that fit within the limit
                    const chunks = [];
                    const maxChunkSize = 4500; // Leave some buffer
                    
                    // Split by sentences to maintain natural speech flow
                    const sentences = text.split(/[.!?]+/).filter(s => s.trim());
                    let currentChunk = '';
                    
                    for (const sentence of sentences) {
                        const potentialChunk = currentChunk + sentence + '.';
                        if (Buffer.byteLength(potentialChunk, 'utf8') > maxChunkSize && currentChunk) {
                            chunks.push(currentChunk.trim());
                            currentChunk = sentence + '.';
                        } else {
                            currentChunk = potentialChunk;
                        }
                    }
                    if (currentChunk.trim()) {
                        chunks.push(currentChunk.trim());
                    }
                    
                    // Generate TTS for each chunk
                    const audioChunks = [];
                    for (let i = 0; i < chunks.length; i++) {
                        const chunkRequest = {
                            ...ttsRequest,
                            input: { text: chunks[i] }
                        };
                        
                        const [response] = await ttsClient.synthesizeSpeech(chunkRequest);
                        audioChunks.push(response.audioContent);
                    }
                    
                    // Combine audio chunks (simple concatenation for MP3)
                    const combinedAudio = Buffer.concat(audioChunks);
                    
                    ttsResponse = {
                        audioContent: combinedAudio,
                        characterCount,
                        voiceUsed: voiceName,
                        duration: Math.ceil(characterCount / 10),
                        isChunked: true,
                        chunkCount: chunks.length
                    };
                } else {
                    // Text is within limit, proceed normally
                    const [response] = await ttsClient.synthesizeSpeech(ttsRequest);
                    
                    ttsResponse = {
                        audioContent: response.audioContent,
                        characterCount,
                        voiceUsed: voiceName,
                        duration: Math.ceil(characterCount / 10)
                    };
                }
                
            } catch (googleError) {
                console.error('Google Cloud TTS API error:', googleError);
                ttsResponse = await generateMockTTS({ text, voiceName, audioConfig });
            }
        } else {
            // Use mock TTS for development
            ttsResponse = await generateMockTTS({ text, voiceName, audioConfig });
        }

        // Save audio to cache
        fs.writeFileSync(cacheFilePath, ttsResponse.audioContent);
        
        // Track usage
        trackTTSUsage(userId, characterCount);
        
        // Calculate cost
        const estimatedCostVND = calculateCostVND(characterCount);
        
        // Clean old cache files periodically
        if (Math.random() < 0.1) { // 10% chance
            cleanCache();
        }

        const result = {
            audioUrl: `${process.env.BACKEND_URL || 'http://localhost:5000'}/tts-cache/${filename}`,
            characterCount: ttsResponse.characterCount,
            estimatedCostVND,
            voiceUsed: ttsResponse.voiceUsed,
            duration: ttsResponse.duration,
            cacheHit: false
        };
        // Return generated TTS result
        return result;

    } catch (error) {
        console.error('❌ TTS service error:', error.message);
        console.error('❌ TTS service stack:', error.stack);
        throw new Error(`TTS generation failed: ${error.message}`);
    }
};

// Track TTS usage for a user
const trackTTSUsage = (userId, characterCount) => {
    const today = new Date().toISOString().split('T')[0];
    const userKey = `${userId}-${today}`;
    
    if (!usageCache.has(userKey)) {
        usageCache.set(userKey, {
            userId,
            date: today,
            totalCharacters: 0,
            totalRequests: 0,
            totalCostVND: 0
        });
    }
    
    const usage = usageCache.get(userKey);
    usage.totalCharacters += characterCount;
    usage.totalRequests += 1;
    usage.totalCostVND += calculateCostVND(characterCount);
    
    usageCache.set(userKey, usage);
    
    // TODO: Save to database for persistence
    // Track TTS usage in cache
};

// Get TTS usage for a user
export const getTTSUsage = async (userId, period = 'month') => {
    try {
        const now = new Date();
        let startDate, endDate;
        
        switch (period) {
            case 'day':
                startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
                break;
            case 'week':
                const dayOfWeek = now.getDay();
                startDate = new Date(now.getTime() - dayOfWeek * 24 * 60 * 60 * 1000);
                startDate.setHours(0, 0, 0, 0);
                endDate = new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);
                break;
            case 'month':
            default:
                startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
                break;
        }
        
        // Calculate usage from cache (TODO: query database)
        let totalCharacters = 0;
        let totalRequests = 0;
        let totalCostVND = 0;
        
        for (const [key, usage] of usageCache.entries()) {
            if (usage.userId === userId) {
                const usageDate = new Date(usage.date);
                if (usageDate >= startDate && usageDate < endDate) {
                    totalCharacters += usage.totalCharacters;
                    totalRequests += usage.totalRequests;
                    totalCostVND += usage.totalCostVND;
                }
            }
        }
        
        const remainingQuota = Math.max(0, TTS_CONFIG.freeQuotaPerMonth - totalCharacters);
        
        return {
            totalCharacters,
            totalRequests,
            totalCostVND,
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            remainingQuota
        };
    } catch (error) {
        console.error('Error getting TTS usage:', error);
        throw new Error('Failed to retrieve TTS usage');
    }
};

// Get TTS pricing information
export const getTTSPricing = async () => {
    return {
        costPerCharacterVND: TTS_CONFIG.costPerCharacterUSD * TTS_CONFIG.usdToVndRate,
        costPer1000CharactersVND: calculateCostVND(1000),
        freeQuotaPerMonth: TTS_CONFIG.freeQuotaPerMonth,
        supportedVoices: [
            { value: 'nu', label: 'Nữ', googleVoice: 'vi-VN-Standard-A' },
            { value: 'nam', label: 'Nam', googleVoice: 'vi-VN-Standard-D' }
        ],
        qualityLevel: 'Standard quality voices',
        lastUpdated: new Date().toISOString()
    };
};

// Initialize TTS service function
export const initializeTTSService = async () => {
    await initializeTTSClient();
    ensureCacheDirectory();
    
    // Clean cache on startup
    cleanCache();
    
    // Set up periodic cache cleaning (every 6 hours)
    setInterval(cleanCache, 6 * 60 * 60 * 1000);
};

// Initialize the service (keep for backward compatibility)
(async () => {
    await initializeTTSService();
})();

export default {
    generateTTS,
    getTTSUsage,
    getTTSPricing
};
