import mongoose from 'mongoose';
import User from '../models/User.js';
import { batchGetUsers } from './batchUserCache.js';

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

    // Define staff fields array for reuse
    const chapterStaffFields = ['translator', 'editor', 'proofreader'];

    // Collect ObjectIds from chapter staff fields
    for (const field of chapterStaffFields) {
      if (obj.hasOwnProperty(field)) {
        collectObjectIds(obj[field]);
      }
    }

    // Collect ObjectIds from author field (for both novels and chapters)
    if (obj.author) {
      collectObjectIds(obj.author);
    }

    // Collect author strings that might match usernames/displayNames (only for Vietnamese novels)
    const authorStringsToMatch = new Set();
    if (obj.author && typeof obj.author === 'string' && !isValidObjectId(obj.author)) {
      // Only perform author matching for Vietnamese novels to avoid unnecessary database queries
      const isVietnameseNovel = obj.genres && Array.isArray(obj.genres) && 
        obj.genres.some(genre => typeof genre === 'string' && genre.includes('Vietnamese Novel'));
      
      if (isVietnameseNovel) {
        authorStringsToMatch.add(obj.author.trim());
      }
    }

    // Collect staff strings that might match usernames/displayNames/userNumbers
    const staffStringsToMatch = new Set();
    for (const field of chapterStaffFields) {
      if (obj.hasOwnProperty(field) && obj[field] && typeof obj[field] === 'string' && !isValidObjectId(obj[field])) {
        staffStringsToMatch.add(obj[field].trim());
      }
    }

    // If no ObjectIds or strings to match found, return original object
    if (allObjectIds.size === 0 && authorStringsToMatch.size === 0 && staffStringsToMatch.size === 0) {
      return obj;
    }

    // Build query conditions
    const queryConditions = [];
    
    // Add ObjectId conditions
    if (allObjectIds.size > 0) {
      queryConditions.push({ _id: { $in: Array.from(allObjectIds) } });
    }
    
    // Add author string matching conditions (case-insensitive)
    if (authorStringsToMatch.size > 0) {
      const authorStrings = Array.from(authorStringsToMatch);
      const regexConditions = authorStrings.map(authorString => ({
        $or: [
          { displayName: { $regex: new RegExp(`^${authorString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
          { username: { $regex: new RegExp(`^${authorString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } }
        ]
      }));
      
      if (regexConditions.length === 1) {
        queryConditions.push(regexConditions[0]);
      } else {
        queryConditions.push({ $or: regexConditions });
      }
    }

    // Add staff string matching conditions (case-insensitive, including userNumber)
    if (staffStringsToMatch.size > 0) {
      const staffStrings = Array.from(staffStringsToMatch);
      const regexConditions = staffStrings.map(staffString => ({
        $or: [
          { displayName: { $regex: new RegExp(`^${staffString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
          { username: { $regex: new RegExp(`^${staffString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
          { userNumber: { $regex: new RegExp(`^${staffString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } }
        ]
      }));
      
      if (regexConditions.length === 1) {
        queryConditions.push(regexConditions[0]);
      } else {
        queryConditions.push({ $or: regexConditions });
      }
    }

    // Use batch cache lookup instead of direct database query
    const allIdentifiers = [...allObjectIds, ...authorStringsToMatch, ...staffStringsToMatch];
    const userLookupResult = await batchGetUsers(allIdentifiers, {
      projection: { displayName: 1, username: 1, userNumber: 1, avatar: 1, role: 1 }
    });

    // Create user lookup maps from batch result
    const userMap = {}; // ObjectId -> User
    const userNameMap = {}; // displayName/username/userNumber -> User (case-insensitive)
    
    Object.values(userLookupResult).forEach(user => {
      if (user && user._id) {
        userMap[user._id.toString()] = user;
        // Also map by displayName, username, and userNumber for string matching (case-insensitive)
        if (user.displayName) {
          userNameMap[user.displayName.toLowerCase()] = user;
        }
        if (user.username) {
          userNameMap[user.username.toLowerCase()] = user;
        }
        if (user.userNumber) {
          userNameMap[user.userNumber.toString().toLowerCase()] = user;
        }
      }
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

      // If not an ObjectId, try to find user by username/displayName/userNumber
      if (typeof staffValue === 'string') {
        const userObj = userNameMap[staffValue.toLowerCase()];
        if (userObj) {
          // Return display name if available, otherwise username
          return userObj.displayName || userObj.username;
        }
      }

      // If no user found, return as is (already a display name or text)
      return staffValue;
    };

    // Helper function to process a staff array (for novels)
    const processStaffArray = (staffArray) => {
      // FIXED: Always return arrays as arrays, even if empty or undefined
      if (!Array.isArray(staffArray)) {
        return staffArray; // Return undefined/null as is
      }
      
      if (staffArray.length === 0) {
        return []; // Return empty array as empty array
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
          // FIXED: Always preserve the role, even if it's empty or undefined
          if (obj.active.hasOwnProperty(role)) {
            populatedObj.active[role] = processStaffArray(obj.active[role]);
          }
        }
      }

      // Process inactive staff
      if (obj.inactive) {
        populatedObj.inactive = {};
        for (const role of ['pj_user', 'translator', 'editor', 'proofreader']) {
          // FIXED: Always preserve the role, even if it's empty or undefined
          if (obj.inactive.hasOwnProperty(role)) {
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

    // Process author field (for both novels and chapters)
    if (obj.author) {
      if (isValidObjectId(obj.author)) {
        const stringId = objectIdToString(obj.author);
        const userObj = userMap[stringId];

        // Return full user object if available, otherwise fallback to original
        populatedObj.author = userObj || obj.author;
      } else if (typeof obj.author === 'string') {
        // Only try to match by displayName or username for Vietnamese novels
        const isVietnameseNovel = obj.genres && Array.isArray(obj.genres) && 
          obj.genres.some(genre => typeof genre === 'string' && genre.includes('Vietnamese Novel'));
        
        if (isVietnameseNovel) {
          // Try to match by displayName or username (case-insensitive)
          const authorString = obj.author.trim();
          const userObj = userNameMap[authorString.toLowerCase()];
          if (userObj) {
            // Create a hybrid object that preserves the original text but includes user data for linking
            populatedObj.author = {
              ...userObj,
              originalText: authorString // Preserve the original capitalization
            };
          } else {
            // Keep as string if no user found
            populatedObj.author = obj.author;
          }
        } else {
          // For non-Vietnamese novels, always keep as plain string
          populatedObj.author = obj.author;
        }
      } else {
        // Keep as is for any other type
        populatedObj.author = obj.author;
      }
    }

    return populatedObj;
  } catch (error) {
    console.error('❌ Error in populateStaffNames:', error);
    // Return original object on error to prevent breaking the API
    return obj;
  }
}; 