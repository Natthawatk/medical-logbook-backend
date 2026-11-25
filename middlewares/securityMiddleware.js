const crypto = require('crypto');
const { JWT_SECRET } = require('../config/environment');
const {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  validatePassword,
  generateStrongPassword,
  resolveInitialPassword,
} = require('../utils/passwordPolicy');

/**
 * Set baseline HTTP security headers without external dependencies.
 */
const securityHeaders = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
  // Preserve Google Sign-In popup compatibility while still restricting opener access.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none';"
  );

  if (process.env.NODE_ENV === 'production' && (req.secure || req.headers['x-forwarded-proto'] === 'https')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
};

const isPlainObject = (value) =>
  Object.prototype.toString.call(value) === '[object Object]';

/**
 * Recursively strip MongoDB operator keys (`$...`) and dotted keys from untrusted payloads.
 */
const stripDangerousKeys = (value, depth = 0) => {
  if (depth > 12 || value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => stripDangerousKeys(item, depth + 1));
  }

  if (isPlainObject(value)) {
    const cleaned = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key.startsWith('$') || key.includes('.') || key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      cleaned[key] = stripDangerousKeys(nested, depth + 1);
    }
    return cleaned;
  }

  return value;
};

const sanitizeRequestInputs = (req, _res, next) => {
  if (req.body && typeof req.body === 'object') {
    req.body = stripDangerousKeys(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    req.query = stripDangerousKeys(req.query);
  }
  if (req.params && typeof req.params === 'object') {
    req.params = stripDangerousKeys(req.params);
  }
  next();
};

/**
 * Fixed-window in-memory rate limiter with periodic cleanup.
 */
const createRateLimiter = ({
  windowMs,
  max,
  keyGenerator,
  message = 'คำขอมากเกินไป กรุณารอสักครู่แล้วลองใหม่อีกครั้ง',
}) => {
  const hits = new Map();

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits.entries()) {
      if (entry.resetAt <= now) {
        hits.delete(key);
      }
    }
  }, Math.max(windowMs, 60 * 1000));

  if (typeof cleanupInterval.unref === 'function') {
    cleanupInterval.unref();
  }

  return (req, res, next) => {
    const now = Date.now();
    const rawKey = keyGenerator ? keyGenerator(req) : req.ip || 'unknown';
    const key = String(rawKey || req.ip || 'unknown');
    const existing = hits.get(key);

    if (!existing || existing.resetAt <= now) {
      const nextEntry = { count: 1, resetAt: now + windowMs };
      hits.set(key, nextEntry);
      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', String(Math.max(max - 1, 0)));
      res.setHeader('RateLimit-Reset', String(Math.ceil(nextEntry.resetAt / 1000)));
      return next();
    }

    existing.count += 1;
    const remaining = Math.max(max - existing.count, 0);
    const retryAfterSec = Math.max(Math.ceil((existing.resetAt - now) / 1000), 1);

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil(existing.resetAt / 1000)));

    if (existing.count > max) {
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        success: false,
        data: null,
        message,
      });
    }

    return next();
  };
};

const getEmailKeySuffix = (req) => {
  const email = req.body && typeof req.body.email === 'string'
    ? req.body.email.trim().toLowerCase()
    : '';
  return email || 'anonymous';
};

const loginRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => `login:${req.ip}:${getEmailKeySuffix(req)}`,
  message: 'ส่งคำขอเข้าสู่ระบบถี่เกินไป กรุณารอประมาณ 1 นาทีแล้วลองใหม่อีกครั้ง',
});

const otpSendRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `otp-send:${req.ip}`,
  message: 'ขอรหัส OTP บ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่อีกครั้ง',
});

const otpVerifyRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `otp-verify:${req.ip}:${getEmailKeySuffix(req)}`,
  message: 'ตรวจสอบรหัส OTP ผิดหรือบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่อีกครั้ง',
});

const resetPasswordRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `reset-password:${req.ip}:${getEmailKeySuffix(req)}`,
  message: 'ส่งคำขอรีเซ็ตรหัสผ่านบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่อีกครั้ง',
});

const importRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => `import:${req.user?.id || req.ip}`,
  message: 'อัปโหลดนำเข้าข้อมูลบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่อีกครั้ง',
});

const asString = (value) => (typeof value === 'string' ? value : '');

const asTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const isValidImageUrlOrPath = (value) => {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '') return true;
  if (trimmed.length > 1024) return false;
  if (/[\r\n\0]/.test(trimmed)) return false;

  if (trimmed.startsWith('/')) {
    return !trimmed.startsWith('//');
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
};

const FORMULA_TRIGGER_REGEX = /^[\s\u0000-\u001F]*[=+\-@\t\r]/;

const hasDangerousFormulaPrefix = (value) => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '-') return false;
  return FORMULA_TRIGGER_REGEX.test(value);
};

/**
 * Neutralize spreadsheet formula triggers (`=`, `+`, `-`, `@`, tab, CR) on exported text.
 */
const sanitizeSpreadsheetText = (value) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '-') return value;
  if (FORMULA_TRIGGER_REGEX.test(value)) {
    return `'${value}`;
  }
  return value;
};

const stripEmailHeaderChars = (value) => String(value || '').replace(/[\r\n\0]+/g, ' ').trim();

const hashScopedToken = (scope, value) =>
  crypto.createHmac('sha256', JWT_SECRET).update(`${scope}:${String(value)}`).digest('hex');

const timingSafeEqualHex = (hexA, hexB) => {
  if (typeof hexA !== 'string' || typeof hexB !== 'string') return false;
  if (hexA.length !== hexB.length || hexA.length === 0) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(hexA, 'hex'), Buffer.from(hexB, 'hex'));
  } catch {
    return false;
  }
};

module.exports = {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  securityHeaders,
  sanitizeRequestInputs,
  createRateLimiter,
  loginRateLimiter,
  otpSendRateLimiter,
  otpVerifyRateLimiter,
  resetPasswordRateLimiter,
  importRateLimiter,
  asString,
  asTrimmedString,
  isValidImageUrlOrPath,
  validatePassword,
  generateStrongPassword,
  resolveInitialPassword,
  hasDangerousFormulaPrefix,
  sanitizeSpreadsheetText,
  stripEmailHeaderChars,
  hashScopedToken,
  timingSafeEqualHex,
};
