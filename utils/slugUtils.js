/**
 * Server-side utility functions for handling URL slugs
 * Minimal version for server-only deployment
 */

/**
 * Converts a title to a URL-friendly slug
 * @param {string} title - The title to convert
 * @returns {string} URL-friendly slug
 */
export const createSlug = (title) => {
  if (!title) return '';
  
  return title
    .toLowerCase()
    .trim()
    // Replace Vietnamese characters with ASCII equivalents
    .replace(/[àáạảãâầấậẩẫăằắặẳẵ]/g, 'a')
    .replace(/[èéẹẻẽêềếệểễ]/g, 'e')
    .replace(/[ìíịỉĩ]/g, 'i')
    .replace(/[òóọỏõôồốộổỗơờớợởỡ]/g, 'o')
    .replace(/[ùúụủũưừứựửữ]/g, 'u')
    .replace(/[ỳýỵỷỹ]/g, 'y')
    .replace(/đ/g, 'd')
    .replace(/[ÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴ]/g, 'a')
    .replace(/[ÈÉẸẺẼÊỀẾỆỂỄ]/g, 'e')
    .replace(/[ÌÍỊỈĨ]/g, 'i')
    .replace(/[ÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠ]/g, 'o')
    .replace(/[ÙÚỤỦŨƯỪỨỰỬỮ]/g, 'u')
    .replace(/[ỲÝỴỶỸ]/g, 'y')
    .replace(/Đ/g, 'd')
    // Replace special characters and spaces with hyphens
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};

/**
 * Creates a unique slug by appending the ID
 * @param {string} title - The title to convert
 * @param {string|Object} id - The MongoDB ID (string or ObjectId)
 * @returns {string} Unique slug with ID
 */
export const createUniqueSlug = (title, id) => {
  const baseSlug = createSlug(title);
  
  // Handle different ID formats (ObjectId, string, etc.)
  let idString = '';
  if (id) {
    if (typeof id === 'string') {
      idString = id;
    } else if (id.toString) {
      idString = id.toString();
    } else {
      idString = String(id);
    }
  }
  
  // Use last 8 characters of ID as suffix
  const shortId = idString ? idString.slice(-8) : 'loading';
  return baseSlug ? `${baseSlug}-${shortId}` : shortId;
};

/**
 * Validates if a string is a MongoDB ObjectId
 * @param {string} id - The string to validate
 * @returns {boolean} True if valid MongoDB ObjectId
 */
export const isValidObjectId = (id) => {
  return /^[0-9a-fA-F]{24}$/.test(id);
};
