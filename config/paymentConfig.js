/**
 * Payment Gateway Configurations
 * 
 * IMPORTANT: In a real production environment, 
 * these values should be loaded from environment variables
 */

const paymentConfig = {
  momo: {
    partnerCode: process.env.MOMO_PARTNER_CODE || 'MOMOXYZ123',
    accessKey: process.env.MOMO_ACCESS_KEY || 'test_access_key',
    secretKey: process.env.MOMO_SECRET_KEY || 'test_secret_key',
    environment: process.env.NODE_ENV || 'development',
    apiUrl: process.env.NODE_ENV === 'production' 
      ? 'https://payment.momo.vn/v2/gateway/api'
      : 'https://test-payment.momo.vn/v2/gateway/api'
  },
  
  zalopay: {
    appId: process.env.ZALOPAY_APP_ID || '123456789',
    key1: process.env.ZALOPAY_KEY1 || 'test_key1',
    key2: process.env.ZALOPAY_KEY2 || 'test_key2',
    environment: process.env.NODE_ENV || 'development',
    apiUrl: process.env.NODE_ENV === 'production'
      ? 'https://api.zalopay.vn/v2'
      : 'https://sandbox.zalopay.vn/v2'
  },
  
  bankAccounts: {
    primary: {
      bank: process.env.BANK_NAME || 'Example Bank',
      accountNumber: process.env.BANK_ACCOUNT_NUMBER || '1234567890',
      accountName: process.env.BANK_ACCOUNT_NAME || 'Your Company Name',
      branchName: process.env.BANK_BRANCH_NAME || 'Main Branch'
    }
  },
  
  cardProviders: {
    viettel: {
      partnerId: process.env.VIETTEL_PARTNER_ID || 'viettel_partner_123',
      secretKey: process.env.VIETTEL_SECRET_KEY || 'viettel_secret_key',
      apiUrl: process.env.VIETTEL_API_URL || 'https://api.example.com/viettel'
    },
    mobiphone: {
      partnerId: process.env.MOBIPHONE_PARTNER_ID || 'mobiphone_partner_123',
      secretKey: process.env.MOBIPHONE_SECRET_KEY || 'mobiphone_secret_key',
      apiUrl: process.env.MOBIPHONE_API_URL || 'https://api.example.com/mobiphone'
    },
    vinaphone: {
      partnerId: process.env.VINAPHONE_PARTNER_ID || 'vinaphone_partner_123',
      secretKey: process.env.VINAPHONE_SECRET_KEY || 'vinaphone_secret_key',
      apiUrl: process.env.VINAPHONE_API_URL || 'https://api.example.com/vinaphone'
    }
  },
  
  app: {
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
    backendUrl: process.env.BACKEND_URL || 'http://localhost:5000',
    serviceName: 'Val-JS Reading Platform'
  }
};

export default paymentConfig; 