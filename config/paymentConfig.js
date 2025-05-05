/**
 * Payment Gateway Configurations
 * 
 * IMPORTANT: In a real production environment, 
 * these values should be loaded from environment variables
 */

const paymentConfig = {
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
    serviceName: 'Valvrareteam'
  }
};

export default paymentConfig; 