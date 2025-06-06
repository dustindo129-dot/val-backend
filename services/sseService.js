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
  
  // Log detailed info for problematic tab
  if (tabId === 'tab_1749148822653_8oekv3a0') {
    console.log(`🔍 TRACKING [${tabId}] ${eventType.toUpperCase()}: Client ${clientId || 'N/A'}`);
    if (details.reason) console.log(`   └─ Reason: ${details.reason}`);
    if (stats.connectionFrequency.length > 0) {
      const avgInterval = stats.connectionFrequency.reduce((a, b) => a + b, 0) / stats.connectionFrequency.length;
      console.log(`   └─ Avg reconnect interval: ${Math.round(avgInterval)}ms`);
    }
    console.log(`   └─ Stats: ${stats.totalConnections} connections, ${stats.totalDisconnections} disconnections, ${stats.duplicateEvents} duplicate events`);
  }
};

// Get connection history for debugging
export const getTabConnectionHistory = (tabId) => {
  return {
    history: tabConnectionHistory.get(tabId) || [],
    stats: tabStats.get(tabId) || null
  };
};

// Add a client to the set
export const addClient = (client) => {
  // Generate unique ID for this client
  const clientId = nextClientId++;
  
  // Store the client with its ID
  clientIds.set(client, clientId);
  sseClients.add(client);
  
  const tabInfo = client.info?.tabId ? ` (Tab: ${client.info.tabId})` : '';
  console.log(`Client ${clientId}${tabInfo} connected. Total clients: ${sseClients.size}`);
  
  // Track the connection
  if (client.info?.tabId) {
    trackTabConnection(client.info.tabId, 'connection', clientId, {
      ip: client.info.ip,
      userAgent: client.info.userAgent?.substring(0, 50) + '...' || 'unknown'
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
  
  // Only log if client was actually removed
  if (wasInSet || wasInMap) {
    const tabInfo = client.info?.tabId ? ` (Tab: ${client.info.tabId})` : '';
    console.log(`Client ${clientId}${tabInfo} disconnected. Total clients: ${sseClients.size}`);
  }
  
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
  console.log(`=== Connected Clients (${sseClients.size}) ===`);
  
  if (sseClients.size === 0) {
    console.log('No clients connected');
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
    const duplicateMarker = isDuplicate ? ' [DUPLICATE]' : '';
    
    const clientInfo = {
      id: clientId,
      tabId: tabId,
      ip: info.ip || 'unknown',
      connectedAt: new Date(info.timestamp || Date.now()).toISOString(),
      userAgent: info.userAgent || 'unknown',
      isDuplicate
    };
    
    console.log(`  - Client ${clientId} (Tab: ${tabId})${duplicateMarker}`);
    clientList.push(clientInfo);
  });
  
  // Check for duplicates
  const duplicateTabs = findDuplicateTabs();
  if (duplicateTabs.length > 0) {
    console.log(`WARNING: Found ${duplicateTabs.length} duplicate tab connections!`);
    duplicateTabs.forEach(tabId => {
      console.log(`  - Tab ${tabId} has multiple connections`);
    });
  }
  
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
      staleClients.push(client);
    }
  });
  
  // Second pass: remove stale connections
  staleClients.forEach(client => {
    if (removeClient(client)) {
      removedCount++;
    }
  });
  
  if (removedCount > 0) {
    console.log(`Cleaned up ${removedCount} stale connections. Remaining clients: ${sseClients.size}`);
    listConnectedClients();
  }
  
  return removedCount;
};

// Send an event to all connected clients
export const broadcastEvent = (eventName, data) => {
  const eventString = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  let failedClients = [];
  
  sseClients.forEach(client => {
    try {
      client.res.write(eventString);
    } catch (error) {
      const clientId = clientIds.get(client) || 'unknown';
      const tabId = client.info?.tabId || 'unknown';
      console.error(`Error sending event to client ${clientId} (Tab: ${tabId}):`, error);
      // Mark for removal but don't remove during iteration
      failedClients.push(client);
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

// Comprehensive health check that combines cleanup and duplicate detection
export const performHealthCheck = () => {
  console.log('=== SSE Health Check ===');
  
  // Clean up stale connections first
  const removedCount = cleanupStaleConnections();
  
  // Check for duplicate tabs and close older connections
  const duplicateTabs = findDuplicateTabs();
  let duplicatesClosed = 0;
  
  if (duplicateTabs.length > 0) {
    console.log(`⚠️  Found ${duplicateTabs.length} duplicate tab connections:`);
    duplicateTabs.forEach(tabId => {
      const tabClients = [];
      sseClients.forEach(client => {
        if (client.info?.tabId === tabId) {
          const clientId = clientIds.get(client) || 'unknown';
          tabClients.push(clientId);
        }
      });
      console.log(`   - Tab ${tabId}: clients ${tabClients.join(', ')}`);
    });
    
    // Close duplicate connections
    duplicatesClosed = closeDuplicateConnections();
  }
  
  // Summary
  console.log(`Health check complete: ${sseClients.size} active connections, ${removedCount} stale removed, ${duplicateTabs.length} duplicate tabs, ${duplicatesClosed} duplicates closed`);
  
  return {
    activeConnections: sseClients.size,
    staleRemoved: removedCount,
    duplicateTabs: duplicateTabs.length,
    duplicatesClosed: duplicatesClosed
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
      // Sort by timestamp (newest first)
      connections.sort((a, b) => b.timestamp - a.timestamp);
      
      // Close all but the first (newest) connection
      for (let i = 1; i < connections.length; i++) {
        const { client, clientId } = connections[i];
        try {
          console.log(`🔄 Closing duplicate connection: Client ${clientId} (Tab: ${tabId})`);
          
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
            clientId: clientId
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
          
          // Send again after 200ms
          setTimeout(sendEvent, 200);
          
          // Close the connection after a longer delay to ensure messages are sent
          setTimeout(() => {
            if (client.res && !client.res.destroyed && !client.res.writableEnded) {
              console.log(`🔄 Forcibly closing duplicate connection: Client ${clientId} (Tab: ${tabId}) after sending duplicate events`);
              
              // Track the forced closure
              trackTabConnection(tabId, 'forced_closure', clientId, {
                reason: 'duplicate_cleanup_timeout'
              });
              
              client.res.end();
            }
          }, 1000); // Increased to 1 second
          
          closedCount++;
        } catch (error) {
          console.error(`Error closing duplicate connection ${clientId}:`, error);
        }
      }
    }
  });
  
  if (closedCount > 0) {
    console.log(`Closed ${closedCount} duplicate connections`);
  }
  
  return closedCount;
};

// Debug function to analyze specific tab behavior
export const analyzeTabBehavior = (tabId) => {
  const data = getTabConnectionHistory(tabId);
  
  if (!data.history.length) {
    console.log(`No connection history found for tab ${tabId}`);
    return null;
  }
  
  console.log(`=== Analysis for Tab ${tabId} ===`);
  console.log(`Total events: ${data.history.length}`);
  console.log(`Stats:`, data.stats);
  
  console.log('\nRecent events:');
  data.history.slice(-10).forEach((event, index) => {
    const time = new Date(event.timestamp).toLocaleTimeString();
    console.log(`  ${index + 1}. [${time}] ${event.eventType} - Client ${event.clientId || 'N/A'}`);
    if (event.details.reason) {
      console.log(`      └─ ${event.details.reason}`);
    }
  });
  
  if (data.stats?.connectionFrequency.length > 0) {
    const intervals = data.stats.connectionFrequency;
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const minInterval = Math.min(...intervals);
    const maxInterval = Math.max(...intervals);
    
    console.log(`\nConnection intervals:`);
    console.log(`  Average: ${Math.round(avgInterval)}ms`);
    console.log(`  Min: ${minInterval}ms`);
    console.log(`  Max: ${maxInterval}ms`);
    console.log(`  Last 5: [${intervals.slice(-5).map(i => Math.round(i)).join(', ')}]ms`);
  }
  
  return data;
}; 