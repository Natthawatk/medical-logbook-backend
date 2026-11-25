const webpush = require('web-push');
const PushConfig = require('../models/PushConfig');
const PushSubscription = require('../models/PushSubscription');

let cachedVapidKeys = null;
let initializingPromise = null;

const getVapidKeys = async () => {
  if (cachedVapidKeys) return cachedVapidKeys;
  if (initializingPromise) return initializingPromise;

  initializingPromise = (async () => {
    const envPublic = String(process.env.VAPID_PUBLIC_KEY || '').trim();
    const envPrivate = String(process.env.VAPID_PRIVATE_KEY || '').trim();
    if (envPublic && envPrivate) {
      cachedVapidKeys = { publicKey: envPublic, privateKey: envPrivate };
      return cachedVapidKeys;
    }

    let stored = await PushConfig.findOne({ key: 'vapid' }).lean();
    if (!stored) {
      const generated = webpush.generateVAPIDKeys();
      try {
        stored = await PushConfig.create({
          key: 'vapid',
          publicKey: generated.publicKey,
          privateKey: generated.privateKey,
        });
      } catch (err) {
        if (err && err.code === 11000) {
          stored = await PushConfig.findOne({ key: 'vapid' }).lean();
        } else {
          throw err;
        }
      }
    }

    cachedVapidKeys = {
      publicKey: stored.publicKey,
      privateKey: stored.privateKey,
    };
    return cachedVapidKeys;
  })();

  try {
    return await initializingPromise;
  } finally {
    initializingPromise = null;
  }
};

const getVapidSubject = () => {
  const explicit = String(process.env.VAPID_SUBJECT || '').trim();
  if (explicit) return explicit;
  const mailUser = String(process.env.MAIL_USER || '').trim();
  if (mailUser && mailUser.includes('@')) return `mailto:${mailUser}`;
  return 'mailto:support@medical-logbook.org';
};

const getVapidPublicKey = async () => {
  const keys = await getVapidKeys();
  return keys.publicKey;
};

const sendPushToUser = async ({ recipientId, title, body, url = '/notifications', tag, notificationId }) => {
  const summary = { attempted: 0, delivered: 0, expiredRemoved: 0, failed: 0 };
  try {
    if (!recipientId) return summary;
    const subscriptions = await PushSubscription.find({ user_id: recipientId }).lean();
    if (!subscriptions || subscriptions.length === 0) return summary;

    summary.attempted = subscriptions.length;
    const keys = await getVapidKeys();
    const payload = JSON.stringify({
      title: title || 'Medical Logbook',
      body: body || '',
      url,
      tag: tag || (notificationId ? `noti-${notificationId}` : undefined),
      notificationId: notificationId ? String(notificationId) : undefined,
      icon: '/logo.png',
    });

    const options = {
      vapidDetails: {
        subject: getVapidSubject(),
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
      },
      TTL: 60 * 60 * 24,
    };

    const expiredEndpoints = [];
    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: sub.keys,
            },
            payload,
            options
          );
          summary.delivered += 1;
        } catch (err) {
          const status = err?.statusCode;
          if (status === 404 || status === 410) {
            expiredEndpoints.push(sub.endpoint);
          } else {
            summary.failed += 1;
            // eslint-disable-next-line no-console
            console.warn('Web push send failed:', status || err?.message);
          }
        }
      })
    );

    if (expiredEndpoints.length > 0) {
      await PushSubscription.deleteMany({ endpoint: { $in: expiredEndpoints } });
      summary.expiredRemoved = expiredEndpoints.length;
    }
    return summary;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('Web push dispatch error:', err?.message || err);
    return summary;
  }
};

module.exports = {
  getVapidPublicKey,
  sendPushToUser,
};
