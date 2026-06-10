const { Resend } = require('resend');

// Initialize Resend with API Key from environment variables
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

exports.sendEmail = async (to, subject, text, html) => {
  if (!resend) {
    throw new Error('Mailer not configured: Missing RESEND_API_KEY');
  }

  try {
    const data = await resend.emails.send({
      from: process.env.MAIL_FROM || 'onboarding@resend.dev',
      to: to,
      subject: subject,
      text: text,
      html: html,
    });

    if (data.error) {
      throw new Error(data.error.message);
    }

    return data;
  } catch (error) {
    console.error('Resend Email Error:', error);
    throw error;
  }
};
