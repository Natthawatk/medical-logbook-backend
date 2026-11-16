const isProduction = process.env.NODE_ENV === 'production';
const developmentJwtSecret = 'dev-secret-change-me';

const JWT_SECRET = process.env.JWT_SECRET || developmentJwtSecret;

const validateEnvironment = () => {
  if (isProduction && !process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required when NODE_ENV=production.');
  }

  if (!isProduction && !process.env.JWT_SECRET) {
    // eslint-disable-next-line no-console
    console.warn('JWT_SECRET is not set; using the development-only fallback secret.');
  }
};

module.exports = {
  JWT_SECRET,
  validateEnvironment,
};
