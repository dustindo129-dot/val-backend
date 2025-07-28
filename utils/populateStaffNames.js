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

    // Collect all unique ObjectIds from the entire object first
    const allObjectIds = new Set();
    
    // Helper function to collect ObjectIds from a value
    const collectObjectIds = (value) => {
      if (isValidObjectId(value)) {
        const stringId = objectIdToString(value);
        allObjectIds.add(stringId);
      } else if (Array.isArray(value)) {
        value.forEach(item => {
          if (isValidObjectId(item)) {
            const stringId = objectIdToString(item);
            allObjectIds.add(stringId);
          }
        });
      }
    };

    // Collect ObjectIds from novel staff arrays
    if (obj.active) {
      for (const role of ['pj_user', 'translator', 'editor', 'proofreader']) {
        if (obj.active[role]) {
          collectObjectIds(obj.active[role]);
        }
      }
    }
    if (obj.inactive) {
      for (const role of ['pj_user', 'translator', 'editor', 'proofreader']) {
        if (obj.inactive[role]) {
          collectObjectIds(obj.inactive[role]);
        }
      }
    }

    // Collect ObjectIds from chapter staff fields
    const chapterStaffFields = ['translator', 'editor', 'proofreader'];
    for (const field of chapterStaffFields) {
      if (obj.hasOwnProperty(field)) {
        collectObjectIds(obj[field]);
      }
    }

    // If no ObjectIds found, return original object
    if (allObjectIds.size === 0) {
      return obj;
    }

    // Fetch all users in one batched query
    const users = await User.find(
      { _id: { $in: Array.from(allObjectIds) } },
      { displayName: 1, username: 1, userNumber: 1, avatar: 1, role: 1 }
    ).lean();

    // Create user lookup map
    const userMap = {};
    users.forEach(user => {
      userMap[user._id.toString()] = user;
    });

    // Helper function to process a single staff field (for chapters)
    const processStaffField = (staffValue) => {
      if (!staffValue) {
        return staffValue;
      }

      if (isValidObjectId(staffValue)) {
        const stringId = objectIdToString(staffValue);
        const userObj = userMap[stringId];
        // For chapters, still return display name for backward compatibility
        return userObj ? (userObj.displayName || userObj.username) : staffValue;
      }

      // If not an ObjectId, return as is (already a display name or text)
      return staffValue;
    };

    // Helper function to process a staff array (for novels)
    const processStaffArray = (staffArray) => {
      if (!Array.isArray(staffArray) || staffArray.length === 0) {
        return staffArray;
      }

      const result = staffArray.map(item => {
        if (isValidObjectId(item)) {
          const stringId = objectIdToString(item);
          const userObj = userMap[stringId];
          // For novels, return full user object if available, otherwise fallback to original
          return userObj || item;
        }
        return item; // Keep text items as is
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
            populatedObj.active[role] = processStaffArray(obj.active[role]);
          }
        }
      }

      // Process inactive staff
      if (obj.inactive) {
        populatedObj.inactive = {};
        for (const role of ['pj_user', 'translator', 'editor', 'proofreader']) {
          if (obj.inactive[role]) {
            populatedObj.inactive[role] = processStaffArray(obj.inactive[role]);
          }
        }
      }
    }

    // Check if this is a chapter object (has individual staff fields)
    const hasChapterStaffFields = chapterStaffFields.some(field => obj.hasOwnProperty(field));
    
    if (hasChapterStaffFields) {
      // Process individual staff fields for chapters
      for (const field of chapterStaffFields) {
        if (obj.hasOwnProperty(field)) {
          populatedObj[field] = processStaffField(obj[field]);
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