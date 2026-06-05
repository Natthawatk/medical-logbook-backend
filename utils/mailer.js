const nodemailer = require('nodemailer');

const requiredEnv = ['MAIL_USER', 'MAIL_APP_PASSWORD'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  // eslint-disable-next-line no-console
  console.warn(
    `Mailer not fully configured. Missing env vars: ${missingEnv.join(', ')}`
  );
}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_APP_PASSWORD,
  },
});

exports.sendEmail = async (to, subject, text, html) => {
  if (missingEnv.length > 0) {
    throw new Error(
      `Missing mail configuration: ${missingEnv.join(', ')}`
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
