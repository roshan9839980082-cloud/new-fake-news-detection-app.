#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  npm install
fi
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env. Add MONGODB_URI, GEMINI_API_KEY and FIREBASE_API_KEY."
fi
npm start
