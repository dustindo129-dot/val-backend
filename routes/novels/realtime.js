import express from "express";
import { auth } from "../../middleware/auth.js";
import { clearNovelCaches, notifyAllClients, shouldBypassCache } from '../../utils/cacheUtils.js';
import { addClient, removeClient } from '../../services/sseService.js';

const router = express.Router();

// Add cache control headers middleware
const setCacheControlHeaders = (req, res, next) => {
  // Check if this is a critical path that should bypass cache
  const isCriticalPath = shouldBypassCache(req.path, req.query);
  
  if (isCriticalPath) {
    // Set the most aggressive no-cache headers possible
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '-1');
    res.set('Surrogate-Control', 'no-store');
    // Add a timestamp to make sure browser doesn't use cached response
    res.set('X-Timestamp', new Date().getTime().toString());
  } 
  // For other GET requests, allow minimal caching
  else if (req.method === 'GET') {
    res.set('Cache-Control', 'private, max-age=10'); // Only 10 seconds
  } 
  // For mutations (POST, PUT, DELETE), prevent caching
  else {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
};

// Apply cache control headers to all routes
router.use(setCacheControlHeaders);

// Server-Sent Events endpoint for real-time updates
router.get('/sse', (req, res) => {
  // Set headers for SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });

  // Store client IP, user agent and tab ID to help identify unique clients
  const clientInfo = {
    ip: req.ip || req.socket.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
    tabId: req.query.tabId || `manual_${Date.now()}`,
    timestamp: Date.now()
  };

  // Send initial connection message with client ID
  const client = { res, info: clientInfo };
  const clientId = addClient(client);
  
  res.write(`data: ${JSON.stringify({ 
    message: 'Connected to novel updates',
    clientId: clientId,
    tabId: clientInfo.tabId,
    timestamp: Date.now() 
  })}\n\n`);

  // Send a ping every 20 seconds to keep the connection alive
  const pingInterval = setInterval(() => {
    try {
      res.write(`: ping ${clientId}:${clientInfo.tabId}\n\n`);
    } catch (error) {
      clearInterval(pingInterval);
      removeClient(client);
    }
  }, 20000);

  // Handle client disconnect
  req.on('close', () => {
    clearInterval(pingInterval);
    removeClient(client);
  });
});

/**
 * Force refresh all novel data
 * @route GET /api/novels/refresh
 */
router.get("/refresh", auth, async (req, res) => {
  try {
    // Clear all novel caches
    clearNovelCaches();
    
    // Notify clients
    notifyAllClients('refresh', { 
      timestamp: new Date().toISOString(),
      message: 'All novel data has been refreshed'
    });
    
    res.json({ 
      success: true, 
      message: 'All caches cleared and clients notified' 
    });
  } catch (err) {
    res.status(500).json({ 
      success: false,
      message: err.message 
    });
  }
});

/**
 * Force browser refresh timestamp
 * @route GET /api/novels/browser-refresh
 */
router.get("/browser-refresh", async (req, res) => {
  try {
    // This endpoint just returns a new timestamp that clients can use
    // to force their browser to bypass any caching
    const timestamp = new Date().getTime();
    
    // Set aggressive no-cache headers
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '-1');
    res.set('Surrogate-Control', 'no-store');
    
    res.json({ 
      timestamp,
      cacheBuster: `_cb=${timestamp}`,
      message: 'Add this cacheBuster to your API requests to force fresh data'
    });
  } catch (err) {
    res.status(500).json({ 
      success: false,
      message: err.message 
    });
  }
});

export default router; 