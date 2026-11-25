# Medical Logbook — Backend API

Backend REST API for the **Medical Logbook** clinical training management platform, built with **Node.js**, **Express**, and **MongoDB (Mongoose)**.

---

## Tech Stack

* **Runtime & Framework:** Node.js, Express (`^4.21.2`)
* **Database:** MongoDB + Mongoose (`^8.6.0`)
* **Authentication & Security:** JWT (`jsonwebtoken`), `bcryptjs`, `google-auth-library`, custom HTTP security headers, NoSQL operator sanitization (`stripDangerousKeys`), rate limiting, account lockout
* **Notifications:** In-app notifications, browser **Web Push** (`web-push` with VAPID + `PushConfig`/`PushSubscription`), background backlog & attendance monitor
* **Import / Export:** `exceljs`, `multer`, `csv-parser`, `strip-bom-stream` (with spreadsheet formula-injection neutralization)
* **Email / OTP:** Gmail API (`googleapis`), `nodemailer`, `resend`

---

## Core Capabilities

### Role-Based Access Control (4 Roles)
* `student`: GPS shift check-in/check-out, logbook case submission, personal dashboard & progress stats.
* `preceptor`: Individual preceptor & ward shared central account (`is_shared_account`), case evaluation (`0-4` / `Pass/Fail`), shift verification, on-site verifier tracking.
* `course_instructor`: Scoped management of assigned courses, procedures, linked locations/central preceptors, course-level student/preceptor accounts, Excel import, progress tracking.
* `admin`: Full system administration, instructor/admin account management, term rollover, active-admin safeguard, security & operational alerts.

### Security & Password Policy
* **Strict Password Policy** (`utils/passwordPolicy.js`): Minimum 8 characters (max 128), requires uppercase (`A-Z`), lowercase (`a-z`), digit (`0-9`), and special character; rejects spaces, common weak passwords, repeated character runs (`>= 4`), and passwords containing the user's email or student ID.
* **Secure Initial Passwords:** Omitting a password during user creation, bulk import, or central preceptor creation never falls back to a static weak password—it generates a unique 12-character cryptographically random strong password (`crypto.randomInt`) returned once in the API response, and enforces `must_change_password: true` on first login for personal accounts.
* **Brute-Force Protection:** Locks accounts for 15 minutes after 5 consecutive failed logins and notifies admins.
* **Data Integrity:** Dependency checks before deleting courses/procedures/locations/users with existing records; immutable user roles; last active admin protection.

### Performance & Test/Prod Database Separation
* **Automatic Environment Routing** (`config/environment.js`): Selects `medical_logbook_test` (Test/Dev) or `medical_logbook_prod` (Production) based on `DB_MODE` and `NODE_ENV`, reported on `GET /health`.
* **Dashboard Cache:** In-memory TTL/LRU dashboard cache (`services/dashboardCacheService.js`) with automatic invalidation on write mutations, plus compound Mongoose indexes.

---

## Project Structure

```text
back-end/
├── config/          # Environment & database mode resolution
├── controllers/     # Route handlers (auth, users, courses, shifts, cases, dashboards, notifications, otp)
├── middlewares/     # JWT auth, role authorization, security headers, sanitization, rate limiters
├── models/          # Mongoose schemas (User, Course, Procedure, Location, Shift, LogbookCase, Notification, PushConfig, PushSubscription, OTP, ...)
├── routes/          # Express route definitions
├── scripts/         # Database maintenance utilities (separateDatabases.js)
├── services/        # Business logic (centralPreceptorService, dashboardCacheService, webPushService, preceptorProgressService, ...)
├── utils/           # Helpers (passwordPolicy.js, authToken.js, scoreUtils.js)
├── Dockerfile
├── .env.example
└── server.js
```

---

## Setup & Local Development

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env` and fill in your credentials:
```bash
cp .env.example .env
```

| Variable | Description | Default / Example |
| --- | --- | --- |
| `PORT` | HTTP server port | `5000` |
| `NODE_ENV` | Runtime mode (`development` or `production`) | `development` |
| `DB_MODE` | Explicit DB selector (`test` or `prod`); in `production`, defaults to `prod` unless `DB_MODE=test` | `test` |
| `MONGODB_URI` | MongoDB connection URI | `mongodb://localhost:27017/medical_logbook` |
| `MONGODB_DB_NAME_TEST` | Database name for Test mode | `medical_logbook_test` |
| `MONGODB_DB_NAME_PROD` | Database name for Production mode | `medical_logbook_prod` |
| `JWT_SECRET` | **Required in production** — secret key for signing JWTs | `replace-with-a-long-random-secret` |
| `JWT_EXPIRES_IN` | Default JWT expiry | `7d` |
| `CORS_ORIGINS` | Comma-separated allowed frontend origins | `http://localhost:5173,http://localhost` |
| `TRUST_PROXY` | Enable Express `trust proxy` (auto-enabled when `NODE_ENV=production`) | `true` |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 Client ID | - |
| `GMAIL_CLIENT_SECRET` | Gmail API OAuth2 client secret (OTP mail) | - |
| `GMAIL_REFRESH_TOKEN` | Gmail API refresh token | - |
| `MAIL_USER` | Sender Gmail address (also used as fallback `mailto:` for VAPID) | - |
| `MAIL_FROM` | Email `From` header | `Medical Logbook <...>` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Optional static Web Push VAPID keys (auto-generated & stored in `pushconfigs` collection if omitted) | - |
| `VAPID_SUBJECT` | Optional Web Push VAPID contact URI (`mailto:...` or `https://...`) | `mailto:${MAIL_USER}` |

> **Security Note:** Never commit `.env` or credential files. `.env` and `uploads/` are excluded via `.gitignore`.

### 3. Run the Server
```bash
# Development (nodemon + Test DB)
npm run dev

# Development pointing explicitly at Production DB
npm run dev:prod-db

# Standard start
npm start

# Production start (sets NODE_ENV=production and DB_MODE=prod)
npm run start:prod

# Separate source DB into clean Test and Admin-only Prod DBs
npm run db:separate
```

---

## API Routes Overview

| Mount Path | Responsibility |
| --- | --- |
| `GET /health` | Server health, active `dbMode`, and connected `dbName` |
| `/api/auth` | Login, Google OAuth login, OTP password reset, session refresh |
| `/api/users` | Profile (`/me`, `/profile`), user CRUD, bulk update, Excel template & CSV/XLSX import |
| `/api/courses` | Course CRUD, term rollover, members, locations & context |
| `/api/procedures` | Procedure definitions & custom case form structures |
| `/api/locations` | Clinical training sites, GPS radius, central preceptors & saved verifiers |
| `/api/shifts` | GPS check-in/check-out, shift verification, shift history & updates |
| `/api/logbook-cases` | Logbook case submission, evaluation, student case history |
| `/api/dashboard` | Role dashboards (`student`, `preceptor`, `instructor`, `admin`), progress detail, course skills stats, Excel exports |
| `/api/notifications` | In-app notifications, category preferences, Web Push VAPID key, subscribe/unsubscribe & `/push-test` |
| `/api/otp` | OTP request & verification for password recovery |

---

## Production Deployment Checklist (e.g. Render)

1. Set `NODE_ENV=production` and `DB_MODE=prod`.
2. Set a strong random `JWT_SECRET` and exact `CORS_ORIGINS` matching your deployed frontend URL(s).
3. Ensure `MONGODB_URI` points to your Atlas cluster and `MONGODB_DB_NAME_PROD=medical_logbook_prod`.
4. Add your deployed frontend domain to **Authorized JavaScript origins** in Google Cloud Console for Google Sign-In.
5. Sign in to the initial Admin account on production and update its password via `/profile` immediately.
