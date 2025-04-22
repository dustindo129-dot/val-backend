// ES Module wrapper for the CommonJS mongoose bridge
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('./db.cjs');

// Re-export the mongoose instance and connection
export const mongoose = db.mongoose;
export const connection = db.connection;

// Default export for convenience
export default db.mongoose; 