import cloudinary from '../config/cloudinary.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Uploads a base64 encoded image to Cloudinary as an illustration
 * @param {string} base64String - The base64 encoded image string (including data URL prefix)
 * @param {Object} options - Optional upload parameters
 * @returns {Promise<string>} The Cloudinary URL of the uploaded image
 * @throws {Error} If the upload fails
 */
export const uploadImage = async (base64String, options = {}) => {
  try {
    // Validate input
    if (!base64String || typeof base64String !== 'string') {
      throw new Error('Invalid image data');
    }
    
    // Estimate image size (base64 is ~33% larger than binary)
    const sizeInBytes = Math.round((base64String.length * 3) / 4);
    const sizeInMB = sizeInBytes / (1024 * 1024);
    
    if (sizeInMB > 10) {
      throw new Error(`Image too large (${sizeInMB.toFixed(2)}MB). Maximum size is 10MB.`);
    }
    
    // Get illustration upload preset from environment
    const illustrationPreset = process.env.CLOUDINARY_ILLUSTRATION_UPLOAD_PRESET;
    
    if (!illustrationPreset) {
      console.warn('CLOUDINARY_ILLUSTRATION_UPLOAD_PRESET not set in environment');
    }
    
    // Set up upload options
    const uploadOptions = {
      folder: 'novel-illustrations',
      resource_type: 'image',
      upload_preset: illustrationPreset || undefined,
      ...options
    };
    
    console.log(`Uploading illustration to Cloudinary (${sizeInMB.toFixed(2)}MB)`);
    
    // Upload to Cloudinary
    const result = await cloudinary.uploader.upload(base64String, uploadOptions);
    
    console.log(`Illustration uploaded successfully: ${result.public_id}`);
    return result.secure_url;
  } catch (error) {
    console.error('Illustration upload error:', error);
    if (error.http_code) {
      console.error(`Cloudinary HTTP error: ${error.http_code}`, error.message);
    }
    throw new Error(`Failed to upload illustration: ${error.message}`);
  }
};

/**
 * Deletes an image from Cloudinary
 * @param {string} imageUrl - The Cloudinary URL of the image to delete
 * @returns {Promise<void>}
 */
export const deleteImage = async (imageUrl) => {
  try {
    if (!imageUrl || !imageUrl.includes('cloudinary')) return;

    // Extract the public_id from the Cloudinary URL more reliably
    const urlParts = imageUrl.split('/');
    const filenameWithExt = urlParts[urlParts.length - 1];
    const publicId = filenameWithExt.split('.')[0];
    
    // Get the folder name from the URL
    const folderIndex = urlParts.findIndex(part => part === 'upload') + 1;
    const folders = urlParts.slice(folderIndex, -1);
    const folderPath = folders.join('/');
    
    // Construct the full public ID with folder path
    const fullPublicId = folderPath ? `${folderPath}/${publicId}` : publicId;
    
    console.log(`Deleting illustration from Cloudinary: ${fullPublicId}`);
    
    // Delete from Cloudinary
    const result = await cloudinary.uploader.destroy(fullPublicId);
    
    if (result.result === 'ok') {
      console.log('Illustration deleted successfully');
    } else {
      console.warn(`Cloudinary response: ${result.result}`);
    }
  } catch (error) {
    console.error('Illustration deletion error:', error);
    // Don't throw error if deletion fails - just log it
  }
}; 