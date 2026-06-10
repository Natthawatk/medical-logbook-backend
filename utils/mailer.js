const nodemailer = require('nodemailer');

const getTransporter = () => {
  const requiredEnv = ['MAIL_USER', 'MAIL_APP_PASSWORD'];
  const missingEnv = requiredEnv.filter((key) => !process.env[key]);

  if (missingEnv.length > 0) {
    return null;
  }

  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // Use STARTTLS
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_APP_PASSWORD,
    },
    tls: {
      rejectUnauthorized: false // Often needed for cloud environments
    }
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

