// Import required dependencies
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';

// Import route handlers
import authRoutes from './routes/auth.js';
import novelRoutes from './routes/novels.js';
import commentRoutes from './routes/comments.js';
import userRoutes from './routes/users.js';
import chaptersRouter from './routes/chapters.js';
import moduleRoutes from './routes/modules.js';

// Load environment variables from .env file
dotenv.config();

// Configure ES modules __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express application
const app = express();
const port = process.env.PORT || 5000;

// Configure body parsers with large limits BEFORE other middleware
app.use(express.json({
  limit: '50mb',
  parameterLimit: 100000,
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.use(express.urlencoded({
  limit: '50mb',
  extended: true,
  parameterLimit: 100000
}));

// Add request size logging middleware
app.use((req, res, next) => {
  if (req.headers['content-length']) {
    const sizeMB = (parseInt(req.headers['content-length']) / (1024 * 1024)).toFixed(2);
    console.log(`Request size: ${sizeMB} MB`);
    console.log('Content-Type:', req.headers['content-type']);
  }
  next();
});

// Configure CORS
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.FRONTEND_URL 
    : ['http://localhost:5173', 'http://127.0.0.1:5173'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 600 // Cache preflight requests for 10 minutes
};

app.use(cors(corsOptions));

// Security headers middleware
app.use((req, res, next) => {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');
  // Enable XSS protection
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Strict transport security
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Middleware setup
app.use(cookieParser());  // Parse Cookie header and populate req.cookies

// Serve static files from the public/images directory
// This is used for any local image storage (if needed)
app.use('/images', express.static(path.join(__dirname, 'public', 'images')));

// Register API routes
app.use('/api/auth', authRoutes);      // Authentication endpoints
app.use('/api/novels', novelRoutes);   // Novel management endpoints
app.use('/api/comments', commentRoutes); // Comment system endpoints
app.use('/api/users', userRoutes);      // User management endpoints
app.use('/api/chapters', chaptersRouter); // Chapter management endpoints
app.use('/api/novels', moduleRoutes);   // Module management endpoints

// Error handling middleware
app.use((err, req, res, next) => {
  // Log error details
  console.error('Error details:', err);
  console.error('Request headers:', req.headers);
  
  // Handle specific error types
  if (err.type === 'entity.too.large' || err.message?.includes('request entity too large')) {
    return res.status(413).json({
      message: 'Content too large. Maximum size is 50MB.',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
  
  if (err.type === 'entity.parse.failed' || err.message === 'Invalid JSON') {
    return res.status(400).json({
      message: 'Invalid JSON format in request body',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }

  // Handle JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      message: 'Invalid token',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      message: 'Token expired',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }

  // Handle MongoDB errors
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      message: 'Validation Error',
      errors: Object.values(err.errors).map(e => e.message)
    });
  }

  if (err.name === 'CastError') {
    return res.status(400).json({
      message: 'Invalid ID format',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }

  // Handle duplicate key errors
  if (err.code === 11000) {
    return res.status(409).json({
      message: 'Duplicate key error',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
  
  // Default error response
  res.status(500).json({
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Connect to MongoDB database
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
  })
  .catch((error) => {
    console.error('MongoDB connection error:', error);
    process.exit(1);  // Exit if database connection fails
  });

// Enable MongoDB debug mode in development
// This will log all database operations to the console
if (process.env.NODE_ENV === 'development') {
  mongoose.set('debug', { 
    color: true,  // Enable colored output
    shell: true   // Use shell syntax for queries
  });
}

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log('Frontend URL:', process.env.FRONTEND_URL);
  console.log('Environment:', process.env.NODE_ENV);
}); 