/**
 * Server-side SSE Service
 * 
 * Manages SSE connections and event broadcasting to clients
 */

import { v4 as uuidv4 } from 'uuid';

// Store active SSE clients
export const sseClients = new Set();

// Client ID tracking
let nextClientId = 1;
const clientIds = new Map();

// Add detailed connection tracking per tab
const tabConnectionHistory = new Map(); // tabId -> array of connection events
const tabStats = new Map(); // tabId -> stats object

// Add blacklist for tabs that ignore duplicate events
const ignoringDuplicateTabs = new Map(); // tabId -> { count, lastBlocked, blockUntil }
const maxIgnoredDuplicates = 3; // Max ignored duplicate events before blocking
const blockDuration = 60000; // Block for 1 minute

// Track connection patterns for debugging
const trackTabConnection = (tabId, eventType, clientId = null, details = {}) => {
  if (!tabConnectionHistory.has(tabId)) {
    tabConnectionHistory.set(tabId, []);
  }
  
  const event = {
    timestamp: Date.now(),
    eventType,
    clientId,
    details
  };
  
  tabConnectionHistory.get(tabId).push(event);
  
  // Keep only last 20 events per tab to prevent memory bloat
  const history = tabConnectionHistory.get(tabId);
  if (history.length > 20) {
    history.splice(0, history.length - 20);
  }
  
  // Update stats
  if (!tabStats.has(tabId)) {
    tabStats.set(tabId, {
      totalConnections: 0,
      totalDisconnections: 0,
      duplicateEvents: 0,
      lastConnectionTime: null,
      connectionFrequency: []
    });
  }
  
  const stats = tabStats.get(tabId);
  
  if (eventType === 'connection') {
    stats.totalConnections++;
    const now = Date.now();
    if (stats.lastConnectionTime) {
      const timeDiff = now - stats.lastConnectionTime;
      stats.connectionFrequency.push(timeDiff);
      // Keep only last 10 intervals
      if (stats.connectionFrequency.length > 10) {
        stats.connectionFrequency.shift();
      }
    }
    stats.lastConnectionTime = now;
  } else if (eventType === 'disconnection') {
    stats.totalDisconnections++;
  } else if (eventType === 'duplicate_event_sent') {
    stats.duplicateEvents++;
  }
};

// Get connection history for debugging
export const getTabConnectionHistory = (tabId) => {
  return {
    history: tabConnectionHistory.get(tabId) || [],
    stats: tabStats.get(tabId) || null
  };
};

// Export the blocking functions for use in routes
export { isTabBlocked, trackIgnoredDuplicate };

// Add a client to the set
export const addClient = (client) => {
  // Generate unique ID for this client
  const clientId = nextClientId++;
  
  // Store the client with its ID
  clientIds.set(client, clientId);
  sseClients.add(client);
  

  
  // Track the connection
  if (client.info?.tabId) {
    trackTabConnection(client.info.tabId, 'connection', clientId, {
      ip: client.info.ip,
      userAgent: client.info.userAgent?.substring(0, 50) + '...' || 'unknown',
      origin: client.info.origin,
      userId: client.info.userId
    });
  }
  
  // Return client ID for reference
  return clientId;
};

// Remove a client from the set
export const removeClient = (client) => {
  // Check if client exists before attempting removal
  if (!sseClients.has(client)) {
    // Client already removed, return false to indicate no action taken
    return false;
  }
  
  // Get the client ID before removing
  const clientId = clientIds.get(client) || 'unknown';
  
  // Track the disconnection
  if (client.info?.tabId) {
    trackTabConnection(client.info.tabId, 'disconnection', clientId, {
      reason: 'normal_disconnect'
    });
  }
  
  // Delete from both data structures atomically
  const wasInSet = sseClients.delete(client);
  const wasInMap = clientIds.delete(client);
  

  
  // Return true only if client was actually found and removed
  return wasInSet || wasInMap;
};

// Find duplicate tabs by tabId
export const findDuplicateTabs = () => {
  const tabCounts = new Map();
  const duplicates = [];
  
  sseClients.forEach(client => {
    if (client.info?.tabId) {
      const tabId = client.info.tabId;
      const count = (tabCounts.get(tabId) || 0) + 1;
      tabCounts.set(tabId, count);
      
      if (count > 1) {
        duplicates.push(tabId);
      }
    }
  });
  
  return [...new Set(duplicates)]; // Return unique duplicate tabIds
};

// List all connected clients (for debugging)
export const listConnectedClients = () => {
  if (sseClients.size === 0) {
    return [];
  }
  
  const clientList = [];
  const tabCounts = new Map();
  
  // Count tabs first
  sseClients.forEach(client => {
    if (client.info?.tabId) {
      const tabId = client.info.tabId;
      const count = (tabCounts.get(tabId) || 0) + 1;
      tabCounts.set(tabId, count);
    }
  });
  
  // List clients with duplicate indication
  sseClients.forEach(client => {
    const clientId = clientIds.get(client) || 'unknown';
    const info = client.info || {};
    const tabId = info.tabId || 'unknown';
    
    // Check if this tab has duplicates
    const isDuplicate = (tabCounts.get(tabId) || 0) > 1;
    
    const clientInfo = {
      id: clientId,
      tabId: tabId,
      ip: info.ip || 'unknown',
      connectedAt: new Date(info.timestamp || Date.now()).toISOString(),
      userAgent: info.userAgent || 'unknown',
      isDuplicate
    };
    
    clientList.push(clientInfo);
  });
  
  return clientList;
};

// Check for stale connections (should be called periodically)
export const cleanupStaleConnections = () => {
  let removedCount = 0;
  const staleClients = [];
  

  
  // First pass: identify stale connections
  sseClients.forEach(client => {
    try {
      // Check if the response is still writable
      if (client.res.writableEnded || client.res.destroyed) {
        staleClients.push(client);
        return;
      }
      
      // Send a comment as a ping (will be ignored by EventSource but keeps connection alive)
      const clientId = clientIds.get(client) || 'unknown';
      const tabId = client.info?.tabId || 'unknown';
      client.res.write(`: ping ${clientId}:${tabId}\n\n`);
    } catch (error) {
      // Connection is dead, mark for removal
      const clientId = clientIds.get(client) || 'unknown';
      const tabId = client.info?.tabId || 'unknown';

      staleClients.push(client);
    }
  });
  
  // Second pass: remove stale connections
  staleClients.forEach(client => {
    const clientId = clientIds.get(client) || 'unknown';
    const tabId = client.info?.tabId || 'unknown';
    
    if (removeClient(client)) {
      removedCount++;
    }
  });
  
  return removedCount;
};

// Send an event to all connected clients
export const broadcastEvent = (eventName, data) => {
  const eventString = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  let failedClients = [];
  let successCount = 0;
  

  
  sseClients.forEach(client => {
    try {
      client.res.write(eventString);
      successCount++;
    } catch (error) {
      const clientId = clientIds.get(client) || 'unknown';
      const tabId = client.info?.tabId || 'unknown';
      

      
      // Mark for removal but don't remove during iteration
      failedClients.push(client);
    }
  });
  
  // Clean up failed clients after iteration
  failedClients.forEach(client => {
    const clientId = clientIds.get(client) || 'unknown';
    const tabId = client.info?.tabId || 'unknown';

    removeClient(client);
  });
  

};

// Send an event to clients belonging to a specific user
export const broadcastEventToUser = (eventName, data, targetUserId) => {
  if (!targetUserId) {
    console.error('broadcastEventToUser called without targetUserId');
    return;
  }

  const eventString = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  let failedClients = [];
  let sentCount = 0;
  
  sseClients.forEach(client => {
    // Only send to clients belonging to the target user
    if (client.info?.userId === targetUserId) {
      try {
        client.res.write(eventString);
        sentCount++;
      } catch (error) {
        const clientId = clientIds.get(client) || 'unknown';
        const tabId = client.info?.tabId || 'unknown';
        console.error(`Error sending event to client ${clientId} (Tab: ${tabId}, User: ${targetUserId}):`, error);
        // Mark for removal but don't remove during iteration
        failedClients.push(client);
      }
    }
  });
  
  // Clean up failed clients after iteration
  failedClients.forEach(client => removeClient(client));
  

};

// For backward compatibility - alias broadcastEvent to broadcastMessage
export const broadcastMessage = broadcastEvent;

// Send message to specific client (by client ID)
export const sendMessageToClient = (clientId, event, data) => {
  // Find the client by its ID
  let targetClient = null;
  for (const client of sseClients) {
    if (clientIds.get(client) === clientId) {
      targetClient = client;
      break;
    }
  }
  
  if (targetClient) {
    try {
      const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      targetClient.res.write(message);
    } catch (error) {
      console.error(`Error sending message to client ${clientId}:`, error);
      removeClient(targetClient);
    }
  }
};

// Track when a tab ignores a duplicate event (reconnects too quickly)
const trackIgnoredDuplicate = (tabId) => {
  if (!ignoringDuplicateTabs.has(tabId)) {
    ignoringDuplicateTabs.set(tabId, { count: 0, lastBlocked: 0, blockUntil: 0 });
  }
  
  const record = ignoringDuplicateTabs.get(tabId);
  record.count++;
  

  
  if (record.count >= maxIgnoredDuplicates) {
    const blockUntil = Date.now() + blockDuration;
    record.blockUntil = blockUntil;
    record.lastBlocked = Date.now();
    record.count = 0; // Reset counter
    

    
    // Track the blocking
    trackTabConnection(tabId, 'blocked', null, {
      reason: 'ignored_duplicate_events',
      blockDuration: blockDuration,
      blockUntil: new Date(blockUntil).toISOString()
    });
  }
};

// Check if a tab is currently blocked
const isTabBlocked = (tabId) => {
  if (!ignoringDuplicateTabs.has(tabId)) {
    return false;
  }
  
  const record = ignoringDuplicateTabs.get(tabId);
  const now = Date.now();
  
  if (now < record.blockUntil) {
    const remainingTime = Math.ceil((record.blockUntil - now) / 1000);

    return true;
  }
  
  // Block expired, clean up
  if (record.blockUntil > 0) {

    ignoringDuplicateTabs.delete(tabId);
  }
  
  return false;
};

// Comprehensive health check that combines cleanup and duplicate detection
export const performHealthCheck = () => {

  
  // Clean up stale connections first
  const removedCount = cleanupStaleConnections();
  
  // Check for duplicate tabs and close older connections
  const duplicateTabs = findDuplicateTabs();
  let duplicatesClosed = 0;
  
  if (duplicateTabs.length > 0) {
    // Close duplicate connections
    duplicatesClosed = closeDuplicateConnections();
  }
  
  // Analyze connection patterns
  const connectionAnalysis = analyzeConnections();
  
  const healthReport = {
    activeConnections: sseClients.size,
    staleRemoved: removedCount,
    duplicateTabs: duplicateTabs.length,
    duplicatesClosed: duplicatesClosed,
    analysis: connectionAnalysis
  };
  

  
  return healthReport;
};

// Analyze connection patterns for debugging
const analyzeConnections = () => {
  const analysis = {
    totalConnections: sseClients.size,
    uniqueTabs: new Set(),
    uniqueSessions: new Set(),
    uniqueUsers: new Set(),
    origins: new Set(),
    connectionAges: []
  };
  
  sseClients.forEach(client => {
    if (client.info?.tabId) analysis.uniqueTabs.add(client.info.tabId);
    if (client.info?.sessionId) analysis.uniqueSessions.add(client.info.sessionId);
    if (client.info?.userId) analysis.uniqueUsers.add(client.info.userId);
    if (client.info?.origin) analysis.origins.add(client.info.origin);
    
    if (client.info?.timestamp) {
      const age = Date.now() - client.info.timestamp;
      analysis.connectionAges.push(age);
    }
  });
  
  return {
    uniqueTabs: analysis.uniqueTabs.size,
    uniqueSessions: analysis.uniqueSessions.size,
    uniqueUsers: analysis.uniqueUsers.size,
    origins: Array.from(analysis.origins),
    averageConnectionAge: analysis.connectionAges.length > 0 
      ? Math.round(analysis.connectionAges.reduce((a, b) => a + b, 0) / analysis.connectionAges.length / 1000) + 's'
      : 'N/A',
    oldestConnection: analysis.connectionAges.length > 0 
      ? Math.round(Math.max(...analysis.connectionAges) / 1000) + 's'
      : 'N/A'
  };
};

// Close duplicate connections for the same tab, keeping only the newest
export const closeDuplicateConnections = () => {
  const tabConnections = new Map(); // tabId -> [{client, clientId, timestamp}]
  let closedCount = 0;
  
  // Group connections by tab ID
  sseClients.forEach(client => {
    const tabId = client.info?.tabId;
    if (tabId) {
      const clientId = clientIds.get(client);
      const timestamp = client.info?.timestamp || 0;
      
      if (!tabConnections.has(tabId)) {
        tabConnections.set(tabId, []);
      }
      
      tabConnections.get(tabId).push({
        client,
        clientId,
        timestamp
      });
    }
  });
  
  // For each tab with multiple connections, close all but the newest
  tabConnections.forEach((connections, tabId) => {
    if (connections.length > 1) {

      
      // Check if tab recently had rapid reconnections (indicates ignoring duplicates)
      const history = getTabConnectionHistory(tabId);
      const hasRapidReconnections = history.stats?.connectionFrequency.some(interval => interval < 5000);
      
      if (hasRapidReconnections) {

        
        // Check if this tab reconnected quickly after last duplicate event
        const recentEvents = history.history.slice(-5);
        const lastDuplicateEvent = recentEvents.findLast(e => e.eventType === 'duplicate_event_sent');
        const lastConnection = recentEvents.findLast(e => e.eventType === 'connection');
        
        if (lastDuplicateEvent && lastConnection && 
            lastConnection.timestamp > lastDuplicateEvent.timestamp &&
            (lastConnection.timestamp - lastDuplicateEvent.timestamp) < 10000) {

          trackIgnoredDuplicate(tabId);
        }
      }
      
      // Sort by timestamp (newest first)
      connections.sort((a, b) => b.timestamp - a.timestamp);
      
      
      
      // Close all but the first (newest) connection
      for (let i = 1; i < connections.length; i++) {
        const { client, clientId } = connections[i];
        try {
          // Track the duplicate event
          trackTabConnection(tabId, 'duplicate_event_sent', clientId, {
            reason: 'duplicate_connection_cleanup',
            keepNewest: true
          });
          
          // Send the duplicate connection event multiple times to ensure delivery
          const eventData = JSON.stringify({
            reason: 'duplicate_connection_detected',
            keepNewest: true,
            timestamp: Date.now(),
            clientId: clientId,
            serverMessage: `You have multiple tabs open. This connection will be closed to prevent conflicts.`
          });
          
          // Send the event multiple times with slight delays
          const sendEvent = () => {
            if (client.res && !client.res.destroyed && !client.res.writableEnded) {
              client.res.write(`event: duplicate_connection\ndata: ${eventData}\n\n`);
              // Force flush the message
              if (typeof client.res.flush === 'function') {
                client.res.flush();
              }
            }
          };
          
          // Send immediately
          sendEvent();
          
          // Send again after 100ms
          setTimeout(sendEvent, 100);
          
          // Send again after 300ms
          setTimeout(sendEvent, 300);
          
          // Send again after 500ms  
          setTimeout(sendEvent, 500);
          
          // Close the connection after a much longer delay to ensure messages are sent and processed
          setTimeout(() => {
            if (client.res && !client.res.destroyed && !client.res.writableEnded) {
              // Track the forced closure
              trackTabConnection(tabId, 'forced_closure', clientId, {
                reason: 'duplicate_cleanup_timeout'
              });
              
              client.res.end();
            }
          }, 3000); // 3 seconds to allow client processing
          
          closedCount++;
        } catch (error) {
          console.error(`Error closing duplicate connection ${clientId}:`, error);
        }
      }
    }
  });
  
  return closedCount;
};

// Debug function to analyze specific tab behavior
export const analyzeTabBehavior = (tabId) => {
  const data = getTabConnectionHistory(tabId);
  
  if (!data.history.length) {
    return null;
  }
  
  return data;
}; 