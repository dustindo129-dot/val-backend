import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

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
    cacheDirectory: path.join(process.cwd(), 'public', 'tts-cache'), // Local fallback only
    maxCacheSizeMB: 1000, // 1GB cache limit
    cacheExpiryHours: 168 // 7 days
};

// Bunny CDN Configuration
const BUNNY_CONFIG = {
    storageApiUrl: process.env.BUNNY_STORAGE_API_URL || 'https://storage.bunnycdn.com',
    storageZone: process.env.BUNNY_STORAGE_ZONE || 'valvrareteam',
    apiKey: process.env.BUNNY_API_KEY,
    cdnUrl: process.env.BUNNY_CDN_URL || 'https://valvrareteam.b-cdn.net',
    ttsFolder: 'tts-audio' // Dedicated folder for TTS files
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

// Upload audio buffer to Bunny CDN
const uploadToBunnycdn = async (audioBuffer, filename) => {
    if (!BUNNY_CONFIG.apiKey) {
        throw new Error('Bunny CDN API key not configured');
    }

    try {
        const storagePath = `/${BUNNY_CONFIG.ttsFolder}/${filename}`;
        const bunnyStorageUrl = `${BUNNY_CONFIG.storageApiUrl}/${BUNNY_CONFIG.storageZone}${storagePath}`;
        
        console.log(`Uploading TTS audio to Bunny CDN: ${storagePath}`);
        
        // Upload with retry logic
        let lastError = null;
        const maxRetries = 3;
        
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const response = await axios.put(bunnyStorageUrl, audioBuffer, {
                    headers: {
                        'AccessKey': BUNNY_CONFIG.apiKey,
                        'Content-Type': 'audio/mpeg',
                        'Content-Length': audioBuffer.length
                    },
                    timeout: 30000, // 30 second timeout
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity
                });
                
                console.log(`✅ TTS audio uploaded successfully (${audioBuffer.length} bytes)`);
                
                // Return the CDN URL
                return `${BUNNY_CONFIG.cdnUrl}${storagePath}`;
                
            } catch (error) {
                console.error(`Upload attempt ${attempt + 1}/${maxRetries} failed:`, error.message);
                lastError = error;
                
                if (attempt < maxRetries - 1) {
                    // Wait before retry with exponential backoff
                    const delay = 1000 * Math.pow(2, attempt);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        
        throw new Error(`Failed to upload to Bunny CDN after ${maxRetries} attempts: ${lastError.message}`);
        
    } catch (error) {
        console.error('Error uploading TTS audio to Bunny CDN:', error);
        throw error;
    }
};

// Check if audio file exists on Bunny CDN
const checkBunnyCdnCache = async (filename) => {
    try {
        const storagePath = `/${BUNNY_CONFIG.ttsFolder}/${filename}`;
        const cdnUrl = `${BUNNY_CONFIG.cdnUrl}${storagePath}`;
        
        // Make a HEAD request to the CDN URL (public, no auth required, faster)
        const response = await axios.head(cdnUrl, {
            timeout: 3000, // Shorter timeout since CDN should respond quickly
            validateStatus: (status) => status < 500 // Don't throw on 404, only on server errors
        });
        
        return response.status === 200;
    } catch (error) {
        // File doesn't exist or network error - treat as cache miss
        if (error.response && error.response.status === 404) {
            return false; // File doesn't exist
        }
        // For other errors (timeout, network issues), log but don't fail
        console.warn(`Cache check warning for ${filename}:`, error.message);
        return false;
    }
};

// Clean old cache files (local fallback only)
const cleanCache = () => {
    try {
        if (!fs.existsSync(TTS_CONFIG.cacheDirectory)) {
            return;
        }
        
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
        console.error('Error cleaning local TTS cache:', error);
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

        // Use service account JSON from environment variable
        if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
            const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
            clientConfig.credentials = credentials;
        }
        
        ttsClient = new TextToSpeechClient(clientConfig);
        
        // Test the connection by listing voices
        await ttsClient.listVoices({ languageCode: 'vi-VN' });
        console.log('Google Cloud TTS client initialized successfully');
        return true;
    } catch (error) {
        console.error('Failed to initialize Google Cloud TTS client:', error.message);
        console.log('TTS service will be unavailable until credentials are configured');
        return false;
    }
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
        
        // Check if cached version exists on Bunny CDN
        const isCached = await checkBunnyCdnCache(filename);
        if (isCached) {
            const storagePath = `/${BUNNY_CONFIG.ttsFolder}/${filename}`;
            const bunnyUrl = `${BUNNY_CONFIG.cdnUrl}${storagePath}`;
            console.log(`✅ TTS cache hit on Bunny CDN: ${filename}`);
            
            const cacheResult = {
                audioUrl: bunnyUrl,
                characterCount,
                estimatedCostVND: 0, // No cost for cached content
                voiceUsed: voiceName,
                cacheHit: true,
                duration: Math.ceil(characterCount / 10)
            };
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
                    throw new Error(`Google Cloud TTS failed: ${googleError.message}`);
                }
        } else {
            // TTS client not initialized - fail the request
            throw new Error('Google Cloud TTS service is not properly configured. Please check credentials and try again.');
        }

        // Upload audio to Bunny CDN
        let audioUrl;
        try {
            audioUrl = await uploadToBunnycdn(ttsResponse.audioContent, filename);
            console.log(`✅ TTS audio uploaded to Bunny CDN: ${filename}`);
        } catch (bunnyError) {
            console.error('Failed to upload to Bunny CDN, falling back to local storage:', bunnyError.message);
            
            // Fallback to local storage if Bunny upload fails
            ensureCacheDirectory();
            const cacheFilePath = path.join(TTS_CONFIG.cacheDirectory, filename);
            fs.writeFileSync(cacheFilePath, ttsResponse.audioContent);
            audioUrl = `${process.env.BACKEND_URL || 'http://localhost:5000'}/tts-cache/${filename}`;
        }
        
        // Track usage
        trackTTSUsage(userId, characterCount);
        
        // Calculate cost
        const estimatedCostVND = calculateCostVND(characterCount);
        
        // Clean old local cache files periodically (fallback cleanup)
        if (Math.random() < 0.1) { // 10% chance
            cleanCache();
        }

        const result = {
            audioUrl,
            characterCount: ttsResponse.characterCount,
            estimatedCostVND,
            voiceUsed: ttsResponse.voiceUsed,
            duration: ttsResponse.duration,
            cacheHit: false
        };
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
