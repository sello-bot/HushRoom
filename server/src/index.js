import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import cors from 'cors';
import helmet from 'helmet';
import Redis from 'ioredis';
import { Server } from 'socket.io';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 4000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const ROOM_TTL_SECONDS = Math.max(60, Number(process.env.ROOM_TTL_SECONDS || 1800));
const OWNER_TOKEN_SECRET = process.env.OWNER_TOKEN_SECRET || 'development-only-change-me';
const UPLOAD_DIR = fileURLToPath(new URL('../uploads/', import.meta.url));
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_META_PREFIX = 'hushroom:image:';
const ROOM_IMAGES_PREFIX = 'hushroom:room-images:';

if (process.env.NODE_ENV === 'production' && OWNER_TOKEN_SECRET.length < 32) {
  throw new Error('OWNER_TOKEN_SECRET must be at least 32 characters in production.');
}

await mkdir(UPLOAD_DIR, { recursive: true });

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  lazyConnect: false,
  maxRetriesPerRequest: 1,
  enableReadyCheck: true,
});

redis.on('error', () => {
  console.error('Redis connection error.');
});

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: CLIENT_ORIGIN,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-Owner-Token', 'X-Participant-Id', 'X-Participant-Token'],
  credentials: false,
}));
app.use(express.json({ limit: '4kb' }));

const apiBuckets = new Map();

function rateLimit({ windowMs, max, keyFn }) {
  return (req, res, next) => {
    const now = Date.now();
    const key = keyFn(req);
    let item = apiBuckets.get(key);

    if (!item || item.until <= now) {
      item = { count: 0, until: now + windowMs };
    }

    item.count += 1;
    apiBuckets.set(key, item);

    if (apiBuckets.size > 5000) {
      for (const [k, v] of apiBuckets) {
        if (v.until <= now) apiBuckets.delete(k);
      }
    }

    if (item.count > max) {
      return res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
    }

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
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 16 * 1024,
  transports: ['websocket', 'polling'],
});

const timers = new Map();
const ownerTokens = new Map();
const participantTokens = new Map();
const socketBuckets = new Map();

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

function roomKey(roomId) {
  return `${ROOM_PREFIX}${roomId}`;
}

function pinKey(pin) {
  return `${PIN_PREFIX}${pin}`;
}

function imageMetaKey(imageId) {
  return `${IMAGE_META_PREFIX}${imageId}`;
}

function roomImagesKey(roomId) {
  return `${ROOM_IMAGES_PREFIX}${roomId}`;
}

function participantTokenKey(roomId, participantId) {
  return `${roomId}:${participantId}`;
}

function validRoomId(value) {
  return /^[a-f0-9-]{36}$/i.test(value || '');
}

function validParticipantId(value) {
  return /^[a-f0-9-]{36}$/i.test(value || '');
}

async function getRoom(roomId) {
  if (!validRoomId(roomId)) return null;

  const raw = await redis.get(roomKey(roomId));
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveRoom(room) {
  await redis.set(roomKey(room.id), JSON.stringify(room), 'EX', ROOM_TTL_SECONDS);
}

function scheduleExpiry(roomId) {
  clearTimeout(timers.get(roomId));

  const timer = setTimeout(() => {
    void destroyRoom(roomId, 'expired');
  }, Math.max(1000, (ROOM_TTL_SECONDS - 2) * 1000));

  timer.unref?.();
  timers.set(roomId, timer);
}

async function touchRoom(room) {
  room.lastActivity = Date.now();
  await saveRoom(room);
  scheduleExpiry(room.id);

  // Keep image metadata aligned with the room's inactivity expiry.
  const indexKey = roomImagesKey(room.id);
  const imageIds = await redis.smembers(indexKey);

  for (const imageId of imageIds) {
    await redis.expire(imageMetaKey(imageId), ROOM_TTL_SECONDS);
  }

  await redis.expire(indexKey, ROOM_TTL_SECONDS);
}

async function deleteRoomImages(roomId) {
  const indexKey = roomImagesKey(roomId);

  try {
    const imageIds = await redis.smembers(indexKey);

    for (const imageId of imageIds) {
      const metaKey = imageMetaKey(imageId);
      const raw = await redis.get(metaKey);

      if (raw) {
        try {
          const metadata = JSON.parse(raw);

          if (
            typeof metadata.fileName === 'string' &&
            /^[a-f0-9-]{36}\.bin$/i.test(metadata.fileName)
          ) {
            await unlink(join(UPLOAD_DIR, metadata.fileName)).catch(() => {});
          }
        } catch {
          // Continue cleanup even if one record is malformed.
        }
      }

      await redis.del(metaKey);
    }

    await redis.del(indexKey);
  } catch {
    console.error('Room image cleanup failed.');
  }
}

async function destroyRoom(roomId, reason = 'ended') {
  clearTimeout(timers.get(roomId));
  timers.delete(roomId);

  const room = await getRoom(roomId);

  // Remove images even if the room record has already expired in Redis.
  await deleteRoomImages(roomId);

  for (const key of participantTokens.keys()) {
    if (key.startsWith(`${roomId}:`)) participantTokens.delete(key);
  }

  if (room) {
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

  if (!buckets) {
    buckets = {};
    socketBuckets.set(socket.id, buckets);
  }

  let bucket = buckets[bucketName];

  if (!bucket || bucket.until <= now) {
    bucket = { count: 0, until: now + windowMs };
  }

  bucket.count += 1;
  buckets[bucketName] = bucket;

  return bucket.count <= max;
}

function connectedParticipantIds(roomId) {
  const socketIds = io.sockets.adapter.rooms.get(roomId);
  if (!socketIds) return [];

  const ids = new Set();

  for (const socketId of socketIds) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket?.data?.participantId) {
      ids.add(socket.data.participantId);
    }
  }

  return [...ids];
}

function authenticateParticipant(req, roomId) {
  const participantId = String(req.get('x-participant-id') || '');
  const suppliedToken = String(req.get('x-participant-token') || '');

  if (!validParticipantId(participantId) || !suppliedToken) return null;

  const storedHash = participantTokens.get(participantTokenKey(roomId, participantId));

  if (!storedHash || !safeEqual(storedHash, sha256(suppliedToken))) return null;

  const connected = connectedParticipantIds(roomId).includes(participantId);
  if (!connected) return null;

  return participantId;
}

async function createRoom() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pin = randomPin();
    const id = crypto.randomUUID();

    const reservation = await redis.set(
      pinKey(pin),
      id,
      'EX',
      ROOM_TTL_SECONDS,
      'NX',
    );

    if (reservation !== 'OK') continue;

    const ownerToken = crypto.randomBytes(32).toString('base64url');
    const room = {
      id,
      pin,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      participants: 0,
    };

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

    res.status(201).json({
      roomId: room.id,
      pin: room.pin,
      ownerToken,
      expiresInSeconds: ROOM_TTL_SECONDS,
    });
  } catch {
    res.status(503).json({ error: 'A room could not be created right now.' });
  }
});

app.post('/api/rooms/join', rateLimit({
  windowMs: 60_000,
  max: 12,
  keyFn: (req) => `${ipKey(req)}:${String(req.body?.pin || '').slice(0, 5)}`,
}), async (req, res) => {
  const pin = String(req.body?.pin || '');

  if (!PIN_RE.test(pin)) {
    return res.status(400).json({ error: 'Enter a valid five-digit PIN.' });
  }

  try {
    const roomId = await redis.get(pinKey(pin));

    if (!roomId || roomId === 'ended') {
      return res.status(404).json({ error: 'That room is unavailable or has expired.' });
    }

    const room = await getRoom(roomId);

    if (!room || room.pin !== pin) {
      return res.status(404).json({ error: 'That room is unavailable or has expired.' });
    }

    res.json({ roomId: room.id });
  } catch {
    res.status(503).json({ error: 'Rooms are temporarily unavailable.' });
  }
});

app.post('/api/rooms/:roomId/end', rateLimit({
  windowMs: 60_000,
  max: 10,
  keyFn: ipKey,
}), async (req, res) => {
  const { roomId } = req.params;
  const supplied = String(req.get('x-owner-token') || '');
  const storedHash = ownerTokens.get(roomId);

  if (!storedHash || !supplied || !safeEqual(storedHash, sha256(supplied))) {
    return res.status(403).json({
      error: 'Only this room’s creator can end it from this session.',
    });
  }

  await destroyRoom(roomId, 'ended');
  res.json({ ended: true });
});

// Upload encrypted bytes only. The browser must encrypt the image before sending it.
app.post(
  '/api/rooms/:roomId/images',
  rateLimit({ windowMs: 60_000, max: 12, keyFn: ipKey }),
  express.raw({ type: 'application/octet-stream', limit: IMAGE_MAX_BYTES }),
  async (req, res) => {
    const { roomId } = req.params;

    try {
      const room = await getRoom(roomId);

      if (!room) {
        return res.status(404).json({ error: 'This room has ended or expired.' });
      }

      const participantId = authenticateParticipant(req, roomId);

      if (!participantId) {
        return res.status(403).json({ error: 'Your participant session is invalid.' });
      }

      if (!Buffer.isBuffer(req.body) || req.body.length < 1 || req.body.length > IMAGE_MAX_BYTES) {
        return res.status(400).json({ error: 'Encrypted image must be under 10 MB.' });
      }

      const eligible = connectedParticipantIds(roomId);

      if (!eligible.includes(participantId) || eligible.length === 0) {
        return res.status(403).json({ error: 'You are not an active room participant.' });
      }

      const imageId = crypto.randomUUID();
      const fileName = `${imageId}.bin`;
      const metaKey = imageMetaKey(imageId);
      const indexKey = roomImagesKey(roomId);

      const metadata = {
        imageId,
        roomId,
        fileName,
        senderId: participantId,
        eligible,
        viewed: [],
        createdAt: Date.now(),
      };

      await writeFile(join(UPLOAD_DIR, fileName), req.body, { flag: 'wx' });

      try {
        await redis.set(metaKey, JSON.stringify(metadata), 'EX', ROOM_TTL_SECONDS);
        await redis.sadd(indexKey, imageId);
        await redis.expire(indexKey, ROOM_TTL_SECONDS);
        await touchRoom(room);
      } catch (error) {
        await unlink(join(UPLOAD_DIR, fileName)).catch(() => {});
        await redis.del(metaKey).catch(() => {});
        await redis.srem(indexKey, imageId).catch(() => {});
        throw error;
      }

      res.status(201).json({
        imageId,
        eligible,
        expiresInSeconds: ROOM_TTL_SECONDS,
      });
    } catch {
      res.status(503).json({ error: 'Encrypted image could not be uploaded.' });
    }
  },
);

// Claim the participant's single view. Each claim is atomic in Redis.
app.post(
  '/api/rooms/:roomId/images/:imageId/view',
  rateLimit({ windowMs: 60_000, max: 30, keyFn: ipKey }),
  async (req, res) => {
    const { roomId, imageId } = req.params;

    if (!validRoomId(roomId) || !validRoomId(imageId)) {
      return res.status(400).json({ error: 'Invalid image request.' });
    }

    try {
      const room = await getRoom(roomId);

      if (!room) {
        return res.status(404).json({ error: 'This room has ended or expired.' });
      }

      const participantId = authenticateParticipant(req, roomId);

      if (!participantId) {
        return res.status(403).json({ error: 'Your participant session is invalid.' });
      }

      const metaKey = imageMetaKey(imageId);
      const raw = await redis.get(metaKey);

      if (!raw) {
        return res.status(404).json({ error: 'This image is no longer available.' });
      }

      let metadata;

      try {
        metadata = JSON.parse(raw);
      } catch {
        return res.status(404).json({ error: 'This image is no longer available.' });
      }

      if (metadata.roomId !== roomId || !metadata.eligible.includes(participantId)) {
        return res.status(403).json({ error: 'You are not allowed to view this image.' });
      }

      // Read the encrypted file before claiming the view, so a successful
      // final claim can remove the file without interrupting this response.
      let encryptedBytes;

      try {
        encryptedBytes = await readFile(join(UPLOAD_DIR, metadata.fileName));
      } catch {
        return res.status(404).json({ error: 'This image is no longer available.' });
      }

      const claimScript = `
        local raw = redis.call('GET', KEYS[1])
        if not raw then return {-1, 0} end

        local meta = cjson.decode(raw)
        if meta.roomId ~= ARGV[1] then return {-1, 0} end

        local eligible = false
        for _, id in ipairs(meta.eligible) do
          if id == ARGV[2] then eligible = true end
        end
        if not eligible then return {-2, 0} end

        for _, id in ipairs(meta.viewed) do
          if id == ARGV[2] then return {0, 0} end
        end

        table.insert(meta.viewed, ARGV[2])

        local finished = (#meta.viewed >= #meta.eligible)
        if finished then
          redis.call('DEL', KEYS[1])
          redis.call('SREM', KEYS[2], ARGV[3])
          return {1, 1}
        end

        local ttl = redis.call('TTL', KEYS[1])
        if ttl < 1 then ttl = tonumber(ARGV[4]) end
        redis.call('SET', KEYS[1], cjson.encode(meta), 'EX', ttl)

        return {1, 0}
      `;

      const result = await redis.eval(
        claimScript,
        2,
        metaKey,
        roomImagesKey(roomId),
        roomId,
        participantId,
        imageId,
        String(ROOM_TTL_SECONDS),
      );

      const status = Number(result?.[0]);
      const allViewed = Number(result?.[1]) === 1;

      if (status === 0) {
        return res.status(410).json({ error: 'You have already viewed this image.' });
      }

      if (status !== 1) {
        return res.status(404).json({ error: 'This image is no longer available.' });
      }

      if (allViewed) {
        await unlink(join(UPLOAD_DIR, metadata.fileName)).catch(() => {});
      }

      await touchRoom(room);

      res.set({
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        Pragma: 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });

      return res.status(200).send(encryptedBytes);
    } catch {
      return res.status(503).json({ error: 'Could not open this image right now.' });
    }
  },
);

io.use((socket, next) => {
  if (socket.handshake.auth?.clientVersion !== 1) {
    return next(new Error('Unsupported client.'));
  }

  next();
});

io.on('connection', (socket) => {
  socket.on('room:join', async (payload, ack = () => {}) => {
    try {
      if (!consumeSocketLimit(socket, 'join', 8, 60_000)) {
        return ack({ ok: false, error: 'Too many attempts.' });
      }

      const roomId = String(payload?.roomId || '');
      const pin = String(payload?.pin || '');
      const name = String(payload?.name || '').trim().slice(0, 24);
      const participantId = String(payload?.participantId || '');

      if (
        !PIN_RE.test(pin) ||
        !name ||
        !validRoomId(roomId) ||
        !validParticipantId(participantId)
      ) {
        return ack({ ok: false, error: 'Invalid room details.' });
      }

      const mapped = await redis.get(pinKey(pin));
      const room = await getRoom(roomId);

      if (!room || room.pin !== pin || mapped !== roomId) {
        return ack({ ok: false, error: 'This room has ended or expired.' });
      }

      // Issue a private token for HTTP image upload/view requests.
      const participantToken = crypto.randomBytes(32).toString('base64url');

      participantTokens.set(
        participantTokenKey(roomId, participantId),
        sha256(participantToken),
      );

      socket.data.roomId = roomId;
      socket.data.displayName = name;
      socket.data.participantId = participantId;

      await socket.join(roomId);

      room.participants = io.sockets.adapter.rooms.get(roomId)?.size || 1;
      await touchRoom(room);

      socket.to(roomId).emit('participant:joined', {
        id: socket.id,
        participantId,
        name,
      });

      const members = [...(io.sockets.adapter.rooms.get(roomId) || [])].map((id) => {
        const s = io.sockets.sockets.get(id);

        return {
          id,
          participantId: s?.data?.participantId,
          name: s?.data?.displayName || 'Guest',
        };
      });

      ack({
        ok: true,
        members,
        participantToken,
        expiresInSeconds: ROOM_TTL_SECONDS,
      });
    } catch {
      ack({ ok: false, error: 'Unable to join this room right now.' });
    }
  });

  socket.on('message:send', async (payload, ack = () => {}) => {
    try {
      if (!consumeSocketLimit(socket, 'message', 60, 10_000)) {
        return ack({ ok: false, error: 'You are sending messages too quickly.' });
      }

      const roomId = socket.data.roomId;

      if (
        !roomId ||
        typeof payload?.ciphertext !== 'string' ||
        payload.ciphertext.length > 12_000
      ) {
        return ack({ ok: false, error: 'Invalid message.' });
      }

      const room = await getRoom(roomId);

      if (!room) {
        socket.emit('room:destroyed', { reason: 'expired' });
        return ack({ ok: false, error: 'This room has ended or expired.' });
      }

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

    await touchRoom(room).catch(() => {});
  });
});

server.listen(PORT, () => {
  console.log(`HushRoom server listening on port ${PORT}`);
});
