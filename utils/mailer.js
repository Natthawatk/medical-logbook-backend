const { google } = require('googleapis');
const nodemailer = require('nodemailer');

/**
 * Send email using Gmail API with OAuth2
 * This method is reliable on cloud providers like Render because it uses HTTP/HTTPS instead of SMTP ports.
 */
exports.sendEmail = async (to, subject, text, html) => {
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
  const REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
  const MAIL_USER = process.env.MAIL_USER; // The Gmail address used for OAuth

  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !MAIL_USER) {
    throw new Error('Gmail API not fully configured. Missing GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, or MAIL_USER');
  }

  const oAuth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );

  oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

  try {
    // Get access token
    const accessTokenResponse = await oAuth2Client.getAccessToken();
    const accessToken = accessTokenResponse.token;

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: MAIL_USER,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: REFRESH_TOKEN,
        accessToken: accessToken,
      },
    });

    const mailOptions = {
      from: process.env.MAIL_FROM || `Medical Logbook <${MAIL_USER}>`,
      to,
      subject,
      text,
      html,
    };

    const result = await transporter.sendMail(mailOptions);
    return result;
  } catch (error) {
    console.error('Gmail API Send Error:', error);
    throw error;
  }
};
