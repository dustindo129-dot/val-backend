import mongoose from 'mongoose';
import User from '../models/User.js';

/**
 * Populates staff ObjectIds with user display names
 * Handles mixed data (ObjectIds and plain text strings)
 * @param {Object} novel - Novel object with active/inactive staff
 * @returns {Object} Novel object with populated staff names
 */
export const populateStaffNames = async (novel) => {
  try {
    if (!novel || (!novel.active && !novel.inactive)) {
      return novel;
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

    // Helper function to process a staff array
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

    // Create a copy of the novel to avoid mutating the original
    const populatedNovel = { ...novel };

    // Process active staff
    if (novel.active) {
      populatedNovel.active = {};
      for (const role of ['pj_user', 'translator', 'editor', 'proofreader']) {
        if (novel.active[role]) {
          populatedNovel.active[role] = await processStaffArray(novel.active[role], `active.${role}`);
        }
      }
    }

    // Process inactive staff (usually just text, but check anyway)
    if (novel.inactive) {
      populatedNovel.inactive = {};
      for (const role of ['pj_user', 'translator', 'editor', 'proofreader']) {
        if (novel.inactive[role]) {
          populatedNovel.inactive[role] = await processStaffArray(novel.inactive[role], `inactive.${role}`);
        }
      }
    }

    return populatedNovel;
  } catch (error) {
    console.error('❌ Error in populateStaffNames:', error);
    // Return original novel on error to prevent breaking the API
    return novel;
  }
}; 