# Mermaid Flow: Next Steps Setup

This is the checklist to fully enable auth, sharing, storage, and Notion sync in production.

## 1. Firebase Project Setup

1. Create a Firebase project:
   - https://console.firebase.google.com
2. In **Authentication**:
   - Enable `Email/Password`
   - Enable `Google` provider
3. In **Firestore Database**:
   - Create database in production mode
4. In **Storage**:
   - Enable Cloud Storage

## 2. Get Firebase Web App Keys

1. Firebase Console → **Project settings** → **General**
2. Under **Your apps**, create/select a Web app
3. Copy config values into local `.env` (from `.env.example`):

```bash
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
VITE_FIREBASE_MEASUREMENT_ID=
```

## 3. Deploy Firestore/Storage Rules + Indexes

Install Firebase CLI:

```bash
npm install -g firebase-tools
firebase login
firebase use <your-firebase-project-id>
```

Deploy security setup:

```bash
firebase deploy --only firestore:rules,firestore:indexes,storage
```

Files used:
- `firestore.rules`
- `firestore.indexes.json`
- `storage.rules`
- `firebase.json`

## 4. Notion Integration (Per User)

### A. Create Notion Integration Token

1. Open: https://www.notion.so/my-integrations
2. Click **New integration**
3. Copy the generated token (`ntn_...`)

### B. Get Notion Database ID

1. Open your Notion database page
2. Copy the URL
3. Use the 32-char database ID from the URL

### C. Give Integration Access to Database

1. Open target database in Notion
2. Click **Share**
3. Invite your integration to the database

### D. Save Token in App

1. Login to Mermaid Flow
2. Go to **Settings**
3. Save:
   - Notion Integration Token
   - Default Database ID (optional)

Notes:
- Notion keys are **per-user** and stored under `users/{uid}/settings/integrations`.
- No global Notion key is required in `.env`.

## 5. Notion Proxy Endpoint (Required for Live Sync)

Browser cannot call Notion API directly due to CORS. You must provide a server endpoint at:

- `POST /api/notion/pages`
- `POST /api/notion/databases/:id/query`

This repo now includes a Firebase Function proxy:
- `functions/index.js` (`notionProxy`)
- Hosting rewrite in `firebase.json` routes `/api/notion/**` to the function.

Expected behavior:
- Forward requests to official Notion API.
- Read `Authorization: Bearer <ntn_token>` header.
- Return raw Notion response JSON/errors.

### Deploy the proxy

```bash
cd functions
npm install
cd ..
firebase deploy --only functions:notionProxy
```

Optional hardening:
- Set `ALLOWED_ORIGINS` for the function (comma-separated domains) so only your frontend origins can call it.

If this proxy is not available:
- Import/Export live sync will fail.
- The app can still copy Notion payload JSON for manual server-side use.

## 5A. Do We Actually Need Live Notion Sync?

Short answer: **only if you want Notion DB integration**, not just embeds.

- If your goal is just visual display in Notion via iframe/embed URL:
  - You do **not** need live sync.
  - Mermaid Flow can run as a normal embed and render diagrams from code.
- You need live sync if you want Mermaid Flow to:
  - Pull tasks from a Notion database into Gantt automatically.
  - Push Mermaid tasks back into Notion pages via one-click sync.
  - Keep Notion as a structured task store, not just a canvas/embed container.

## 6. Hosting / Routing

The app has deep-link routes (`/editor/:flowId`, `/flow/:flowId`, `/settings`), so hosting must rewrite all paths to `index.html`.

For Firebase Hosting this is already configured in `firebase.json`.

## 7. Quick Verification Checklist

1. `npm install`
2. `npm run build`
3. Sign up/login works
4. Create flow, share flow, comment
5. Public link `/flow/:flowId` opens
6. Settings save/load Notion token and DB ID
7. Notion import/export works through proxy
