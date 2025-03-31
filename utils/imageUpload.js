import cloudinary from '../config/cloudinary.js';

/**
 * Uploads a base64 encoded image to Cloudinary
 * @param {string} base64String - The base64 encoded image string (including data URL prefix)
 * @returns {Promise<string>} The Cloudinary URL of the uploaded image
 * @throws {Error} If the upload fails
 */
export const uploadImage = async (base64String) => {
  try {
    // Upload to Cloudinary
    const result = await cloudinary.uploader.upload(base64String, {
      folder: 'novel-covers', // Organize uploads in a folder
      resource_type: 'auto' // Automatically detect resource type
    });

    return result.secure_url;
  } catch (error) {
    console.error('Image upload error:', error);
    throw new Error('Failed to upload image');
  }
};

/**
 * Deletes an image from Cloudinary
 * @param {string} imageUrl - The Cloudinary URL of the image to delete
 * @returns {Promise<void>}
 */
export const deleteImage = async (imageUrl) => {
  try {
    if (!imageUrl) return;

    // Extract public_id from URL
    const publicId = imageUrl.split('/').slice(-1)[0].split('.')[0];
    
    // Delete from Cloudinary
    await cloudinary.uploader.destroy(`novel-covers/${publicId}`);
  } catch (error) {
    console.error('Image deletion error:', error);
    // Don't throw error if deletion fails
  }
}; 