import axios from 'axios';
import paymentConfig from '../config/paymentConfig.js';
import { createMomoSignature, createZaloPaySignature, generateTransactionId } from '../utils/paymentUtils.js';

/**
 * Create a payment request to MoMo
 * 
 * @param {string} userId - User ID making the payment
 * @param {string} orderId - Order/request ID in our system
 * @param {number} amount - Payment amount (in VND)
 * @param {string} orderInfo - Description of the payment
 * @returns {Promise<Object>} Response containing payment URL and transaction info
 */
export const createMomoPayment = async (userId, orderId, amount, orderInfo = 'Top-up payment') => {
  try {
    const requestId = generateTransactionId('MOMO');
    
    // Prepare payment request data
    const paymentData = {
      partnerCode: paymentConfig.momo.partnerCode,
      accessKey: paymentConfig.momo.accessKey,
      requestId: requestId,
      amount: amount,
      orderId: orderId,
      orderInfo: orderInfo,
      returnUrl: `${paymentConfig.app.frontendUrl}/payment/callback`,
      notifyUrl: `${paymentConfig.app.backendUrl}/api/webhook/momo`,
      extraData: Buffer.from(JSON.stringify({ userId })).toString('base64'),
      requestType: 'captureWallet'
    };
    
    // Generate signature
    paymentData.signature = createMomoSignature(paymentData);
    
    // Send request to MoMo
    const response = await axios.post(
      `${paymentConfig.momo.apiUrl}/create`,
      paymentData
    );
    
    // Check response
    if (response.data.resultCode !== 0) {
      throw new Error(`MoMo payment creation failed: ${response.data.message}`);
    }
    
    return {
      success: true,
      paymentUrl: response.data.payUrl,
      requestId: requestId,
      orderId: orderId,
      transactionId: response.data.transId || null
    };
  } catch (error) {
    console.error('MoMo payment creation error:', error);
    return {
      success: false,
      error: error.message || 'Failed to create MoMo payment'
    };
  }
};

/**
 * Create a payment request to ZaloPay
 * 
 * @param {string} userId - User ID making the payment
 * @param {string} orderId - Order/request ID in our system
 * @param {number} amount - Payment amount (in VND)
 * @param {string} description - Description of the payment
 * @returns {Promise<Object>} Response containing payment URL and transaction info
 */
export const createZaloPayPayment = async (userId, orderId, amount, description = 'Top-up payment') => {
  try {
    const appTransId = generateTransactionId('ZLP');
    const appTime = Date.now(); // milliseconds
    
    // Prepare embedded data and items
    const embedData = JSON.stringify({
      redirecturl: `${paymentConfig.app.frontendUrl}/payment/callback`
    });
    
    const item = JSON.stringify([{
      itemid: orderId,
      itemname: 'Account Balance Top-up',
      itemprice: amount,
      itemquantity: 1
    }]);
    
    // Prepare payment request data
    const paymentData = {
      app_id: paymentConfig.zalopay.appId,
      app_trans_id: appTransId,
      app_user: userId,
      app_time: appTime,
      amount: amount,
      item: item,
      description: description,
      embed_data: embedData,
      bank_code: 'zalopayapp',
      callback_url: `${paymentConfig.app.backendUrl}/api/webhook/zalopay`
    };
    
    // Generate signature
    const dataToSign = {
      appId: paymentData.app_id,
      appTransId: paymentData.app_trans_id,
      appUser: paymentData.app_user,
      amount: paymentData.amount,
      appTime: paymentData.app_time,
      embedData: paymentData.embed_data,
      item: paymentData.item
    };
    
    paymentData.mac = createZaloPaySignature(dataToSign);
    
    // Send request to ZaloPay
    const response = await axios.post(
      `${paymentConfig.zalopay.apiUrl}/create`,
      paymentData
    );
    
    // Check response
    if (response.data.return_code !== 1) {
      throw new Error(`ZaloPay payment creation failed: ${response.data.return_message}`);
    }
    
    return {
      success: true,
      paymentUrl: response.data.order_url,
      requestId: appTransId,
      orderId: orderId,
      transactionId: response.data.zp_trans_id || null
    };
  } catch (error) {
    console.error('ZaloPay payment creation error:', error);
    return {
      success: false,
      error: error.message || 'Failed to create ZaloPay payment'
    };
  }
};

/**
 * Check MoMo payment status
 * 
 * @param {string} orderId - Order ID
 * @param {string} requestId - Request ID
 * @returns {Promise<Object>} Payment status information
 */
export const checkMomoPaymentStatus = async (orderId, requestId) => {
  try {
    const queryData = {
      partnerCode: paymentConfig.momo.partnerCode,
      requestId: generateTransactionId('MOMO_QUERY'), // New request ID for the query
      orderId: orderId,
      lang: 'vi'
    };
    
    // Calculate signature for the query
    const rawSignature = `accessKey=${paymentConfig.momo.accessKey}&orderId=${orderId}&partnerCode=${paymentConfig.momo.partnerCode}&requestId=${queryData.requestId}`;
    queryData.signature = crypto
      .createHmac('sha256', paymentConfig.momo.secretKey)
      .update(rawSignature)
      .digest('hex');
    
    // Send status check request to MoMo
    const response = await axios.post(
      `${paymentConfig.momo.apiUrl}/query`,
      queryData
    );
    
    return {
      success: true,
      status: response.data.resultCode === 0 ? 'Completed' : 'Failed',
      message: response.data.message,
      amount: response.data.amount,
      transactionId: response.data.transId,
      payType: response.data.payType,
      responseData: response.data
    };
  } catch (error) {
    console.error('MoMo payment status check error:', error);
    return {
      success: false,
      status: 'Unknown',
      error: error.message || 'Failed to check payment status'
    };
  }
};

/**
 * Check ZaloPay payment status
 * 
 * @param {string} appTransId - App transaction ID
 * @returns {Promise<Object>} Payment status information
 */
export const checkZaloPayPaymentStatus = async (appTransId) => {
  try {
    // Prepare query data
    const queryData = {
      app_id: paymentConfig.zalopay.appId,
      app_trans_id: appTransId
    };
    
    // Generate MAC for the query
    const dataToHash = `${queryData.app_id}|${queryData.app_trans_id}|${paymentConfig.zalopay.key1}`;
    queryData.mac = crypto.createHmac('sha256', paymentConfig.zalopay.key1)
      .update(dataToHash)
      .digest('hex');
    
    // Send status check request to ZaloPay
    const response = await axios.post(
      `${paymentConfig.zalopay.apiUrl}/query`,
      queryData
    );
    
    return {
      success: true,
      status: response.data.return_code === 1 ? 'Completed' : 'Failed',
      message: response.data.return_message,
      amount: response.data.amount,
      transactionId: response.data.zp_trans_id,
      responseData: response.data
    };
  } catch (error) {
    console.error('ZaloPay payment status check error:', error);
    return {
      success: false,
      status: 'Unknown',
      error: error.message || 'Failed to check payment status'
    };
  }
}; 