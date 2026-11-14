'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// In-memory room store. Lost on restart/redeploy.
const rooms = new Map();

// Room timeout: 30 minutes of inactivity
const ROOM_TTL_MS = 30 * 60 * 1000;
// Cleanup interval
const CLEANUP_INTERVAL_MS = 60 * 1000;

const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      mediaSrc: ["'self'", "blob:"],
      connectSrc: ["'self'", "wss:", "ws:"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// Rate limiting for HTTP endpoints
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'অনেক বেশি অনুরোধ। একটু পরে আবার চেষ্টা করুন।' }
});
app.use(limiter);

// Stricter limit for room creation
const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'রুম তৈরির সীমা অতিক্রম করেছে। একটু পরে আবার চেষ্টা করুন।' }
});

app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  etag: true
}));

// Health check for Railway
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    rooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

// Generate cryptographically strong room ID
function generateRoomId() {
  return crypto.randomBytes(16).toString('hex'); // 32 char hex
}

// Create room
app.post('/api/rooms', createLimiter, (req, res) => {
  const roomId = generateRoomId();
  const now = Date.now();

  rooms.set(roomId, {
    id: roomId,
    participants: new Map(), // ws -> { id, joinedAt }
    createdAt: now,
    lastActivity: now,
    maxParticipants: 2
  });

  res.status(201).json({
    roomId,
    message: 'রুম তৈরি হয়েছে'
  });
});

// Check room exists (without joining)
app.get('/api/rooms/:roomId', (req, res) => {
  const roomId = req.params.roomId;
  if (!/^[a-f0-9]{32}$/.test(roomId)) {
    return res.status(400).json({ error: 'অবৈধ রুম আইডি' });
  }

  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: 'রুম পাওয়া যায়নি বা মেয়াদ শেষ' });
  }

  res.json({
    roomId: room.id,
    participantCount: room.participants.size,
    maxParticipants: room.maxParticipants,
    createdAt: room.createdAt
  });
});

// Serve SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);

// WebSocket server for signaling only
const wss = new WebSocketServer({ server, path: '/ws' });

// Track connections for rate limiting (simple in-memory)
const wsConnections = new Map(); // ip -> count

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';

  // Simple connection limit per IP
  const count = (wsConnections.get(ip) || 0) + 1;
  if (count > 20) {
    ws.close(1008, 'Connection limit exceeded');
    return;
  }
  wsConnections.set(ip, count);

  let currentRoomId = null;
  let participantId = null;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let data;
    try {
      // Limit message size for signaling (should be small)
      if (raw.length > 64 * 1024) {
        ws.send(JSON.stringify({ type: 'error', message: 'সিগন্যালিং মেসেজ খুব বড়' }));
        return;
      }
      data = JSON.parse(raw.toString());
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'অবৈধ JSON' }));
      return;
    }

    if (!data || typeof data.type !== 'string') {
      ws.send(JSON.stringify({ type: 'error', message: 'অবৈধ মেসেজ ফরম্যাট' }));
      return;
    }

    switch (data.type) {
      case 'join':
        handleJoin(ws, data, ip);
        break;
      case 'signal':
        handleSignal(ws, data);
        break;
      case 'leave':
        handleLeave(ws);
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        break;
      default:
        ws.send(JSON.stringify({ type: 'error', message: 'অজানা মেসেজ টাইপ' }));
    }
  });

  function handleJoin(ws, data, ip) {
    const roomId = data.roomId;
    if (!roomId || typeof roomId !== 'string' || !/^[a-f0-9]{32}$/.test(roomId)) {
      ws.send(JSON.stringify({ type: 'error', message: 'অবৈধ রুম আইডি' }));
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      ws.send(JSON.stringify({ type: 'error', message: 'রুম পাওয়া যায়নি বা মেয়াদ শেষ' }));
      return;
    }

    if (room.participants.size >= room.maxParticipants) {
      ws.send(JSON.stringify({ type: 'error', message: 'রুম পূর্ণ। সর্বোচ্চ ২ জন।' }));
      return;
    }

    // Already in a room?
    if (currentRoomId) {
      handleLeave(ws);
    }

    participantId = crypto.randomBytes(8).toString('hex');
    room.participants.set(ws, {
      id: participantId,
      joinedAt: Date.now(),
      ip // only for internal cleanup, not exposed
    });
    room.lastActivity = Date.now();
    currentRoomId = roomId;

    // Notify the new participant
    ws.send(JSON.stringify({
      type: 'joined',
      roomId,
      participantId,
      participantCount: room.participants.size,
      isInitiator: room.participants.size === 1
    }));

    // Notify existing participants
    for (const [otherWs, info] of room.participants) {
      if (otherWs !== ws && otherWs.readyState === 1) {
        otherWs.send(JSON.stringify({
          type: 'peer-joined',
          participantCount: room.participants.size
        }));
      }
    }
  }

  function handleSignal(ws, data) {
    if (!currentRoomId) {
      ws.send(JSON.stringify({ type: 'error', message: 'প্রথমে রুমে যোগ দিন' }));
      return;
    }

    const room = rooms.get(currentRoomId);
    if (!room) {
      ws.send(JSON.stringify({ type: 'error', message: 'রুম আর নেই' }));
      return;
    }

    room.lastActivity = Date.now();

    // Forward signal to the other peer only. Never store or log payload.
    const payload = {
      type: 'signal',
      from: participantId,
      signal: data.signal // offer / answer / ice-candidate
    };

    for (const [otherWs] of room.participants) {
      if (otherWs !== ws && otherWs.readyState === 1) {
        otherWs.send(JSON.stringify(payload));
      }
    }
  }

  function handleLeave(ws) {
    if (!currentRoomId) return;

    const room = rooms.get(currentRoomId);
    if (room) {
      room.participants.delete(ws);
      room.lastActivity = Date.now();

      // Notify remaining peer
      for (const [otherWs] of room.participants) {
        if (otherWs.readyState === 1) {
          otherWs.send(JSON.stringify({
            type: 'peer-left',
            participantCount: room.participants.size
          }));
        }
      }

      // Clean empty rooms immediately
      if (room.participants.size === 0) {
        rooms.delete(currentRoomId);
      }
    }

    currentRoomId = null;
    participantId = null;
  }

  ws.on('close', () => {
    handleLeave(ws);
    const c = (wsConnections.get(ip) || 1) - 1;
    if (c <= 0) wsConnections.delete(ip);
    else wsConnections.set(ip, c);
  });

  ws.on('error', () => {
    handleLeave(ws);
  });
});

// Heartbeat to detect dead connections
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Cleanup inactive rooms
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (now - room.lastActivity > ROOM_TTL_MS) {
      // Close all sockets in the room
      for (const [ws] of room.participants) {
        try {
          ws.send(JSON.stringify({ type: 'error', message: 'রুম মেয়াদ শেষ হয়েছে' }));
          ws.close(1000, 'Room expired');
        } catch (_) {}
      }
      rooms.delete(roomId);
    }
  }
}, CLEANUP_INTERVAL_MS);

// Graceful shutdown
function shutdown() {
  clearInterval(heartbeatInterval);
  clearInterval(cleanupInterval);
  wss.clients.forEach((ws) => ws.close(1001, 'Server shutting down'));
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`ZEROCHAT server running on http://${HOST}:${PORT}`);
  console.log(`WebSocket signaling at ws://${HOST}:${PORT}/ws`);
  console.log(`Health check: http://${HOST}:${PORT}/health`);
  console.log('Rooms are in-memory only. They will be lost on restart.');
});
