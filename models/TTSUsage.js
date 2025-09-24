import mongoose from 'mongoose';

const TTSUsageSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    chapterId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Chapter',
        required: false // Not all TTS usage is chapter-related
    },
    characterCount: {
        type: Number,
        required: true,
        min: 1
    },
    text: {
        type: String,
        required: true,
        maxLength: 100000
    },
    textHash: {
        type: String,
        required: true,
        index: true // For detecting duplicate content
    },
    voiceName: {
        type: String,
        required: true,
        enum: [
            'vi-VN-Standard-A', 'vi-VN-Standard-B', 'vi-VN-Standard-C', 'vi-VN-Standard-D',
            'vi-VN-Wavenet-A', 'vi-VN-Wavenet-B', 'vi-VN-Wavenet-C', 'vi-VN-Wavenet-D',
            'vi-VN-Neural2-A', 'vi-VN-Neural2-D'
        ]
    },
    languageCode: {
        type: String,
        required: true,
        default: 'vi-VN'
    },
    audioConfig: {
        speakingRate: {
            type: Number,
            default: 1.0,
            min: 0.25,
            max: 4.0
        },
        pitch: {
            type: Number,
            default: 0.0,
            min: -20.0,
            max: 20.0
        },
        volumeGainDb: {
            type: Number,
            default: 0.0,
            min: -96.0,
            max: 16.0
        }
    },
    audioUrl: {
        type: String,
        required: true
    },
    audioFileSize: {
        type: Number, // File size in bytes
        required: false
    },
    audioDuration: {
        type: Number, // Duration in seconds
        required: false
    },
    costVND: {
        type: Number,
        required: true,
        min: 0
    },
    cacheHit: {
        type: Boolean,
        default: false
    },
    processingTimeMs: {
        type: Number, // Time taken to generate TTS
        required: false
    },
    userAgent: {
        type: String,
        required: false
    },
    ipAddress: {
        type: String,
        required: false
    },
    status: {
        type: String,
        enum: ['pending', 'completed', 'failed', 'cached'],
        default: 'pending'
    },
    errorMessage: {
        type: String,
        required: false
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true,
    collection: 'ttsusage'
});

// Compound indexes for efficient queries
TTSUsageSchema.index({ userId: 1, createdAt: -1 });
TTSUsageSchema.index({ userId: 1, chapterId: 1 });
TTSUsageSchema.index({ textHash: 1, voiceName: 1 }); // For cache lookups
TTSUsageSchema.index({ createdAt: 1 }); // For cleanup/archival
TTSUsageSchema.index({ status: 1, createdAt: -1 });

// Virtual for cost in USD
TTSUsageSchema.virtual('costUSD').get(function() {
    return this.costVND / 24500; // Approximate conversion
});

// Static method to get user usage statistics
TTSUsageSchema.statics.getUserUsage = async function(userId, startDate, endDate) {
    const pipeline = [
        {
            $match: {
                userId: new mongoose.Types.ObjectId(userId),
                createdAt: {
                    $gte: startDate,
                    $lte: endDate
                },
                status: 'completed'
            }
        },
        {
            $group: {
                _id: null,
                totalCharacters: { $sum: '$characterCount' },
                totalRequests: { $sum: 1 },
                totalCostVND: { $sum: '$costVND' },
                cacheHits: {
                    $sum: {
                        $cond: ['$cacheHit', 1, 0]
                    }
                },
                avgProcessingTime: { $avg: '$processingTimeMs' }
            }
        }
    ];

    const result = await this.aggregate(pipeline);
    return result[0] || {
        totalCharacters: 0,
        totalRequests: 0,
        totalCostVND: 0,
        cacheHits: 0,
        avgProcessingTime: 0
    };
};

// Static method to get most used voices
TTSUsageSchema.statics.getVoiceUsageStats = async function(userId, days = 30) {
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    const pipeline = [
        {
            $match: {
                userId: new mongoose.Types.ObjectId(userId),
                createdAt: { $gte: startDate },
                status: 'completed'
            }
        },
        {
            $group: {
                _id: '$voiceName',
                count: { $sum: 1 },
                totalCharacters: { $sum: '$characterCount' }
            }
        },
        {
            $sort: { count: -1 }
        }
    ];

    return await this.aggregate(pipeline);
};

// Pre-save middleware to update textHash and updatedAt
TTSUsageSchema.pre('save', function(next) {
    if (this.isModified('text')) {
        const crypto = require('crypto');
        this.textHash = crypto.createHash('sha256').update(this.text).digest('hex');
    }
    this.updatedAt = new Date();
    next();
});

// Method to check if similar content exists in cache
TTSUsageSchema.statics.findCachedContent = async function(textHash, voiceName, audioConfig) {
    const cached = await this.findOne({
        textHash,
        voiceName,
        'audioConfig.speakingRate': audioConfig.speakingRate || 1.0,
        'audioConfig.pitch': audioConfig.pitch || 0.0,
        'audioConfig.volumeGainDb': audioConfig.volumeGainDb || 0.0,
        status: 'completed',
        createdAt: {
            $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Only cache for 7 days
        }
    }).sort({ createdAt: -1 });

    return cached;
};

// Static method to cleanup old records
TTSUsageSchema.statics.cleanupOldRecords = async function(daysToKeep = 90) {
    const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
    
    const result = await this.deleteMany({
        createdAt: { $lt: cutoffDate },
        status: { $in: ['completed', 'failed'] }
    });
    
    console.log(`Cleaned up ${result.deletedCount} old TTS usage records`);
    return result.deletedCount;
};

const TTSUsage = mongoose.model('TTSUsage', TTSUsageSchema);

export default TTSUsage;
