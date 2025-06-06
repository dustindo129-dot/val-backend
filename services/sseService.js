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

// Add a client to the set
export const addClient = (client) => {
  // Generate unique ID for this client
  const clientId = nextClientId++;
  
  // Store the client with its ID
  clientIds.set(client, clientId);
  sseClients.add(client);
  
  const tabInfo = client.info?.tabId ? ` (Tab: ${client.info.tabId})` : '';
  console.log(`Client ${clientId}${tabInfo} connected. Total clients: ${sseClients.size}`);
  
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
           console.log(`Closing duplicate connection: Client ${clientId} (Tab: ${tabId})`);
           
           // Send the duplicate connection event
           const eventData = JSON.stringify({
             reason: 'duplicate_connection_detected',
             keepNewest: true,
             timestamp: Date.now()
           });
           
           client.res.write(`event: duplicate_connection\ndata: ${eventData}\n\n`);
           
           // Force flush the message
           if (typeof client.res.flush === 'function') {
             client.res.flush();
           }
           
           // Close the connection after a longer delay to ensure message is sent
           setTimeout(() => {
             if (client.res && !client.res.destroyed && !client.res.writableEnded) {
               console.log(`Forcibly closing duplicate connection: Client ${clientId} (Tab: ${tabId})`);
               client.res.end();
             }
           }, 500); // Increased from 100ms to 500ms
           
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