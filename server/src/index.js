import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import cors from 'cors';
import helmet from 'helmet';
import Redis from 'ioredis';
import { Server } from 'socket.io';

const PORT = Number(process.env.PORT || 4000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const ROOM_TTL_SECONDS = Math.max(60, Number(process.env.ROOM_TTL_SECONDS || 1800));
const OWNER_TOKEN_SECRET = process.env.OWNER_TOKEN_SECRET || 'development-only-change-me';
if (process.env.NODE_ENV === 'production' && OWNER_TOKEN_SECRET.length < 32) {
  throw new Error('OWNER_TOKEN_SECRET must be at least 32 characters in production.');
}

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  lazyConnect: false,
  maxRetriesPerRequest: 1,
  enableReadyCheck: true,
});
redis.on('error', () => {
  // Do not log connection details, command arguments, PINs, tokens, or message payloads.
  console.error('Redis connection error.');
});

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: CLIENT_ORIGIN, methods: ['GET', 'POST'], credentials: false }));
app.use(express.json({ limit: '4kb' }));

// Simple per-process API rate limit. Use a distributed limiter/WAF at scale.
const apiBuckets = new Map();
function rateLimit({ windowMs, max, keyFn }) {
  return (req, res, next) => {
    const now = Date.now();
    const key = keyFn(req);
    let item = apiBuckets.get(key);
    if (!item || item.until <= now) item = { count: 0, until: now + windowMs };
    item.count += 1;
    apiBuckets.set(key, item);
    if (apiBuckets.size > 5000) {
      for (const [k, v] of apiBuckets) if (v.until <= now) apiBuckets.delete(k);
    }
    if (item.count > max) return res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
    next();
  };
}
const ipKey = (req) => req.ip || req.socket.remoteAddress || 'unknown';
app.use('/api/', rateLimit({ windowMs: 60_000, max: 30, keyFn: ipKey }));

app.get('/health', async (_req, res) => {
  try {
    await redis.ping();
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 16 * 1024,
  transports: ['websocket', 'polling'],
});

const timers = new Map();             // roomId -> timer (single backend instance)
const ownerTokens = new Map();        // roomId -> SHA-256 token hash (single backend instance)
const socketBuckets = new Map();      // socket.id -> simple join/message rate bucket
const PIN_RE = /^\d{5}$/;
const ROOM_PREFIX = 'hushroom:room:';
const PIN_PREFIX = 'hushroom:pin:';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function randomPin() {
  return String(crypto.randomInt(0, 100000)).padStart(5, '0');
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function roomKey(roomId) { return `${ROOM_PREFIX}${roomId}`; }
function pinKey(pin) { return `${PIN_PREFIX}${pin}`; }

async function getRoom(roomId) {
  if (!/^[a-f0-9-]{36}$/i.test(roomId || '')) return null;
  const raw = await redis.get(roomKey(roomId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function saveRoom(room) {
  await redis.set(roomKey(room.id), JSON.stringify(room), 'EX', ROOM_TTL_SECONDS);
}
function scheduleExpiry(roomId) {
  clearTimeout(timers.get(roomId));
  // Fire slightly before Redis TTL so the room record is still available for disconnect cleanup.
  const timer = setTimeout(() => { void destroyRoom(roomId, 'expired'); }, Math.max(1000, (ROOM_TTL_SECONDS - 2) * 1000));
  timer.unref?.();
  timers.set(roomId, timer);
}
async function touchRoom(room) {
  room.lastActivity = Date.now();
  await saveRoom(room);
  scheduleExpiry(room.id);
}
async function destroyRoom(roomId, reason = 'ended') {
  clearTimeout(timers.get(roomId));
  timers.delete(roomId);
  const room = await getRoom(roomId);
  if (room) {
    // Set a short tombstone so an old PIN cannot instantly be reissued/reused.
    await redis.set(pinKey(room.pin), 'ended', 'EX', 120).catch(() => {});
    await redis.del(roomKey(roomId));
    io.to(roomId).emit('room:destroyed', { reason });
    io.in(roomId).disconnectSockets(true);
  }
  ownerTokens.delete(roomId);
}

function consumeSocketLimit(socket, bucketName, max, windowMs) {
  const now = Date.now();
  let buckets = socketBuckets.get(socket.id);
  if (!buckets) { buckets = {}; socketBuckets.set(socket.id, buckets); }
  let bucket = buckets[bucketName];
  if (!bucket || bucket.until <= now) bucket = { count: 0, until: now + windowMs };
  bucket.count += 1;
  buckets[bucketName] = bucket;
  return bucket.count <= max;
}

async function createRoom() {
  // Try multiple random PINs; pin reservation is atomic.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pin = randomPin();
    const id = crypto.randomUUID();
    const reservation = await redis.set(pinKey(pin), id, 'EX', ROOM_TTL_SECONDS, 'NX');
    if (reservation !== 'OK') continue;
    const ownerToken = crypto.randomBytes(32).toString('base64url');
    const room = { id, pin, createdAt: Date.now(), lastActivity: Date.now(), participants: 0 };
    try {
      await saveRoom(room);
      ownerTokens.set(id, sha256(ownerToken));
      scheduleExpiry(id);
      return { room, ownerToken };
    } catch (error) {
      await redis.del(pinKey(pin)).catch(() => {});
      throw error;
    }
  }
  throw new Error('Could not allocate a room PIN. Please try again.');
}

app.post('/api/rooms', async (_req, res) => {
  try {
    const { room, ownerToken } = await createRoom();
    res.status(201).json({ roomId: room.id, pin: room.pin, ownerToken, expiresInSeconds: ROOM_TTL_SECONDS });
  } catch {
    res.status(503).json({ error: 'A room could not be created right now.' });
  }
});

app.post('/api/rooms/join', rateLimit({
  windowMs: 60_000, max: 12, keyFn: (req) => `${ipKey(req)}:${String(req.body?.pin || '').slice(0, 5)}`,
}), async (req, res) => {
  const pin = String(req.body?.pin || '');
  if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'Enter a valid five-digit PIN.' });
  try {
    const roomId = await redis.get(pinKey(pin));
    if (!roomId || roomId === 'ended') return res.status(404).json({ error: 'That room is unavailable or has expired.' });
    const room = await getRoom(roomId);
    if (!room || room.pin !== pin) return res.status(404).json({ error: 'That room is unavailable or has expired.' });
    res.json({ roomId: room.id });
  } catch {
    res.status(503).json({ error: 'Rooms are temporarily unavailable.' });
  }
});

app.post('/api/rooms/:roomId/end', rateLimit({ windowMs: 60_000, max: 10, keyFn: ipKey }), async (req, res) => {
  const { roomId } = req.params;
  const supplied = String(req.get('x-owner-token') || '');
  const storedHash = ownerTokens.get(roomId);
  if (!storedHash || !supplied || !safeEqual(storedHash, sha256(supplied))) {
    return res.status(403).json({ error: 'Only this room’s creator can end it from this session.' });
  }
  await destroyRoom(roomId, 'ended');
  res.json({ ended: true });
});

io.use((socket, next) => {
  // Never accept a PIN or message body from the handshake query string.
  if (socket.handshake.auth?.clientVersion !== 1) return next(new Error('Unsupported client.'));
  next();
});

io.on('connection', (socket) => {
  socket.on('room:join', async (payload, ack = () => {}) => {
    try {
      if (!consumeSocketLimit(socket, 'join', 8, 60_000)) return ack({ ok: false, error: 'Too many attempts.' });
      const roomId = String(payload?.roomId || '');
      const pin = String(payload?.pin || '');
      const name = String(payload?.name || '').trim().slice(0, 24);
      if (!PIN_RE.test(pin) || !name || !/^[a-f0-9-]{36}$/i.test(roomId)) {
        return ack({ ok: false, error: 'Invalid room details.' });
      }
      const mapped = await redis.get(pinKey(pin));
      const room = await getRoom(roomId);
      if (!room || room.pin !== pin || mapped !== roomId) return ack({ ok: false, error: 'This room has ended or expired.' });
      socket.data.roomId = roomId;
      socket.data.displayName = name;
      await socket.join(roomId);
      room.participants = io.sockets.adapter.rooms.get(roomId)?.size || 1;
      await touchRoom(room);
      socket.to(roomId).emit('participant:joined', { id: socket.id, name });
      const members = [...(io.sockets.adapter.rooms.get(roomId) || [])].map((id) => {
        const s = io.sockets.sockets.get(id);
        return { id, name: s?.data?.displayName || 'Guest' };
      });
      ack({ ok: true, members, expiresInSeconds: ROOM_TTL_SECONDS });
    } catch {
      ack({ ok: false, error: 'Unable to join this room right now.' });
    }
  });

  socket.on('message:send', async (payload, ack = () => {}) => {
    try {
      if (!consumeSocketLimit(socket, 'message', 60, 10_000)) return ack({ ok: false, error: 'You are sending messages too quickly.' });
      const roomId = socket.data.roomId;
      if (!roomId || typeof payload?.ciphertext !== 'string' || payload.ciphertext.length > 12_000) {
        return ack({ ok: false, error: 'Invalid message.' });
      }
      const room = await getRoom(roomId);
      if (!room) {
        socket.emit('room:destroyed', { reason: 'expired' });
        return ack({ ok: false, error: 'This room has ended or expired.' });
      }
      // Relay ciphertext only. Never log or persist payload.
      const packet = {
        id: crypto.randomUUID(),
        senderId: socket.id,
        senderName: socket.data.displayName || 'Guest',
        ciphertext: payload.ciphertext,
        iv: String(payload.iv || '').slice(0, 64),
        sentAt: Date.now(),
      };
      io.to(roomId).emit('message:new', packet);
      await touchRoom(room);
      ack({ ok: true });
    } catch {
      ack({ ok: false, error: 'Message could not be sent.' });
    }
  });

  socket.on('disconnect', async () => {
    socketBuckets.delete(socket.id);
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = await getRoom(roomId);
    if (!room) return;
    const remaining = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    room.participants = remaining;
    socket.to(roomId).emit('participant:left', { id: socket.id });
    // A disconnect counts as activity, but does not immediately destroy the room.
    await touchRoom(room).catch(() => {});
  });
});

server.listen(PORT, () => {
  console.log(`HushRoom server listening on port ${PORT}`);
});
