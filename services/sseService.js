/**
 * Server-side SSE Service
 * 
 * Manages SSE connections and event broadcasting to clients
 */

// Store active SSE clients
export const sseClients = new Set();

// Add a client to the set
export const addClient = (client) => {
  sseClients.add(client);
  console.log(`Client connected. Total clients: ${sseClients.size}`);
};

// Remove a client from the set
export const removeClient = (client) => {
  sseClients.delete(client);
  console.log(`Client disconnected. Total clients: ${sseClients.size}`);
};

// Send an event to all connected clients
export const broadcastEvent = (eventName, data) => {
  const eventString = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  
  sseClients.forEach(client => {
    try {
      client.res.write(eventString);
    } catch (error) {
      console.error(`Error sending event to client:`, error);
      // Remove problematic client
      removeClient(client);
    }
  });
}; 