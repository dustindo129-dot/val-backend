import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { auth } from '../middleware/auth.js';

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueFilename = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueFilename);
  }
});

const upload = multer({ 
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB file size limit
    files: 1 // Only one file per request
  }
});

// Bunny.net API configuration
const BUNNY_STORAGE_API_URL = process.env.BUNNY_STORAGE_API_URL || 'https://storage.bunnycdn.com';
const BUNNY_STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE || 'valvrareteam';
const BUNNY_API_KEY = process.env.BUNNY_API_KEY;
const BUNNY_CDN_URL = process.env.BUNNY_CDN_URL || 'https://valvrareteam.b-cdn.net';

// Helper function to retry axios requests
const axiosRetry = async (config, maxRetries = 3, delay = 1000) => {
  let lastError = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await axios(config);
    } catch (error) {
      console.error(`Attempt ${attempt + 1}/${maxRetries} failed:`, error.code || error.message);
      lastError = error;
      
      // If we're out of retries, throw the error
      if (attempt >= maxRetries - 1) throw error;
      
      // Wait before next retry with exponential backoff
      await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, attempt)));
    }
  }
};

/**
 * @route GET /api/upload/test-bunny-connection
 * @desc Test connectivity to bunny.net
 * @access Private
 */
router.get('/test-bunny-connection', auth, async (req, res) => {
  try {
    // Make a simple HEAD request to test connectivity
    console.log('Testing connection to Bunny.net...');
    console.log(`Storage URL: ${BUNNY_STORAGE_API_URL}/${BUNNY_STORAGE_ZONE}`);
    
    const response = await axios.head(`${BUNNY_STORAGE_API_URL}/${BUNNY_STORAGE_ZONE}/`, {
      headers: {
        'AccessKey': BUNNY_API_KEY
      },
      timeout: 5000 // 5 second timeout
    });
    
    console.log('Connection successful!', response.status);
    res.json({ 
      success: true, 
      status: response.status,
      message: 'Successfully connected to Bunny.net storage'
    });
  } catch (error) {
    console.error('Bunny.net connection test failed:', {
      code: error.code,
      message: error.message,
      response: error.response?.status
    });
    
    res.status(500).json({ 
      success: false, 
      error: error.message,
      code: error.code,
      details: error.response?.data || 'No additional details'
    });
  }
});

/**
 * @route POST /api/upload/bunny
 * @desc Upload file to bunny.net storage with improved error handling and retries
 * @access Private
 */
router.post('/bunny', auth, upload.single('file'), async (req, res) => {
  let filePath = null;
  
  try {
    console.log(`[🧪] Upload handler hit`);
    console.log(`[🧪] File received:`, req.file?.originalname);
    console.log(`[🧪] BUNNY_API_KEY loaded:`, !!BUNNY_API_KEY);

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    if (!BUNNY_API_KEY) {
      return res.status(500).json({ message: 'Bunny.net API key not configured' });
    }

    filePath = req.file.path;
    console.log(`[🧪] File path:`, filePath);
    
    // Get path from request or generate a default one
    const storagePath = req.body.path || `/${path.basename(req.file.path)}`;
    console.log(`[🧪] Storage path:`, storagePath);
    
    // Check file exists and is readable
    if (!fs.existsSync(filePath)) {
      return res.status(500).json({ message: 'File not found after upload' });
    }
    
    // Get file stats
    const stats = fs.statSync(filePath);
    console.log(`File size: ${stats.size} bytes`);
    
    // Read file into buffer to avoid streaming issues
    const fileBuffer = fs.readFileSync(filePath);
    
    // Bunny Storage API endpoint
    const bunnyStorageUrl = `${BUNNY_STORAGE_API_URL}/${BUNNY_STORAGE_ZONE}${storagePath}`;
    console.log(`[🧪] Final Bunny upload URL: ${bunnyStorageUrl}`);
    
    try {
      // Use axios with retry for the PUT request
      const uploadResponse = await axiosRetry({
        method: 'put',
        url: bunnyStorageUrl,
        data: fileBuffer,
        headers: {
          'AccessKey': BUNNY_API_KEY,
          'Content-Type': 'application/octet-stream',
          'Content-Length': stats.size
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 30000 // 30 second timeout
      }, 3); // 3 retries
      
      console.log(`[✅] Bunny upload response:`, uploadResponse.status);
      
      // Delete the local file after successful upload
      fs.unlinkSync(filePath);
      filePath = null;
      
      // Generate and return the CDN URL
      const cdnUrl = `${BUNNY_CDN_URL}${storagePath}`;
      return res.status(200).json({ 
        url: cdnUrl,
        success: true 
      });
    } catch (error) {
      console.error('[❌] Bunny Axios error:', {
        message: error.message,
        code: error.code,
        status: error.response?.status,
        data: error.response?.data
      });
      
      return res.status(500).json({
        message: 'Failed to upload to Bunny',
        error: error.message,
        details: error.response?.data || 'No extra details'
      });
    }
  } catch (error) {
    console.error('Server error in upload route:', error);
    return res.status(500).json({ 
      message: 'Server error', 
      error: error.message 
    });
  } finally {
    // Clean up the temp file if it still exists
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log('Cleaned up temp file:', filePath);
      } catch (e) {
        console.error('Failed to clean up temp file:', e);
      }
    }
  }
});

export default router; 