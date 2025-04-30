// Load environment variables directly in this file to ensure they're available
import dotenv from 'dotenv';
dotenv.config();

import { createClient } from 'redis';

// Track connection status
let isRedisAvailable = false;

// Create a Redis client with error handling
const redisClient = createClient({
  username: process.env.REDIS_USERNAME || 'default',
  password: process.env.REDIS_PASSWORD,
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    reconnectStrategy: (retries) => {
      // Exponential backoff with max 10 second delay
      const delay = Math.min(Math.pow(2, retries) * 100, 10000);
      return delay;
    }
  }
});

// Handle Redis connection errors
redisClient.on('error', (err) => {
  console.error('Redis error:', err);
  isRedisAvailable = false;
});

// Handle successful connection
redisClient.on('connect', () => {
  isRedisAvailable = true;
});

redisClient.on('reconnecting', () => {
  // Silent reconnection
});

redisClient.on('end', () => {
  isRedisAvailable = false;
});

// Connect to Redis
const connectRedis = async () => {
  try {
    if (!redisClient.isOpen) {
      await redisClient.connect();
    }
    isRedisAvailable = true;
    return true;
  } catch (err) {
    console.error('Failed to connect to Redis:', err);
    isRedisAvailable = false;
    return false;
  }
};

// Attempt initial connection
connectRedis().catch(err => {
  console.error('Initial Redis connection failed:', err.message);
});

/**
 * Set a value in Redis cache
 * @param {string} key - Cache key
 * @param {any} value - Value to cache (will be JSON stringified)
 * @param {number} expireSeconds - Time to live in seconds
 */
export const setCacheValue = async (key, value, expireSeconds = 300) => {
  // Skip if Redis is not available
  if (!isRedisAvailable) {
    return false;
  }

  try {
    if (!redisClient.isOpen) {
      const connected = await connectRedis();
      if (!connected) return false;
    }
    
    // Add timeout to prevent hanging operations
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Redis set operation timed out')), 1000)
    );
    
    await Promise.race([
      redisClient.set(key, JSON.stringify(value), {
        EX: expireSeconds
      }),
      timeoutPromise
    ]);
    
    return true;
  } catch (err) {
    console.error('Redis set error:', err);
    return false;
  }
};

/**
 * Get a value from Redis cache
 * @param {string} key - Cache key
 * @returns {any|null} - Parsed cached value or null if not found
 */
export const getCacheValue = async (key) => {
  // Skip if Redis is not available
  if (!isRedisAvailable) {
    return null;
  }

  try {
    if (!redisClient.isOpen) {
      const connected = await connectRedis();
      if (!connected) return null;
    }
    
    // Add timeout to prevent hanging operations
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Redis get operation timed out')), 1000)
    );
    
    const value = await Promise.race([
      redisClient.get(key),
      timeoutPromise
    ]);
    
    return value ? JSON.parse(value) : null;
  } catch (err) {
    console.error('Redis get error:', err);
    return null;
  }
};

/**
 * Delete a value from Redis cache
 * @param {string} key - Cache key
 */
export const deleteCacheValue = async (key) => {
  // Skip if Redis is not available
  if (!isRedisAvailable) {
    return false;
  }

  try {
    if (!redisClient.isOpen) {
      const connected = await connectRedis();
      if (!connected) return false;
    }
    
    // Add timeout to prevent hanging operations
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Redis del operation timed out')), 1000)
    );
    
    await Promise.race([
      redisClient.del(key),
      timeoutPromise
    ]);
    
    return true;
  } catch (err) {
    console.error('Redis delete error:', err);
    return false;
  }
};

/**
 * Delete multiple keys matching a pattern
 * @param {string} pattern - Pattern to match (e.g., "user:*:chapters")
 */
export const deleteByPattern = async (pattern) => {
  // Skip if Redis is not available
  if (!isRedisAvailable) {
    return false;
  }

  try {
    if (!redisClient.isOpen) {
      const connected = await connectRedis();
      if (!connected) return false;
    }
    
    // Find all keys matching the pattern with timeout
    const keysPromise = redisClient.keys(pattern);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Redis keys operation timed out')), 2000)
    );
    
    const keys = await Promise.race([keysPromise, timeoutPromise]);
    
    if (keys && keys.length > 0) {
      // Delete all matched keys
      await redisClient.del(keys);
    }
    
    return true;
  } catch (err) {
    console.error('Redis pattern delete error:', err);
    return false;
  }
};

/**
 * Get Redis connection status and statistics
 */
export const getRedisStatus = async () => {
  try {
    if (!isRedisAvailable) {
      return {
        status: 'offline',
        message: 'Redis connection is unavailable'
      };
    }

    if (!redisClient.isOpen) {
      const connected = await connectRedis();
      if (!connected) {
        return {
          status: 'offline',
          message: 'Redis connection is closed and reconnection failed'
        };
      }
    }
    
    // Add timeout to prevent hanging operations
    const infoPromise = redisClient.info();
    const sizePromise = redisClient.dbSize();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Redis info operation timed out')), 2000)
    );
    
    // Get info about the Redis server
    const [info, dbSize] = await Promise.all([
      Promise.race([infoPromise, timeoutPromise]),
      Promise.race([sizePromise, timeoutPromise])
    ]);
    
    return {
      status: 'online',
      dbSize,
      info: info
        .split('\n')
        .filter(line => line.includes('used_memory') || 
                        line.includes('connected_clients') ||
                        line.includes('uptime'))
        .reduce((obj, line) => {
          const parts = line.split(':');
          if (parts.length === 2) {
            obj[parts[0].trim()] = parts[1].trim();
          }
          return obj;
        }, {})
    };
  } catch (err) {
    console.error('Redis status check error:', err);
    return {
      status: 'error',
      message: err.message
    };
  }
};

export default redisClient; 