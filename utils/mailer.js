const nodemailer = require('nodemailer');

const getTransporter = () => {
  const requiredEnv = ['MAIL_USER', 'MAIL_APP_PASSWORD'];
  const missingEnv = requiredEnv.filter((key) => !process.env[key]);

  if (missingEnv.length > 0) {
    return null;
  }

  return nodemailer.createTransport({
    // Using direct IPv4 address for smtp.gmail.com to bypass Render IPv6 issues
    host: '142.251.12.109', 
    port: 465,
    secure: true, // Use SSL/TLS
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_APP_PASSWORD,
    },
    tls: {
      rejectUnauthorized: false,
      servername: 'smtp.gmail.com'
    },
    connectionTimeout: 20000, // 20 seconds
    greetingTimeout: 20000,
    socketTimeout: 20000
  });
};

exports.sendEmail = async (to, subject, text, html) => {
  const transporter = getTransporter();

  if (!transporter) {
    const requiredEnv = ['MAIL_USER', 'MAIL_APP_PASSWORD'];
    const missingEnv = requiredEnv.filter((key) => !process.env[key]);
    throw new Error(
      `Mailer not fully configured. Missing env vars: ${missingEnv.join(', ')}`
    );
  }

  return transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.MAIL_USER,
    to,
    subject,
    text,
    html,
  });
};

