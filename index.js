// Import required dependencies
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import compression from 'compression';
import { renderPage } from 'vite-plugin-ssr/server';
import { createServer } from 'vite';
import isBot from './utils/isBot.js';
import sirv from 'sirv';
import fs from 'fs';
import { cleanupStaleConnections, listConnectedClients } from './services/sseService.js';

// Import route handlers
import authRoutes from './routes/auth.js';
import novelRoutes from './routes/novels.js';
import commentRoutes from './routes/comments.js';
import userRoutes from './routes/users.js';
import chaptersRouter from './routes/chapters.js';
import moduleRoutes from './routes/modules.js';
import userChapterInteractionRoutes from './routes/userChapterInteractions.js';
import userNovelInteractionRoutes from './routes/userNovelInteractions.js';
import reportRoutes from './routes/reports.js';
import uploadRoutes from './routes/uploadRoutes.js';
import requestRoutes from './routes/requests.js';
import topupRoutes from './routes/topup.js';
import contributionRoutes from './routes/contributions.js';
import topuptransactionRoutes from './routes/topuptransaction.js';
import webhookRoutes from './routes/webhook.js';
import { initScheduler } from './scheduler.js';

// Load environment variables from .env file
dotenv.config();

// Configure ES modules __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express application
const app = express();
const port = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';
const root = path.join(__dirname, '..');

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

// Add compression for performance
app.use(compression());

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
    ? [process.env.FRONTEND_URL]
    : ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'Access-Control-Allow-Headers',
    'Access-Control-Allow-Origin',
    'Access-Control-Allow-Methods',
    'Pragma'
  ],
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

// Set up Vite server in middleware mode for development
let viteDevServer;
if (!isProduction) {
  const initViteServer = async () => {
    viteDevServer = await createServer({
      root,
      server: { 
        middlewareMode: true,
        hmr: {
          port: 24678  // Different port for backend HMR
        }
      }
    });
    app.use(viteDevServer.middlewares);
  };
  
  // Immediately invoke the function
  initViteServer().catch(console.error);
} else {
  // In production, try to serve static files from multiple possible paths
  const possiblePaths = [
    path.resolve(__dirname, '../dist/client'),  // When server is in its own directory
    path.resolve(__dirname, '../../dist/client'), // Fallback path
    '/app/dist/client'  // Docker path
  ];
  
  console.log('Possible static file paths:');
  possiblePaths.forEach(p => {
    const exists = fs.existsSync(p);
    console.log(`- ${p} (${exists ? 'exists' : 'not found'})`);
    if (exists) {
      // Use sirv with better settings for production
      app.use(sirv(p, {
        dev: false,
        etag: true,
        maxAge: 31536000, // 1 year in seconds
        immutable: true,
        setHeaders: (res, path) => {
          // Set proper Cache-Control headers
          if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
          } else if (path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/)) {
            res.setHeader('Cache-Control', 'public,max-age=31536000,immutable');
          }
        }
      }));
    }
  });
  
  // If none of the paths exist, log a warning
  const anyPathExists = possiblePaths.some(p => fs.existsSync(p));
  if (!anyPathExists) {
    console.warn('WARNING: No static file paths found. Frontend may not be served correctly.');
  }
}

// Register API routes
app.use('/api/auth', authRoutes);      // Authentication endpoints
app.use('/api/novels', novelRoutes);   // Novel management endpoints
app.use('/api/comments', commentRoutes); // Comment system endpoints
app.use('/api/users', userRoutes);      // User management endpoints
app.use('/api/chapters', chaptersRouter); // Chapter management endpoints
app.use('/api/modules', moduleRoutes);   // Module management endpoints
app.use('/api/user-chapter-interactions', userChapterInteractionRoutes); // User chapter interactions endpoints
app.use('/api/user-novel-interactions', userNovelInteractionRoutes); // User novel interactions endpoints
app.use('/api/reports', reportRoutes); // Report endpoints
app.use('/api/upload', uploadRoutes); // File upload endpoints
app.use('/api/requests', requestRoutes); // Request system endpoints
app.use('/api/topup', topupRoutes); // Top-up transaction endpoints
app.use('/api/contributions', contributionRoutes); // Contribution endpoints
app.use('/api/topup-admin', topuptransactionRoutes);
app.use('/api/webhooks', webhookRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  // Check MongoDB connection
  const isMongoConnected = mongoose.connection.readyState === 1;
  
  if (isMongoConnected) {
    res.status(200).json({ status: 'healthy', mongodb: 'connected' });
  } else {
    res.status(503).json({ status: 'unhealthy', mongodb: 'disconnected' });
  }
});

// Special handler for bundled assets in production
// This must come BEFORE the SSR handler to catch static asset requests
if (isProduction) {
  app.get('*', (req, res, next) => {
    const url = req.originalUrl;
    
    // Skip API routes and non-static asset requests
    if (url.startsWith('/api/') || !(
      url.endsWith('.js') || 
      url.endsWith('.css') || 
      url.endsWith('.ico') || 
      url.endsWith('.png') || 
      url.endsWith('.jpg') || 
      url.endsWith('.svg') ||
      url.endsWith('.json') ||
      url.endsWith('.woff') ||
      url.endsWith('.woff2') ||
      url.endsWith('.ttf') ||
      url.includes('assets/')
    )) {
      return next();
    }
    
    // For static assets, try all possible paths
    const possiblePaths = [
      path.resolve(__dirname, '../dist/client' + url),
      path.resolve(__dirname, '../../dist/client' + url),
      '/app/dist/client' + url
    ];
    
    for (const assetPath of possiblePaths) {
      if (fs.existsSync(assetPath)) {
        return res.sendFile(assetPath);
      }
    }
    
    // If we get here, the asset wasn't found
    console.warn(`Static asset not found: ${url}`);
    next();
  });
  
  // SPA fallback route - handle client-side routing by serving index.html
  // This comes AFTER static asset handler but BEFORE SSR handler
  app.get('*', (req, res, next) => {
    const url = req.originalUrl;
    
    // Skip API routes
    if (url.startsWith('/api/')) {
      return next();
    }
    
    // Only use SSR for bots, regular users get CSR with index.html
    const userAgent = req.headers['user-agent'] || '';
    if (isBot(userAgent)) {
      return next(); // Let bots go to SSR
    }
    
    console.log(`Serving SPA for non-bot direct navigation: ${url}`);
    
    // For SPA routes, find and serve index.html
    const possibleIndexPaths = [
      path.resolve(__dirname, '../dist/client/index.html'),
      path.resolve(__dirname, '../../dist/client/index.html'),
      '/app/dist/client/index.html'
    ];
    
    for (const indexPath of possibleIndexPaths) {
      if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
      }
    }
    
    // If no index.html was found, continue to SSR as fallback
    next();
  });
}

// SSR handler for vite-plugin-ssr (handle non-API routes)
app.use('*', async (req, res, next) => {
  const url = req.originalUrl;
  
  // Skip API routes - they're handled separately
  if (url.startsWith('/api/')) {
    return next();
  }
  
  // Only use SSR for bots, regular users get CSR
  const userAgent = req.headers['user-agent'] || '';
  const shouldPrerender = isBot(userAgent);
  
  // For development, always use CSR unless testing bot mode with query param
  const forceSsr = req.query.ssr === 'true';
  const forceClient = !isProduction && !forceSsr;
  
  try {
    const pageContextInit = {
      urlOriginal: url,
      userAgent,
      isBot: shouldPrerender,
      forceClient
    };
    
    const pageContext = await renderPage(pageContextInit);
    
    if (pageContext.httpResponse === null) {
      return next();
    }
    
    const { statusCode, contentType, earlyHints } = pageContext.httpResponse;
    
    if (res.writeEarlyHints) {
      res.writeEarlyHints({ link: earlyHints.map((e) => e.earlyHintLink) });
    }
    
    res.status(statusCode).type(contentType);
    pageContext.httpResponse.pipe(res);
  } catch (error) {
    viteDevServer?.ssrFixStacktrace(error);
    console.error(error.stack);
    res.status(500).send('Server Error');
  }
});

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
  
  // Set up periodic cleanup of stale SSE connections
  setInterval(() => {
    cleanupStaleConnections();
  }, 30000); // Check every 30 seconds
  
  // Periodically list all connected clients (for debugging)
  setInterval(() => {
    if (process.env.NODE_ENV !== 'production') {
      listConnectedClients();
    }
  }, 60000); // List every minute in development
});

// Initialize scheduled tasks
initScheduler(); 