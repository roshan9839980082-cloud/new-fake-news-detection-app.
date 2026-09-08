# FakeNewsDetect v5 — MongoDB + Gemini + Firebase Reset + Render

Mobile-first fake-news detection app built with HTML, CSS, vanilla JavaScript, and a Node.js backend.

## Architecture
- Frontend: HTML + CSS + vanilla JavaScript
- Backend: Node.js
- Primary database: MongoDB Atlas
- Account login/signup/profile/password hash: MongoDB
- History / Saved Articles / Preferences: MongoDB
- Fake-news analysis: Gemini API
- Forgot Password email: Firebase Authentication REST API
- Deployment: Render-ready (`render.yaml` included)
- Python: not used

## Password-reset design
Firebase is kept for the **Forgot Password** email flow only.

When a user signs up, the app creates the MongoDB account and also tries to create a small Firebase Auth mirror for password-reset support.

If the user resets the password using Firebase's normal reset page, the next login automatically checks Firebase if the MongoDB hash does not match. A valid Firebase password is then synchronized back into MongoDB. This keeps the reset flow working even when Firebase's default hosted reset page is used.

There is also an optional custom `Page/reset-password.html` handler. If you configure Firebase's password-reset action URL to that page, it updates Firebase and MongoDB immediately.

## Features
- Text, URL and image fake-news checking with Gemini
- Real / Fake / Misleading / Unverified verdicts
- Confidence score, reasons, warning signs, trusted-source suggestions
- MongoDB user signup/login/logout
- MongoDB profile + notifications preference
- MongoDB change password
- Firebase forgot-password email
- Automatic Firebase-reset-to-MongoDB password sync on next login
- History stored in MongoDB
- History filters / open / delete / clear
- Saved Articles stored in MongoDB
- Dark mode across the full app
- Reference-style My Profile UI
- Profile image in browser localStorage
- Guest mode; guest analysis/history also stored in MongoDB using a guest cookie
- Render deployment config

## 1) MongoDB Atlas
Create a MongoDB Atlas cluster and database user.

In Atlas, allow your Render service to connect. For a quick deployment setup you can use Network Access `0.0.0.0/0`, then tighten it later if desired.

Copy the connection string, for example:

```env
MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@CLUSTER.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=fakenewsdetect
```

MongoDB collections are created automatically:
- `users`
- `history`
- `saved`

## 2) Gemini
Create a Gemini API key and set:

```env
GEMINI_API_KEY=YOUR_GEMINI_API_KEY
GEMINI_MODEL=gemini-2.5-flash
```

## 3) Firebase — Forgot Password only
In Firebase Console:
1. Open **Authentication**.
2. Enable **Email/Password** provider.
3. Copy the project's **Web API Key** from Project Settings.
4. Put it in the server environment:

```env
FIREBASE_API_KEY=YOUR_FIREBASE_WEB_API_KEY
```

The key is used by the Node backend for Firebase Auth REST requests. Do not place the key in HTML or frontend JS.

### Optional custom reset page
The project includes:

`Page/reset-password.html`

You can set Firebase's Password Reset email action handler / action URL to:

```text
https://YOUR-RENDER-SERVICE.onrender.com/Page/reset-password.html
```

If you leave Firebase's default reset page enabled, the app still works: after reset, signing in with the new Firebase password automatically updates the MongoDB password hash.

## 4) Local setup
Install Node.js 20+.

From the project folder:

```bash
npm install
```

Copy `.env.example` to `.env` and add your values:

```env
MONGODB_URI=YOUR_MONGODB_ATLAS_CONNECTION_STRING
MONGODB_DB=fakenewsdetect
GEMINI_API_KEY=YOUR_GEMINI_API_KEY
GEMINI_MODEL=gemini-2.5-flash
FIREBASE_API_KEY=YOUR_FIREBASE_WEB_API_KEY
PUBLIC_BASE_URL=http://127.0.0.1:5600
PORT=5600
SESSION_SECRET=PUT_A_LONG_RANDOM_SECRET_HERE
```

Start:

```bash
npm start
```

Open:

```text
http://127.0.0.1:5600/Page/index.html
```

Other useful pages:
- Login: `/Page/login.html`
- Signup: `/Page/signup.html`
- Forgot Password: `/Page/forgot-password.html`
- Reset Password: `/Page/reset-password.html`
- Profile: `/Page/profile.html`
- History: `/Page/history.html`
- Saved: `/Page/saved.html`
- Health: `/api/health`

Do not use VS Code Live Server for the full application. Run the Node server because MongoDB, Gemini, sessions and Firebase reset all use backend API routes.

## 5) Push to GitHub
Create a new empty GitHub repository, then inside this project folder:

```bash
git init
git add .
git commit -m "FakeNewsDetect MongoDB Gemini Render"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

`.env` is ignored by `.gitignore`, so secrets will not be pushed.

## 6) Deploy on Render
This project already includes `render.yaml`.

### Blueprint method
1. Push the project to GitHub.
2. In Render, create a **Blueprint** from the repository.
3. Render reads `render.yaml`.
4. Add the secret environment variables requested by Render:
   - `MONGODB_URI`
   - `GEMINI_API_KEY`
   - `FIREBASE_API_KEY`
   - `PUBLIC_BASE_URL` = your final Render URL, for example `https://fakenewsdetect.onrender.com`
5. Deploy.

The server listens on Render's `PORT` and binds to `0.0.0.0`.

### Manual Web Service method
If you do not use the Blueprint:
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check: `/api/health`

Add the same environment variables listed above.

## Security notes
- MongoDB passwords are never stored as plain text; they are hashed with Node's `scrypt`.
- Login sessions use signed HttpOnly cookies.
- Production cookies use `Secure` when deployed.
- `.env` is git-ignored.
- Gemini and Firebase requests are made by the Node backend.
- Profile photos currently remain browser-local; they are not uploaded to MongoDB.

## Important
AI fact-checking can be wrong. For important claims, verify against original documents and multiple reputable sources.
