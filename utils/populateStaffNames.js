import mongoose from 'mongoose';
import User from '../models/User.js';

/**
 * Populates staff ObjectIds with user display names
 * Handles mixed data (ObjectIds and plain text strings)
 * Works with both novel objects (active/inactive staff) and chapter objects (individual staff fields)
 * @param {Object} obj - Novel or Chapter object with staff data
 * @returns {Object} Object with populated staff names
 */
export const populateStaffNames = async (obj) => {
  try {
    if (!obj) {
      return obj;
    }

    // Helper function to check if a value is a valid MongoDB ObjectId
    const isValidObjectId = (id) => {
      // Check for actual ObjectId instances
      if (mongoose.Types.ObjectId.isValid(id) && id instanceof mongoose.Types.ObjectId) {
        return true;
      }
      // Check for string representations of ObjectId
      return typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id);
    };

    // Helper function to convert ObjectId to string
    const objectIdToString = (id) => {
      if (id instanceof mongoose.Types.ObjectId) {
        return id.toString();
      }
      return id;
    };

    // Helper function to process a single staff field (for chapters)
    const processStaffField = async (staffValue) => {
      if (!staffValue) {
        return staffValue;
      }

      if (isValidObjectId(staffValue)) {
        const stringId = objectIdToString(staffValue);
        try {
          const user = await User.findById(stringId, { displayName: 1, username: 1 }).lean();
          const result = user ? (user.displayName || user.username) : staffValue;
          return result;
        } catch (error) {
          console.warn(`Failed to fetch user ${stringId}:`, error);
          return staffValue;
        }
      }

      // If not an ObjectId, return as is (already a display name or text)
      return staffValue;
    };

    // Helper function to process a staff array (for novels)
    const processStaffArray = async (staffArray, arrayName) => {
      if (!Array.isArray(staffArray) || staffArray.length === 0) {
        return staffArray;
      }

      // Separate ObjectIds from text strings
      const objectIds = [];
      const textItems = [];
      const indexMap = {}; // To track original positions

      staffArray.forEach((item, index) => {
        if (isValidObjectId(item)) {
          const stringId = objectIdToString(item);
          objectIds.push(stringId);
          indexMap[stringId] = index;
        } else {
          textItems.push({ index, value: item });
        }
      });

      // If no ObjectIds to populate, return original array
      if (objectIds.length === 0) {
        return staffArray;
      }

      // Fetch user data for all ObjectIds in one query
      const users = await User.find(
        { _id: { $in: objectIds } },
        { displayName: 1, username: 1 }
      ).lean();

      // Create a map of ObjectId to display name
      const userMap = {};
      users.forEach(user => {
        userMap[user._id.toString()] = user.displayName || user.username;
      });

      // Rebuild the array with populated names
      const result = [...staffArray];
      objectIds.forEach(objectId => {
        const index = indexMap[objectId];
        const displayName = userMap[objectId];
        if (displayName) {
          result[index] = displayName;
        }
        // If user not found, keep the ObjectId as fallback
      });

      return result;
    };

    // Create a copy of the object to avoid mutating the original
    const populatedObj = { ...obj };

    // Check if this is a novel object (has active/inactive staff arrays)
    if (obj.active || obj.inactive) {
      // Process active staff
      if (obj.active) {
        populatedObj.active = {};
        for (const role of ['pj_user', 'translator', 'editor', 'proofreader']) {
          if (obj.active[role]) {
            populatedObj.active[role] = await processStaffArray(obj.active[role], `active.${role}`);
          }
        }
      }

      // Process inactive staff (usually just text, but check anyway)
      if (obj.inactive) {
        populatedObj.inactive = {};
        for (const role of ['pj_user', 'translator', 'editor', 'proofreader']) {
          if (obj.inactive[role]) {
            populatedObj.inactive[role] = await processStaffArray(obj.inactive[role], `inactive.${role}`);
          }
        }
      }
    }

    // Check if this is a chapter object (has individual staff fields)
    const chapterStaffFields = ['translator', 'editor', 'proofreader'];
    const hasChapterStaffFields = chapterStaffFields.some(field => obj.hasOwnProperty(field));
    
    if (hasChapterStaffFields) {
      // Process individual staff fields for chapters
      for (const field of chapterStaffFields) {
        if (obj.hasOwnProperty(field)) {
          populatedObj[field] = await processStaffField(obj[field]);
        }
      }
    }

    return populatedObj;
  } catch (error) {
    console.error('❌ Error in populateStaffNames:', error);
    // Return original object on error to prevent breaking the API
    return obj;
  }
}; 