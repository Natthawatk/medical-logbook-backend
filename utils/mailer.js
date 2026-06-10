const { google } = require('googleapis');

/**
 * Send email using Gmail REST API with OAuth2
 * This is the most reliable method for Render because it uses pure HTTPS (Port 443)
 * and avoids the Nodemailer/SMTP transport altogether.
 */
exports.sendEmail = async (to, subject, text, html) => {
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
  const REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
  const MAIL_USER = process.env.MAIL_USER;

  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !MAIL_USER) {
    throw new Error('Gmail API not fully configured. Missing GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, or MAIL_USER');
  }

  const oAuth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );

  oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

  const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

  // Create RFC 2822 formatted email
  const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const messageParts = [
    `From: ${process.env.MAIL_FROM || `Medical Logbook <${MAIL_USER}>`}`,
    `To: ${to}`,
    'Content-Type: text/html; charset=utf-8',
    'MIME-Version: 1.0',
    `Subject: ${utf8Subject}`,
    '',
    html || text,
  ];
  const message = messageParts.join('\n');

  // The body needs to be base64url encoded
  const encodedMessage = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  try {
    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
      },
    });
    return res.data;
  } catch (error) {
    console.error('Gmail REST API Send Error:', error);
    throw error;
  }
};

