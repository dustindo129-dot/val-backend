import axios from 'axios';
import paymentConfig from '../config/paymentConfig.js';
import { generateCardValidationHash, generateTransactionId } from '../utils/paymentUtils.js';

/**
 * Validate a prepaid card with the card provider's API
 * 
 * @param {string} provider - Card provider name (viettel, mobifone, vinaphone, etc.)
 * @param {string} cardNumber - Card number/serial
 * @param {string} cardPin - Card PIN
 * @returns {Promise<Object>} Validation result with card information
 */
export const validatePrepaidCard = async (provider, cardNumber, cardPin) => {
  try {
    // Get provider configuration
    const providerConfig = paymentConfig.cardProviders[provider];
    if (!providerConfig) {
      throw new Error(`Unknown card provider: ${provider}`);
    }
    
    // Generate validation hash
    const secureHash = generateCardValidationHash(provider, cardNumber, cardPin);
    
    // Create transaction ID
    const transactionId = generateTransactionId(`CARD_${provider.toUpperCase()}_`);
    
    // Prepare validation request
    const validationData = {
      partner_id: providerConfig.partnerId,
      transaction_id: transactionId,
      card_number: cardNumber,
      card_pin: cardPin,
      secure_hash: secureHash
    };
    
    // In a real implementation, send request to card provider API
    // For demonstration, we're simulating the API response
    
    // DEMO ONLY: Simulate API call (replace with actual API call in production)
    let simulatedResponse;
    
    // For demo: consider cards ending with "1111" as valid
    if (cardNumber.endsWith('1111')) {
      simulatedResponse = {
        status: 'success',
        transaction_id: transactionId,
        card_value: determineCardValue(cardNumber),
        message: 'Card validated successfully'
      };
    } else {
      simulatedResponse = {
        status: 'failed',
        transaction_id: transactionId,
        message: 'Invalid card or PIN'
      };
    }
    
    // Return validation result
    return {
      valid: simulatedResponse.status === 'success',
      amount: simulatedResponse.card_value || 0,
      transactionId: transactionId,
      message: simulatedResponse.message,
      provider: provider,
      cardNumber: maskCardNumber(cardNumber)
    };
    
    /* PRODUCTION CODE - Uncomment for real implementation
    // Send request to card provider API
    const response = await axios.post(`${providerConfig.apiUrl}/validate`, validationData);
    
    // Process response
    return {
      valid: response.data.status === 'success',
      amount: response.data.card_value || 0,
      transactionId: transactionId,
      message: response.data.message,
      provider: provider,
      cardNumber: maskCardNumber(cardNumber)
    };
    */
  } catch (error) {
    console.error('Card validation error:', error);
    return {
      valid: false,
      amount: 0,
      message: error.message || 'Card validation failed',
      provider: provider
    };
  }
};

/**
 * For demo purposes: Determine card value based on card number
 * In production, this would come from the card provider's API
 * 
 * @param {string} cardNumber - Card number/serial
 * @returns {number} Card value in VND
 */
const determineCardValue = (cardNumber) => {
  // For demo: use last 6 digits to determine value
  const lastSix = cardNumber.slice(-6);
  
  if (lastSix.startsWith('10')) return 10000;
  if (lastSix.startsWith('20')) return 20000;
  if (lastSix.startsWith('50')) return 50000;
  if (lastSix.startsWith('100')) return 100000;
  if (lastSix.startsWith('200')) return 200000;
  if (lastSix.startsWith('500')) return 500000;
  
  // Default value
  return 10000;
};

/**
 * Mask the card number for security when displaying/storing
 * 
 * @param {string} cardNumber - Full card number/serial
 * @returns {string} Masked card number
 */
const maskCardNumber = (cardNumber) => {
  if (cardNumber.length <= 6) {
    return '******';
  }
  
  const firstThree = cardNumber.slice(0, 3);
  const lastThree = cardNumber.slice(-3);
  const middleLength = cardNumber.length - 6;
  const maskedMiddle = '*'.repeat(middleLength);
  
  return `${firstThree}${maskedMiddle}${lastThree}`;
}; 