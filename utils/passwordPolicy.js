const crypto = require('crypto');

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const DEFAULT_GENERATED_PASSWORD_LENGTH = 12;

const UPPERCASE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWERCASE_CHARS = 'abcdefghijkmnopqrstuvwxyz';
const DIGIT_CHARS = '23456789';
const SPECIAL_CHARS = '!@#$%&*?';
const ALL_SAFE_CHARS = `${UPPERCASE_CHARS}${LOWERCASE_CHARS}${DIGIT_CHARS}${SPECIAL_CHARS}`;

const COMMON_WEAK_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'password123!',
  'password@123',
  'p@ssword1',
  'p@ssword123',
  'admin123',
  'admin123!',
  'admin@123',
  'qwerty123',
  'qwerty123!',
  'welcome1',
  'welcome123',
  'welcome123!',
  'abc12345',
  'abcd1234',
  'abcd1234!',
  '12345678',
  '123456789',
  '1234567890',
  'medicallogbook',
  'medicallogbook123',
  'changeme1!',
  'letmein1!',
  'test1234!',
]);

const ENV_PLACEHOLDER_PATTERNS = [
  'replace-this',
  'replace-with',
  'your-password',
  'changeme',
];

const pickRandomChar = (charset) => charset[crypto.randomInt(0, charset.length)];

const shuffleChars = (chars) => {
  const arr = [...chars];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

/**
 * Validate password complexity and reject predictable/weak values.
 * @param {string} password
 * @param {{ email?: string, studentId?: string }} [context]
 * @returns {string|null} Thai error message or null when valid
 */
const validatePassword = (password, context = {}) => {
  if (typeof password !== 'string') {
    return 'รูปแบบรหัสผ่านไม่ถูกต้อง';
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `รหัสผ่านต้องมีความยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `รหัสผ่านต้องไม่เกิน ${MAX_PASSWORD_LENGTH} ตัวอักษร`;
  }
  if (/\s/.test(password)) {
    return 'รหัสผ่านต้องไม่มีช่องว่าง';
  }
  if (!/[A-Z]/.test(password)) {
    return 'รหัสผ่านต้องมีตัวอักษรพิมพ์ใหญ่ (A-Z) อย่างน้อย 1 ตัว';
  }
  if (!/[a-z]/.test(password)) {
    return 'รหัสผ่านต้องมีตัวอักษรพิมพ์เล็ก (a-z) อย่างน้อย 1 ตัว';
  }
  if (!/[0-9]/.test(password)) {
    return 'รหัสผ่านต้องมีตัวเลข (0-9) อย่างน้อย 1 ตัว';
  }
  if (!/[^A-Za-z0-9\s]/.test(password)) {
    return 'รหัสผ่านต้องมีอักขระพิเศษ (เช่น !@#$%&*?) อย่างน้อย 1 ตัว';
  }

  const lower = password.toLowerCase();
  if (COMMON_WEAK_PASSWORDS.has(lower)) {
    return 'รหัสผ่านนี้เดาง่ายหรือพบบ่อยเกินไป กรุณาตั้งรหัสผ่านให้รัดกุมมากขึ้น';
  }

  if (/(.)\1{3,}/.test(password)) {
    return 'รหัสผ่านต้องไม่มีอักขระตัวเดิมซ้ำติดกัน 4 ตัวขึ้นไป';
  }

  const emailLocal = typeof context.email === 'string'
    ? context.email.trim().toLowerCase().split('@')[0]
    : '';
  if (emailLocal && emailLocal.length >= 4 && lower.includes(emailLocal)) {
    return 'รหัสผ่านต้องไม่มีชื่ออีเมลของบัญชีเป็นส่วนประกอบ';
  }

  const studentId = typeof context.studentId === 'string'
    ? context.studentId.trim().toLowerCase()
    : '';
  if (studentId && studentId.length >= 4 && lower.includes(studentId)) {
    return 'รหัสผ่านต้องไม่มีรหัสนักศึกษาเป็นส่วนประกอบ';
  }

  return null;
};

/**
 * Generate a cryptographically random password satisfying the strict policy.
 */
const generateStrongPassword = (length = DEFAULT_GENERATED_PASSWORD_LENGTH, context = {}) => {
  const targetLength = Math.max(MIN_PASSWORD_LENGTH + 2, Number(length) || DEFAULT_GENERATED_PASSWORD_LENGTH);

  for (let attempt = 0; attempt < 20; attempt++) {
    const chars = [
      pickRandomChar(UPPERCASE_CHARS),
      pickRandomChar(UPPERCASE_CHARS),
      pickRandomChar(LOWERCASE_CHARS),
      pickRandomChar(LOWERCASE_CHARS),
      pickRandomChar(DIGIT_CHARS),
      pickRandomChar(DIGIT_CHARS),
      pickRandomChar(SPECIAL_CHARS),
      pickRandomChar(SPECIAL_CHARS),
    ];

    while (chars.length < targetLength) {
      chars.push(pickRandomChar(ALL_SAFE_CHARS));
    }

    const candidate = shuffleChars(chars).join('');
    if (!validatePassword(candidate, context)) {
      return candidate;
    }
  }

  // Fallback with extra entropy if context matched a random draw
  return `${pickRandomChar(UPPERCASE_CHARS)}${pickRandomChar(LOWERCASE_CHARS)}${pickRandomChar(DIGIT_CHARS)}${pickRandomChar(SPECIAL_CHARS)}${crypto.randomBytes(6).toString('hex')}`;
};

const isStrongConfiguredDefault = (value) => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (ENV_PLACEHOLDER_PATTERNS.some((pat) => lower.includes(pat))) {
    return false;
  }
  return validatePassword(trimmed) === null;
};

/**
 * Resolve an initial password for newly created accounts.
 * - Explicit password: must satisfy strict policy.
 * - Omitted password: generates a unique cryptographically random password per account
 *   (never falls back to weak static defaults such as "password123").
 */
const resolveInitialPassword = (explicitPassword, context = {}) => {
  const raw = typeof explicitPassword === 'string' ? explicitPassword : '';
  if (raw !== '') {
    const err = validatePassword(raw, context);
    return {
      password: raw,
      isAutoGenerated: false,
      error: err,
    };
  }

  return {
    password: generateStrongPassword(DEFAULT_GENERATED_PASSWORD_LENGTH, context),
    isAutoGenerated: true,
    error: null,
  };
};

module.exports = {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  DEFAULT_GENERATED_PASSWORD_LENGTH,
  validatePassword,
  generateStrongPassword,
  isStrongConfiguredDefault,
  resolveInitialPassword,
};
