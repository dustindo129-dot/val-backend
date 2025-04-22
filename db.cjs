'use strict';

const mongoose = require('mongoose');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// MongoDB connection function
function connectToDatabase() {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => {
      console.log('Connected to MongoDB');
    })
    .catch((error) => {
      console.error('MongoDB connection error:', error);
      process.exit(1);  // Exit if database connection fails
    });

  // Enable MongoDB debug mode in development
  if (process.env.NODE_ENV === 'development') {
    mongoose.set('debug', { 
      color: true,  // Enable colored output
      shell: true   // Use shell syntax for queries
    });
  }

  return mongoose;
}

// Initialize connection
const mongooseInstance = connectToDatabase();

// Export the mongoose instance and connection
module.exports = {
  mongoose: mongooseInstance,
  connection: mongooseInstance.connection
}; 