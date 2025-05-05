import crypto from 'crypto';
import paymentConfig from '../config/paymentConfig.js';

/**
 * Generate a hash for card validation
 * 
 * @param {string} provider - Card provider name
 * @param {string} cardNumber - Card number/serial
 * @param {string} cardPin - Card PIN
 * @returns {string} Hash for validation
 */
export const generateCardValidationHash = (provider, cardNumber, cardPin) => {
  const providerConfig = paymentConfig.cardProviders[provider];
  if (!providerConfig) {
    throw new Error(`Unknown card provider: ${provider}`);
  }
  
  const dataToHash = `${providerConfig.partnerId}|${cardNumber}|${cardPin}|${providerConfig.secretKey}`;
  
  return crypto
    .createHash('sha256')
    .update(dataToHash)
    .digest('hex');
};

/**
 * Generate a unique transaction ID
 * 
 * @param {string} prefix - Optional prefix for the transaction ID
 * @returns {string} Unique transaction ID
 */
export const generateTransactionId = (prefix = '') => {
  const timestamp = Date.now().toString();
  const random = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
  return `${prefix}${timestamp}${random}`;
};

/**
 * Format currency amount
 * 
 * @param {number} amount - Amount to format
 * @param {string} currency - Currency code (default: VND)
 * @returns {string} Formatted currency amount
 */
export const formatCurrency = (amount, currency = 'VND') => {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: currency
  }).format(amount);
};

/**
 * Get bank account information
 * 
 * @returns {Object} Bank account details for display
 */
export const getBankAccountInfo = () => {
  const account = paymentConfig.bankAccounts.primary;
  return {
    bank: account.bank,
    accountNumber: account.accountNumber,
    accountName: account.accountName,
    branchName: account.branchName || 'Main Branch'
  };
}; 