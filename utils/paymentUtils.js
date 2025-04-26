import crypto from 'crypto';
import paymentConfig from '../config/paymentConfig.js';

/**
 * Generate a signature for Momo payment requests
 * 
 * @param {Object} data - Payment data to sign
 * @returns {string} Signature hash
 */
export const createMomoSignature = (data) => {
  const { partnerCode, accessKey, requestId, amount, orderId, orderInfo, returnUrl, notifyUrl, extraData } = data;
  
  // Create the raw signature string according to Momo's specifications
  const rawSignature = `accessKey=${accessKey}&amount=${amount}&extraData=${extraData}&ipnUrl=${notifyUrl}&orderId=${orderId}&orderInfo=${orderInfo}&partnerCode=${partnerCode}&requestId=${requestId}&returnUrl=${returnUrl}`;
  
  // Create HMAC SHA256 signature
  const signature = crypto
    .createHmac('sha256', paymentConfig.momo.secretKey)
    .update(rawSignature)
    .digest('hex');
    
  return signature;
};

/**
 * Verify the signature of a Momo payment response
 * 
 * @param {Object} data - Response data from Momo
 * @returns {boolean} True if signature is valid
 */
export const verifyMomoSignature = (data) => {
  const { partnerCode, accessKey, requestId, amount, orderId, orderInfo, orderType, 
          transId, errorCode, message, localMessage, payType, responseTime, 
          extraData, signature } = data;
  
  // Create the raw signature string according to Momo's specifications for responses
  const rawSignature = `accessKey=${accessKey}&amount=${amount}&extraData=${extraData}&message=${message}&orderId=${orderId}&orderInfo=${orderInfo}&orderType=${orderType}&partnerCode=${partnerCode}&payType=${payType}&requestId=${requestId}&responseTime=${responseTime}&resultCode=${errorCode}&transId=${transId}`;
  
  // Create HMAC SHA256 signature
  const expectedSignature = crypto
    .createHmac('sha256', paymentConfig.momo.secretKey)
    .update(rawSignature)
    .digest('hex');
    
  return expectedSignature === signature;
};

/**
 * Generate a signature for ZaloPay payment requests
 * 
 * @param {Object} data - Payment data to sign
 * @returns {string} Signature hash
 */
export const createZaloPaySignature = (data) => {
  const { appId, appTime, appTransId, appUser, amount, embedData, item } = data;
  
  // Create the raw signature string according to ZaloPay's specifications
  const rawSignature = `${appId}|${appTransId}|${appUser}|${amount}|${appTime}|${embedData}|${item}`;
  
  // Create HMAC SHA256 signature
  const signature = crypto
    .createHmac('sha256', paymentConfig.zalopay.key1)
    .update(rawSignature)
    .digest('hex');
    
  return signature;
};

/**
 * Verify the signature of a ZaloPay payment response
 * 
 * @param {Object} data - Response data from ZaloPay
 * @returns {boolean} True if signature is valid
 */
export const verifyZaloPaySignature = (data) => {
  const { appId, transId, appTransId, amount, timestamp, embedData, status } = data;
  
  // Recreate the MAC string based on ZaloPay documentation
  const macData = `${appId}|${appTransId}|${transId}|${amount}|${status}|${timestamp}|${embedData}`;
  
  // Calculate expected MAC value
  const expectedMac = crypto
    .createHmac('sha256', paymentConfig.zalopay.key2)
    .update(macData)
    .digest('hex');
    
  return expectedMac === data.mac;
};

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