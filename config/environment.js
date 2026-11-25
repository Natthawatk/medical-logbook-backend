const isProduction = process.env.NODE_ENV === 'production';
const developmentJwtSecret = 'dev-secret-change-me';

const JWT_SECRET = process.env.JWT_SECRET || developmentJwtSecret;

const DEFAULT_TEST_DB_NAME = 'medical_logbook_test';
const DEFAULT_PROD_DB_NAME = 'medical_logbook_prod';

/**
 * Resolve MongoDB connection URI and target database name based on NODE_ENV / DB_MODE.
 * - Test/Development mode defaults to `medical_logbook_test`
 * - Production mode defaults to `medical_logbook_prod`
 */
const resolveMongoConfig = () => {
  const rawDbMode = String(process.env.DB_MODE || '').trim().toLowerCase();
  const useProdDb =
    rawDbMode === 'prod' ||
    rawDbMode === 'production' ||
    (isProduction && rawDbMode !== 'test' && rawDbMode !== 'dev' && rawDbMode !== 'development');

  const fallbackUri =
    process.env.MONGODB_URI || 'mongodb://localhost:27017/medical_logbook_test';

  const mongoUri = useProdDb
    ? process.env.MONGODB_URI_PROD || fallbackUri
    : process.env.MONGODB_URI_TEST || process.env.MONGODB_URI_DEV || fallbackUri;

  const explicitDbName = String(process.env.MONGODB_DB_NAME || '').trim();
  const dbName =
    explicitDbName ||
    (useProdDb
      ? String(process.env.MONGODB_DB_NAME_PROD || DEFAULT_PROD_DB_NAME).trim()
      : String(process.env.MONGODB_DB_NAME_TEST || DEFAULT_TEST_DB_NAME).trim());

  return {
    mongoUri,
    dbName,
    mode: useProdDb ? 'production' : 'test',
  };
};

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
  DEFAULT_TEST_DB_NAME,
  DEFAULT_PROD_DB_NAME,
  resolveMongoConfig,
  validateEnvironment,
};
