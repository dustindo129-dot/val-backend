// Import Cloudinary v2 SDK and dotenv for environment variables
import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// Configure Cloudinary with credentials from environment variables
// Required environment variables:
// - CLOUDINARY_CLOUD_NAME: Your Cloudinary cloud name
// - CLOUDINARY_API_KEY: Your Cloudinary API key
// - CLOUDINARY_API_SECRET: Your Cloudinary API secret
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Export the configured Cloudinary instance for use in other files
export default cloudinary; 