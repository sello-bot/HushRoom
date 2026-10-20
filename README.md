# HushRoom — privacy-first disappearing chat starter

A React + Vite + Tailwind frontend with a Node.js + Express + Socket.IO backend and Redis for temporary room metadata. Message payloads are encrypted in the browser using the Web Crypto API and relayed as ciphertext. No message history is stored.

## Important security scope

This is a starter project, not an independently audited secure messenger. Do not use it for high-risk or life-critical communications until it has received a professional security review and penetration test.

- Five-digit PINs are invitation codes, not strong secrets. Rate limiting helps but does not make 100,000 combinations cryptographically strong.
- The encryption key is carried in the invite URL fragment (`#key=...`). URL fragments are not sent in HTTP requests, but anyone who gets the full invite URL can decrypt messages. Share the PIN separately.
- AES-GCM protects message confidentiality and integrity from the relay server, but this starter does not provide forward secrecy, key rotation, verified identities, or robust protection against a malicious server distributing altered client code.
- No system can erase screenshots, copied text, browser/OS artifacts, or data captured by a participant.
- Redis expiry is best-effort cleanup, not proof of forensic erasure. Configure Redis without persistence/backups for room data and keep logs free of sensitive values.
- This starter assumes one backend instance. For multiple instances, add the Socket.IO Redis adapter and coordinated room-expiry/owner state.
- Creator authorization uses an in-memory random token; a backend restart may prevent the creator from ending the room manually. The 30-minute expiry remains the fallback.

## Requirements

- Node.js 20+
- Docker Desktop (or a Redis 7 server)
- npm

## Project layout

```text
hushroom-starter/
├── client/
│   ├── index.html
│   ├── package.json
│   ├── postcss.config.js
│   ├── tailwind.config.js
│   ├── vite.config.js
│   └── src/
│       ├── App.jsx
│       ├── main.jsx
│       ├── index.css
│       └── crypto.js
├── server/
│   ├── package.json
│   ├── .env.example
│   └── src/
│       └── index.js
├── docker-compose.yml
└── .gitignore
```

## 1. Start Redis

From the project root:

```bash
docker compose up -d redis
```

For local development, Redis is available at `redis://localhost:6379`.

## 2. Configure the server

```bash
cd server
cp .env.example .env
npm install
npm run dev
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

## 3. Start the frontend

Open a second terminal:

```bash
cd client
npm install
npm run dev
```

Open the local Vite URL shown in the terminal, usually `http://localhost:5173`.

## 4. Test a conversation

1. Open the site and create a room.
2. Copy the invite link and send it to another person; share the five-digit PIN separately.
3. Open the invite link in a second browser/device and enter the PIN.
4. Send messages between participants.
5. End the room from the creator's browser.
6. Try the old invite again; it should be rejected.

The invite link contains a secret key after `#`. Do not post it publicly. The PIN is entered separately.

## Environment variables

`server/.env.example` documents the local defaults. In production, set a strong `OWNER_TOKEN_SECRET` and explicit `CLIENT_ORIGIN`, `REDIS_URL`, and `PORT`.

## Production deployment outline

1. Deploy Redis to a managed Redis provider. Disable persistence, snapshots, and backups for this instance if your threat model requires no recoverable room metadata. Restrict network access and require TLS/authentication.
2. Deploy `server/` to a Node host that supports long-lived WebSocket connections (for example, a suitable Render, Railway, Fly.io, or VPS deployment). Configure `REDIS_URL`, `CLIENT_ORIGIN`, `OWNER_TOKEN_SECRET`, and `NODE_ENV=production`.
3. Deploy `client/` as a static Vite site on a static host. Set `VITE_SERVER_URL` to the backend's HTTPS URL, rebuild, and redeploy.
4. Configure HTTPS/WSS, strict CORS, security headers, dependency scanning, and log redaction.
5. Test reconnects, room expiry, PIN guessing, creator ending, multiple participants, Redis outage, server restart, and concurrent room creation.
6. Before public launch, add a distributed Socket.IO adapter, coordinated room ownership/expiry, CAPTCHA or stronger abuse controls if needed, security review, and a documented privacy policy.

## Deletion behavior

The server stores room metadata in Redis with a 30-minute TTL that is refreshed by valid room activity. Ending a room marks it ended, disconnects participants, and deletes its Redis key. In-memory owner tokens and expiry timers are also removed. Messages are not stored by the app. Redis persistence, provider backups, host logs, client devices, browser extensions, screenshots, and network/security monitoring outside this app are not guaranteed to be erased by application code.
