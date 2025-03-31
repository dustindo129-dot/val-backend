import axios from 'axios';

/**
 * Middleware to validate reCAPTCHA tokens
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export const validateRecaptcha = async (req, res, next) => {
  try {
    const { recaptchaToken } = req.body;

    if (!recaptchaToken) {
      return res.status(400).json({ message: 'reCAPTCHA token is required' });
    }

    // Verify token with Google
    const response = await axios.post(
      'https://www.google.com/recaptcha/api/siteverify',
      null,
      {
        params: {
          secret: process.env.RECAPTCHA_SECRET_KEY,
          response: recaptchaToken
        }
      }
    );

    if (!response.data.success) {
      return res.status(400).json({ message: 'Invalid reCAPTCHA token' });
    }

    // Check if score is above threshold (0.5 is recommended)
    if (response.data.score < 0.5) {
      return res.status(400).json({ message: 'reCAPTCHA score too low' });
    }

    next();
  } catch (error) {
    console.error('reCAPTCHA validation error:', error);
    res.status(500).json({ message: 'Failed to validate reCAPTCHA' });
  }
}; 