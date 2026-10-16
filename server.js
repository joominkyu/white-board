require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const jwt = require('jsonwebtoken');

// 봄노트 백엔드와 공유하는 비밀값 — 입장 토큰 검증, 사용 시간 보고에 사용
const LIVE_CLASS_SECRET = process.env.LIVE_CLASS_SECRET;
const BOMNOTE_API_URL = process.env.BOMNOTE_API_URL;
if (!LIVE_CLASS_SECRET) console.warn('LIVE_CLASS_SECRET 미설정 — 수업 입장이 모두 거부됩니다.');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
  // PDF는 HTTP로 업로드하므로 소켓 메시지 크기는 기본값(1MB) 사용
});

app.use(express.static(path.join(__dirname, 'public')));

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_STROKES_PER_ROOM = 10000;
const MAX_POINTS_PER_STROKE = 5000;
const ROOM_EXPIRE_MS = 10 * 60 * 1000; // 모두 나간 뒤 방 상태 보관 시간 (재접속 대비)

// rooms: {
//   roomId(봄노트 수업 ID): {
//     users: [{ socketId, username, uid, role }], host: socketId(선생님),
//     pdf: { buffer, name, version } | null, pdfPage, strokes: [], webUrl, expireTimer,
//     pairedSince: 두 사람이 모두 접속한 시각(ms) | null, relayUsed: TURN 경유 여부,
//     ready: 봄노트에서 저장된 필기를 불러오는 Promise, dirty: 저장 안 된 변경 있음
//   }
// }
const rooms = {};
const BOARD_SAVE_INTERVAL_MS = 10 * 1000;

// ── 봄노트 백엔드에 보고 ──
function bomnoteUrl(path) {
  return `${BOMNOTE_API_URL}/api/live/internal/${path}`;
}

async function notifyBomnote(path, body) {
  if (!BOMNOTE_API_URL) return;
  try {
    const res = await fetch(bomnoteUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Live-Secret': LIVE_CLASS_SECRET },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (e) {
    console.error(`봄노트 보고 실패 (${path}, ${JSON.stringify(body)}):`, e.message);
  }
}

// 사용 시간 — 두 사람이 모두 접속해 있던 시간만
function flushUsage(roomId) {
  const room = rooms[roomId];
  if (!room || !room.pairedSince) return;
  const seconds = Math.floor((Date.now() - room.pairedSince) / 1000);
  if (seconds <= 0) return;
  room.pairedSince += seconds * 1000;
  return notifyBomnote('usage', { sessionId: roomId, seconds, relay: room.relayUsed });
}

// ── 필기·PDF 저장/불러오기 (봄노트가 DB·R2에 보관) ──
async function fetchBoard(roomId) {
  const res = await fetch(bomnoteUrl(`sessions/${encodeURIComponent(roomId)}/board`), {
    headers: { 'X-Live-Secret': LIVE_CLASS_SECRET }
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json(); // { board: { strokes, webUrl } | null, pdfPage, pdf: { name, url } | null }
}

async function downloadPdf(pdf) {
  const res = await fetch(new URL(pdf.url, BOMNOTE_API_URL));
  if (!res.ok) throw new Error(`PDF status ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function loadRoomState(roomId, room) {
  if (!BOMNOTE_API_URL) return;
  try {
    const data = await fetchBoard(roomId);
    room.strokes = data.board?.strokes ?? [];
    room.webUrl = data.board?.webUrl ?? '';
    room.pdfPage = data.pdfPage ?? 1;
    if (data.pdf) room.pdf = { buffer: await downloadPdf(data.pdf), name: data.pdf.name, version: Date.now() };
  } catch (e) {
    console.error(`필기 불러오기 실패 (room ${roomId}):`, e.message);
  }
}

async function saveBoard(roomId, room) {
  if (!BOMNOTE_API_URL) return;
  room.dirty = false;
  try {
    const res = await fetch(bomnoteUrl(`sessions/${encodeURIComponent(roomId)}/board`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Live-Secret': LIVE_CLASS_SECRET },
      body: JSON.stringify({ strokes: room.strokes, webUrl: room.webUrl, pdfPage: room.pdfPage })
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (e) {
    room.dirty = true; // 다음 주기에 다시 시도
    console.error(`필기 저장 실패 (room ${roomId}):`, e.message);
  }
}

function getOrCreateRoom(roomId) {
  if (!rooms[roomId]) {
    const room = { users: [], host: null, pdf: null, pdfPage: 1, strokes: [], webUrl: '', pairedSince: null, relayUsed: false, dirty: false };
    room.ready = loadRoomState(roomId, room);
    rooms[roomId] = room;
  }
  return rooms[roomId];
}

const markDirty = (room) => { room.dirty = true; };

setInterval(() => {
  for (const [roomId, room] of Object.entries(rooms)) if (room.dirty) saveBoard(roomId, room);
}, BOARD_SAVE_INTERVAL_MS);

// 재배포·재시작 시 (Railway는 SIGTERM) 저장 안 된 필기와 사용 시간을 보내고 종료
process.on('SIGTERM', async () => {
  await Promise.all(Object.entries(rooms).map(([roomId, room]) =>
    Promise.all([flushUsage(roomId), room.dirty ? saveBoard(roomId, room) : null])
  ));
  process.exit(0);
});

// 서버가 갑자기 꺼져도 최대 1분만 누락되도록 주기적으로 보고
setInterval(() => Object.keys(rooms).forEach(flushUsage), 60 * 1000);

const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function cleanPoints(points, max) {
  if (!Array.isArray(points) || points.length === 0 || points.length > max) return null;
  if (!points.every(p => Array.isArray(p) && isNum(p[0]) && isNum(p[1]))) return null;
  return points.map(p => [p[0], p[1]]);
}

function cleanStroke(s, owner) {
  if (!s || !isStr(s.id, 64)) return null;
  if (!['path', 'line', 'shape'].includes(s.kind)) return null;
  if (!Number.isInteger(s.page) || s.page < 0) return null;
  if (!isStr(s.color, 20) || !isNum(s.size)) return null;
  const points = cleanPoints(s.points, MAX_POINTS_PER_STROKE);
  if (!points) return null;
  return {
    id: s.id,
    owner,
    page: s.page,
    kind: s.kind,
    tool: s.tool === 'eraser' ? 'eraser' : 'pen',
    shape: ['rect', 'triangle', 'circle'].includes(s.shape) ? s.shape : 'rect',
    filled: !!s.filled,
    color: s.color,
    size: s.size,
    points
  };
}

function roomStatePayload(room) {
  return {
    pdf: room.pdf ? { name: room.pdf.name, version: room.pdf.version } : null,
    pdfPage: room.pdfPage,
    strokes: room.strokes,
    webUrl: room.webUrl
  };
}

// 같은 방에 있는 상대인지 확인 (시그널링 대상 검증)
function isRoommate(socket, targetId) {
  const room = rooms[socket.data.roomId];
  return !!room && room.users.some(u => u.socketId === targetId);
}

function removeUser(roomId, socketId) {
  const room = rooms[roomId];
  if (!room) return;
  const user = room.users.find(u => u.socketId === socketId);
  if (!user) return;
  room.users = room.users.filter(u => u.socketId !== socketId);

  // 한 명이 나가면 그때까지의 수업 시간 보고
  if (room.users.length < 2) { flushUsage(roomId); room.pairedSince = null; }

  // 방장은 선생님 고정 — 선생님이 나가면 방장 없음
  if (room.host === socketId) room.host = null;

  io.to(roomId).except(socketId).emit('user-left', { socketId, username: user.username });

  if (room.users.length === 0) {
    room.expireTimer = setTimeout(async () => {
      if (rooms[roomId] !== room || room.users.length > 0) return;
      if (room.dirty) await saveBoard(roomId, room);
      if (rooms[roomId] !== room || room.users.length > 0) return; // 저장하는 사이 다시 입장함
      delete rooms[roomId];
      notifyBomnote('end', { sessionId: roomId }); // 학생 [수업 입장] 배너 숨김
    }, ROOM_EXPIRE_MS);
  }
}

// ── PDF 업로드/다운로드 ──
app.post('/rooms/:roomId/pdf', express.raw({ type: 'application/pdf', limit: MAX_PDF_BYTES }), (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms[roomId];
  const uploader = io.sockets.sockets.get(req.get('X-Socket-Id') || '');
  if (!room || !uploader || uploader.data.roomId !== roomId) return res.status(403).end();
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).end();

  let name = 'document.pdf';
  try { name = decodeURIComponent(req.get('X-File-Name') || name).slice(0, 200); } catch (_) {}

  const version = Date.now();
  room.pdf = { buffer: req.body, name, version };
  room.pdfPage = 1;
  room.strokes = room.strokes.filter(s => s.page === 0); // 이전 PDF 필기 제거
  markDirty(room);
  uploader.to(roomId).emit('pdf-updated', { name, version });
  res.json({ version });

  // 봄노트에 보관 (수업은 메모리의 PDF로 계속 진행되므로 기다리지 않음)
  if (BOMNOTE_API_URL) {
    fetch(bomnoteUrl(`sessions/${encodeURIComponent(roomId)}/pdf`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', 'X-Live-Secret': LIVE_CLASS_SECRET, 'X-File-Name': encodeURIComponent(name) },
      body: req.body
    }).then(r => { if (!r.ok) throw new Error(`status ${r.status}`); })
      .catch(e => console.error(`PDF 보관 실패 (room ${roomId}):`, e.message));
  }
});

app.get('/rooms/:roomId/pdf', (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room || !room.pdf) return res.status(404).end();
  res.type('application/pdf').send(room.pdf.buffer);
});

// ── 지난 수업 보기 전용 (봄노트가 발급한 review 토큰, Authorization 헤더) ──
function reviewRoomId(req) {
  try {
    const claims = jwt.verify((req.get('Authorization') || '').replace(/^Bearer /, ''), LIVE_CLASS_SECRET);
    return claims.role === 'review' ? String(claims.sid) : null;
  } catch (_) {
    return null;
  }
}

app.get('/review/state', async (req, res) => {
  const roomId = reviewRoomId(req);
  if (!roomId) return res.status(401).end();
  try {
    // 수업이 진행 중이면 메모리의 최신 상태, 아니면 봄노트에 저장된 상태
    const room = rooms[roomId];
    if (room) {
      await room.ready;
      return res.json({ strokes: room.strokes, pdfPage: room.pdfPage, pdf: room.pdf ? { name: room.pdf.name } : null });
    }
    const data = await fetchBoard(roomId);
    res.json({ strokes: data.board?.strokes ?? [], pdfPage: data.pdfPage ?? 1, pdf: data.pdf ? { name: data.pdf.name } : null });
  } catch (e) {
    console.error(`다시 보기 불러오기 실패 (room ${roomId}):`, e.message);
    res.status(502).end();
  }
});

app.get('/review/pdf', async (req, res) => {
  const roomId = reviewRoomId(req);
  if (!roomId) return res.status(401).end();
  try {
    const room = rooms[roomId];
    if (room) await room.ready;
    if (room?.pdf) return res.type('application/pdf').send(room.pdf.buffer);
    const data = await fetchBoard(roomId);
    if (!data.pdf) return res.status(404).end();
    res.type('application/pdf').send(await downloadPdf(data.pdf));
  } catch (e) {
    console.error(`다시 보기 PDF 실패 (room ${roomId}):`, e.message);
    res.status(502).end();
  }
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).end();
  next(err);
});

// ── TURN 자격증명 (Cloudflare) ──
const FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp'
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];

async function getIceServers() {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const token = process.env.CLOUDFLARE_TURN_API_TOKEN;
  if (!keyId || !token) return FALLBACK_ICE_SERVERS;
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 })
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const { iceServers } = await res.json();
    // 브라우저는 53번 포트를 차단하므로 제외
    return iceServers.map(s => ({
      ...s,
      urls: [].concat(s.urls).filter(u => !/:53(\?|$)/.test(u))
    }));
  } catch (e) {
    console.error('TURN 자격증명 발급 실패:', e.message);
    return FALLBACK_ICE_SERVERS;
  }
}

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  // 봄노트가 발급한 입장 토큰으로만 입장 — { sid: 수업 ID, uid, name, role: 'teacher'|'student' }
  socket.on('join-room', async ({ token } = {}) => {
    let claims;
    try {
      claims = jwt.verify(token, LIVE_CLASS_SECRET);
    } catch (_) {
      socket.emit('auth-failed');
      return;
    }
    const roomId = String(claims.sid);
    const uid = String(claims.uid);
    const username = String(claims.name).slice(0, 20);
    if (claims.role === 'review') { socket.emit('auth-failed'); return; } // 보기 전용 토큰으로는 수업 입장 불가
    const role = claims.role === 'teacher' ? 'teacher' : 'student';

    const room = getOrCreateRoom(roomId);
    clearTimeout(room.expireTimer);
    await room.ready; // 저장된 필기·PDF 불러오기 (서버 재시작 후 첫 입장)
    if (!socket.connected) return;

    // 재접속·새 탭: 같은 사람의 이전 소켓이 남아 있으면 정리
    const stale = room.users.find(u => u.uid === uid && u.socketId !== socket.id);
    if (stale) {
      const staleSocket = io.sockets.sockets.get(stale.socketId);
      removeUser(roomId, stale.socketId);
      if (staleSocket) { staleSocket.data.roomId = null; staleSocket.disconnect(true); }
    }

    if (room.users.length >= 2) {
      socket.emit('room-full');
      return;
    }

    if (role === 'teacher') room.host = socket.id;
    room.users.push({ socketId: socket.id, username, uid, role });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = username;
    socket.data.clientId = uid; // 획 주인 식별 (재접속해도 같은 사람)
    if (room.users.length === 2) room.pairedSince = Date.now();

    socket.to(roomId).emit('user-joined', { socketId: socket.id, username });

    socket.emit('joined', {
      roomId,
      me: uid,
      users: room.users.map(u => ({ socketId: u.socketId, username: u.username })),
      isHost: room.host === socket.id,
      state: roomStatePayload(room)
    });

    console.log(`${username} joined room ${roomId} (host: ${room.host === socket.id}), total: ${room.users.length}`);
  });

  // 클라이언트가 TURN 경유로 연결됐는지 알려줌 (비용 측정용)
  socket.on('connection-info', ({ relay } = {}) => {
    const room = rooms[socket.data.roomId];
    if (room && relay === true) room.relayUsed = true;
  });

  socket.on('get-ice-servers', async (cb) => {
    if (typeof cb !== 'function' || !socket.data.roomId) return;
    cb(await getIceServers());
  });

  // ── WebRTC 시그널링 (같은 방 상대에게만) ──
  socket.on('offer', ({ offer, to } = {}) => {
    if (!isRoommate(socket, to)) return;
    io.to(to).emit('offer', { offer, from: socket.id, username: socket.data.username });
  });
  socket.on('answer', ({ answer, to } = {}) => {
    if (!isRoommate(socket, to)) return;
    io.to(to).emit('answer', { answer, from: socket.id });
  });
  socket.on('ice-candidate', ({ candidate, to } = {}) => {
    if (!isRoommate(socket, to)) return;
    io.to(to).emit('ice-candidate', { candidate, from: socket.id });
  });

  // ── 텍스트 채팅 ──
  socket.on('chat-message', (message) => {
    const roomId = socket.data.roomId;
    if (!roomId || !isStr(message, 300)) return;
    io.to(roomId).emit('chat-message', {
      username: socket.data.username,
      message,
      time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' })
    });
  });

  // ── 화이트보드: 획 단위 동기화 ──
  socket.on('stroke-start', (data) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.strokes.length >= MAX_STROKES_PER_ROOM) return;
    const stroke = cleanStroke(data, socket.data.clientId);
    if (!stroke || room.strokes.some(s => s.id === stroke.id)) return;
    room.strokes.push(stroke);
    markDirty(room);
    socket.to(socket.data.roomId).emit('stroke-start', stroke);
  });

  socket.on('stroke-points', ({ id, points } = {}) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    const stroke = room.strokes.findLast(s => s.id === id);
    if (!stroke || stroke.owner !== socket.data.clientId) return;
    const clean = cleanPoints(points, MAX_POINTS_PER_STROKE - stroke.points.length);
    if (!clean) return;
    stroke.points.push(...clean);
    markDirty(room);
    socket.to(socket.data.roomId).emit('stroke-points', { id, points: clean });
  });

  socket.on('stroke-undo', (id) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    const idx = room.strokes.findIndex(s => s.id === id && s.owner === socket.data.clientId);
    if (idx === -1) return;
    room.strokes.splice(idx, 1);
    markDirty(room);
    socket.to(socket.data.roomId).emit('stroke-removed', id);
  });

  // 현재 페이지 전체 지우기 — 방장만 허용
  socket.on('board-clear', (page) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.host !== socket.id || !Number.isInteger(page)) return;
    room.strokes = room.strokes.filter(s => s.page !== page);
    markDirty(room);
    socket.to(socket.data.roomId).emit('board-cleared', page);
  });

  // 기기 목록 공유 (비방장 → 방장에게만 전달)
  socket.on('user-devices', (devices) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.host === socket.id) return;
    io.to(room.host).emit('remote-devices', devices);
  });

  // 기기 목록 요청 (방장 → 상대방에게 요청)
  socket.on('request-user-devices', () => {
    const room = rooms[socket.data.roomId];
    if (!room || room.host !== socket.id) return;
    socket.to(socket.data.roomId).emit('devices-requested');
  });

  // 방장이 상대방 기기 전환 명령
  socket.on('host-switch-device', (data) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.host !== socket.id) return;
    socket.to(socket.data.roomId).emit('host-switch-device', data);
  });

  // 방장이 상대방 마이크 제어
  socket.on('host-control-mic', ({ muted } = {}) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.host !== socket.id) return;
    socket.to(socket.data.roomId).emit('host-control-mic', { muted: !!muted });
  });

  // 웹 공유
  socket.on('web-navigate', (url) => {
    const room = rooms[socket.data.roomId];
    if (!room || !isStr(url, 2000) || !/^https?:\/\//i.test(url)) return;
    room.webUrl = url;
    markDirty(room);
    socket.to(socket.data.roomId).emit('web-navigate', url);
  });

  // ── PDF 페이지 동기화 ──
  socket.on('pdf-page-change', (page) => {
    const room = rooms[socket.data.roomId];
    if (!room || !room.pdf || !Number.isInteger(page) || page < 1) return;
    room.pdfPage = page;
    markDirty(room);
    socket.to(socket.data.roomId).emit('pdf-page-change', page);
  });

  socket.on('disconnect', () => {
    if (socket.data.roomId) removeUser(socket.data.roomId, socket.id);
    console.log('disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
