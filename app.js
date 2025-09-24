// Load environment variables from .env file
import dotenv from 'dotenv';
dotenv.config();

// Import route handlers
import novelRoutes from "./routes/novels.js";
import userRoutes from "./routes/users.js";
import authRoutes from "./routes/auth.js";
import commentRoutes from "./routes/comments.js";
import moduleRoutes from "./routes/modules.js";
import express from "express";
import cors from "cors";
import donationRoutes from './routes/donation.js';
import reportRoutes from './routes/reports.js';
import uploadRoutes from './routes/uploadRoutes.js';
import requestRoutes from './routes/requests.js';
import contributionRoutes from './routes/contributions.js';
import topupRoutes from './routes/topup.js';
import topupAdminRoutes from './routes/topupAdmin.js';
import chapterRoutes from './routes/chapters.js';
import userChapterInteractionRoutes from './routes/userChapterInteractions.js';
import userTransactionRoutes from './routes/userTransaction.js';
import novelTransactionRoutes from './routes/novelTransactions.js';
import giftRoutes from './routes/gifts.js';
import ttsRoutes from './routes/tts-minimal.js';
import ttsSimpleRoutes from './routes/tts-simple.js';
import ttsFullRoutes from './routes/tts.js';
import redisClient, { getRedisStatus } from './utils/redisClient.js';
import { auth } from './middleware/auth.js';
import admin from './middleware/admin.js';
import { preWarmAdminCache } from './utils/userCache.js';

// Initialize Express application
const app = express();

// Add global request logging
app.use((req, res, next) => {
    if (req.url.startsWith('/api/tts')) {
        console.log('🌐 GLOBAL REQUEST LOG:', {
            timestamp: new Date().toISOString(),
            method: req.method,
            url: req.url,
            origin: req.headers.origin,
            contentType: req.headers['content-type']
        });
    }
    next();
});

// Initialize caches and Redis connection
(async () => {
  try {
    // Pre-warm user cache with admin user for better performance
    await preWarmAdminCache();
    
    // Check Redis connection
    if (!redisClient.isOpen) {
      await redisClient.connect();
    }
    console.log('Redis connection established successfully');
  } catch (err) {
    console.warn('Redis connection failed, continuing without caching:', err.message);
    console.log('Application will function without Redis caching');
  }
})();

// Enable CORS for cross-origin requests
app.use(
  cors({
    origin: [
      "https://valvrareteam.netlify.app", 
      "https://valvrareteam.net", 
      "http://localhost:5173",
      "https://val-bh6h9.ondigitalocean.app" // Add backend domain for SSE
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Parse JSON request bodies with a 10MB size limit
// This is needed for handling large image uploads
app.use(express.json({ limit: "10mb" }));

// Parse URL-encoded request bodies with a 10MB size limit
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Serve TTS cache files statically with proper CORS headers
app.use('/tts-cache', (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
}, express.static('public/tts-cache', {
    maxAge: '7d', // Cache for 7 days
    etag: true,
    lastModified: true,
    setHeaders: (res, path) => {
        res.set('Content-Type', 'audio/mpeg');
    }
}));

// Redis status endpoint (admin only)
app.get('/api/system/redis-status', [auth, admin], async (req, res) => {
  try {
    const status = await getRedisStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      message: error.message 
    });
  }
});

// Register API routes
// Each route is prefixed with /api for versioning and organization
app.use("/api/auth", authRoutes); // Authentication routes (login, register, etc.)
app.use("/api/novels", novelRoutes); // Novel management routes
app.use("/api/comments", commentRoutes); // Comment system routes
app.use("/api/users", userRoutes); // User profile and management routes
app.use("/api/modules", moduleRoutes); // Module management routes (mounted at /api/modules)
app.use('/api/donation', donationRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/upload', uploadRoutes); // File upload routes for bunny.net
app.use('/api/requests', requestRoutes); // Request system routes
app.use('/api/contributions', contributionRoutes); // Contribution routes
app.use('/api/topup', topupRoutes); // Top-up transaction routes
app.use('/api/topup-admin', topupAdminRoutes); // Top-up admin routes
app.use('/api/chapters', chapterRoutes); // Chapter routes
app.use('/api/userchapterinteractions', userChapterInteractionRoutes); // User chapter interactions
app.use('/api/transactions', userTransactionRoutes); // User transaction ledger routes
app.use('/api/novel-transactions', novelTransactionRoutes); // Novel transaction ledger routes
app.use('/api/gifts', giftRoutes); // Gift system routes
app.use('/api/tts', ttsRoutes); // Text-to-Speech routes (minimal)
app.use('/api/tts-simple', ttsSimpleRoutes); // Simple TTS routes (mock generation)
app.use('/api/tts-full', ttsFullRoutes); // Full TTS routes (Google Cloud integration)
