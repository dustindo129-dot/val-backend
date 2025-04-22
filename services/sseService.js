/**
 * Server-side SSE Service
 * 
 * Manages SSE connections and event broadcasting to clients
 */

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
  // Get the client ID before removing
  const clientId = clientIds.get(client) || 'unknown';
  
  // Delete from both data structures
  sseClients.delete(client);
  clientIds.delete(client);
  
  const tabInfo = client.info?.tabId ? ` (Tab: ${client.info.tabId})` : '';
  console.log(`Client ${clientId}${tabInfo} disconnected. Total clients: ${sseClients.size}`);
  
  // Return true if client was found and removed
  return clientId !== 'unknown';
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
  
  // Send a ping to each client, remove those that error out
  sseClients.forEach(client => {
    try {
      // Send a comment as a ping (will be ignored by EventSource but keeps connection alive)
      const clientId = clientIds.get(client) || 'unknown';
      const tabId = client.info?.tabId || 'unknown';
      client.res.write(`: ping ${clientId}:${tabId}\n\n`);
    } catch (error) {
      // Connection is dead, remove it
      if (removeClient(client)) {
        removedCount++;
      }
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