const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mongoose = require('mongoose');

const SOURCE_DB_NAME = process.env.SOURCE_DB_NAME || 'medical_logbook';
const TEST_DB_NAME = process.env.MONGODB_DB_NAME_TEST || 'medical_logbook_test';
const PROD_DB_NAME = process.env.MONGODB_DB_NAME_PROD || 'medical_logbook_prod';

const ALL_COLLECTIONS = [
  'users',
  'locations',
  'courses',
  'procedures',
  'courseassignments',
  'courselocations',
  'logbookcases',
  'shifts',
  'notifications',
  'pushconfigs',
  'pushsubscriptions',
  'otps',
];

const upsertDocs = async (targetDb, collectionName, docs) => {
  if (!Array.isArray(docs) || docs.length === 0) return 0;
  const ops = docs.map((doc) => ({
    replaceOne: {
      filter: { _id: doc._id },
      replacement: doc,
      upsert: true,
    },
  }));
  await targetDb.collection(collectionName).bulkWrite(ops, { ordered: false });
  return docs.length;
};

const getCollectionCounts = async (db) => {
  const counts = {};
  for (const col of ALL_COLLECTIONS) {
    counts[col] = await db.collection(col).countDocuments();
  }
  return counts;
};

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI is not defined in .env');
  }

  console.log('Connecting to MongoDB cluster...');
  const conn = await mongoose.connect(mongoUri, {
    dbName: SOURCE_DB_NAME,
    maxPoolSize: 5,
  });

  try {
    const client = conn.connection.getClient();
    const sourceDb = client.db(SOURCE_DB_NAME);
    const testDb = client.db(TEST_DB_NAME);
    const prodDb = client.db(PROD_DB_NAME);

    const sourceUserCount = await sourceDb.collection('users').countDocuments();
    const testUserCountBefore = await testDb.collection('users').countDocuments();

    // Use sourceDb (`medical_logbook`) if it has data; otherwise fallback to `testDb`
    const effectiveSourceDb = sourceUserCount > 0 ? sourceDb : testDb;
    const effectiveSourceName = sourceUserCount > 0 ? SOURCE_DB_NAME : TEST_DB_NAME;
    console.log(`Reading source data from "${effectiveSourceName}"...`);

    // 1. Copy ALL collections to TEST_DB_NAME (`medical_logbook_test`) if source is different
    if (effectiveSourceName !== TEST_DB_NAME) {
      console.log(`\n[1/2] Syncing full testing dataset to "${TEST_DB_NAME}"...`);
      for (const colName of ALL_COLLECTIONS) {
        const docs = await effectiveSourceDb.collection(colName).find({}).toArray();
        if (docs.length > 0) {
          await upsertDocs(testDb, colName, docs);
        }
      }
    } else {
      console.log(`\n[1/2] "${TEST_DB_NAME}" already holds the active testing dataset (${testUserCountBefore} users).`);
    }

    // 2. Prepare clean PROD_DB_NAME (`medical_logbook_prod`)
    // Keep ONLY Admin user accounts; remove all courses, procedures, locations,
    // assignments, cases, shifts, notifications, and other test/seed data.
    console.log(`\n[2/2] Preparing clean production database "${PROD_DB_NAME}" (Admin only)...`);

    const allUsers = await effectiveSourceDb.collection('users').find({}).toArray();

    const prodUsers = allUsers
      .filter((u) => u.role === 'admin')
      .map((u) => ({
        ...u,
        enrolled_courses: [],
        failed_login_attempts: 0,
        lock_until: null,
      }));

    // Clear all collections in PROD_DB_NAME
    for (const colName of ALL_COLLECTIONS) {
      await prodDb.collection(colName).deleteMany({});
    }

    await upsertDocs(prodDb, 'users', prodUsers);

    const [sourceCounts, testCounts, prodCounts] = await Promise.all([
      getCollectionCounts(sourceDb),
      getCollectionCounts(testDb),
      getCollectionCounts(prodDb),
    ]);

    const summaryRows = ALL_COLLECTIONS.map((col) => ({
      Collection: col,
      [`${SOURCE_DB_NAME} (Backup)`]: sourceCounts[col],
      [`${TEST_DB_NAME} (Test/Dev)`]: testCounts[col],
      [`${PROD_DB_NAME} (Production)`]: prodCounts[col],
    }));

    console.log('\nDatabase separation completed successfully:');
    console.table(summaryRows);

    const prodRoleBreakdown = prodUsers.reduce((acc, u) => {
      const key = u.is_shared_account ? `${u.role} (shared_location)` : u.role;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    console.log('Users in Production DB by role:', prodRoleBreakdown);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Database separation script error:', err);
  process.exit(1);
});
