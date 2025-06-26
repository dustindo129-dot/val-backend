import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Email service for sending transactional emails
 * Uses nodemailer with SMTP configuration from environment variables
 */

// Validate required environment variables
const requiredEnvVars = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'FRONTEND_URL'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('Missing required environment variables:', missingEnvVars);
  throw new Error(`Missing required environment variables: ${missingEnvVars.join(', ')}`);
}

// Create reusable transporter object using SMTP transport
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT, 10),
  secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Verify transporter configuration
transporter.verify()
  .then(() => console.log('SMTP connection established successfully'))
  .catch(error => {
    console.error('SMTP connection error:', error);
    throw error;
  });

/**
 * Send password reset email
 * @param {string} to - Recipient email address
 * @param {string} resetToken - Password reset token
 * @returns {Promise} Nodemailer send mail promise
 */
export const sendPasswordResetEmail = async (to, resetToken) => {
  try {
    console.log('Attempting to send password reset email to:', to);
    
    // Create reset password URL
    const resetUrl = `${process.env.FRONTEND_URL}/phuc-hoi-mat-khau/${resetToken}`;
    console.log('Reset URL:', resetUrl);

    // Email content
    const mailOptions = {
      from: process.env.SMTP_FROM,
      to,
      subject: 'Password Reset Request',
      html: `
        <h1>Password Reset Request</h1>
        <p>You requested a password reset. Click the link below to reset your password:</p>
        <a href="${resetUrl}" style="
          display: inline-block;
          padding: 10px 20px;
          background-color: #0099ff;
          color: white;
          text-decoration: none;
          border-radius: 5px;
          margin: 20px 0;
        ">Reset Password</a>
        <p>If you didn't request this, please ignore this email.</p>
        <p>This link will expire in 30 minutes.</p>
        <p>Note: This is an automated email. Please do not reply to this message.</p>
      `,
    };

    // Send email
    const info = await transporter.sendMail(mailOptions);
    console.log('Password reset email sent successfully:', info.messageId);
    return info;
  } catch (error) {
    console.error('Failed to send password reset email:', error);
    throw new Error('Failed to send password reset email: ' + error.message);
  }
};

/**
 * Send email change confirmation email
 * @param {string} to - Current email address
 * @param {string} newEmail - New email address to change to
 * @param {string} confirmationToken - Email change confirmation token
 * @returns {Promise} Nodemailer send mail promise
 */
export const sendEmailChangeConfirmation = async (to, newEmail, confirmationToken) => {
  try {
    console.log('Attempting to send email change confirmation to:', to);
    
    // Create confirmation URL
    const confirmationUrl = `${process.env.FRONTEND_URL}/xac-nhan-email/${confirmationToken}`;
    console.log('Email change confirmation URL:', confirmationUrl);

    // Email content
    const mailOptions = {
      from: process.env.SMTP_FROM,
      to,
      subject: 'Xác nhận thay đổi địa chỉ email - Valvrareteam',
      html: `
        <h1>Xác nhận thay đổi địa chỉ email</h1>
        <p>Bạn đã yêu cầu thay đổi địa chỉ email từ <strong>${to}</strong> sang <strong>${newEmail}</strong>.</p>
        <p>Để xác nhận thay đổi này, vui lòng nhấp vào liên kết bên dưới:</p>
        <a href="${confirmationUrl}" style="
          display: inline-block;
          padding: 12px 24px;
          background-color: #0099ff;
          color: white;
          text-decoration: none;
          border-radius: 5px;
          margin: 20px 0;
          font-weight: bold;
        ">Xác nhận thay đổi email</a>
        <p><strong>Lưu ý quan trọng:</strong></p>
        <ul>
          <li>Nếu bạn không yêu cầu thay đổi này, vui lòng bỏ qua email này và thay đổi mật khẩu của bạn ngay lập tức.</li>
          <li>Liên kết này sẽ hết hạn sau 30 phút.</li>
          <li>Sau khi xác nhận, địa chỉ email cũ sẽ không thể được sử dụng để đăng nhập.</li>
        </ul>
        <p>Đây là email tự động. Vui lòng không trả lời email này.</p>
        <hr>
        <p><small>Email này được gửi từ Valvrareteam - Website đọc truyện hàng đầu Việt Nam</small></p>
      `,
    };

    // Send email
    const info = await transporter.sendMail(mailOptions);
    console.log('Email change confirmation sent successfully:', info.messageId);
    return info;
  } catch (error) {
    console.error('Failed to send email change confirmation:', error);
    throw new Error('Failed to send email change confirmation: ' + error.message);
  }
}; 