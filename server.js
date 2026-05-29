const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 50 * 1024 * 1024 // PDF 전송 50MB 허용
});

app.use(express.static(path.join(__dirname, 'public')));

// rooms: { roomId: { users: [{ socketId, username }], host: socketId } }
const rooms = {};

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  socket.on('join-room', ({ roomId, username }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = { users: [], host: socket.id };
    }

    if (rooms[roomId].users.length >= 2) {
      socket.emit('room-full');
      return;
    }

    const isHost = rooms[roomId].host === socket.id;
    rooms[roomId].users.push({ socketId: socket.id, username });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = username;

    const others = rooms[roomId].users.filter(u => u.socketId !== socket.id);

    if (others.length > 0) {
      socket.to(roomId).emit('user-joined', { socketId: socket.id, username });
    }

    socket.emit('joined', {
      roomId,
      users: rooms[roomId].users,
      isHost,
      hostSocketId: rooms[roomId].host
    });

    console.log(`${username} joined room ${roomId} (host: ${isHost}), total: ${rooms[roomId].users.length}`);
  });

  // ── WebRTC 시그널링 ──
  socket.on('offer', ({ offer, to }) => {
    io.to(to).emit('offer', { offer, from: socket.id, username: socket.data.username });
  });
  socket.on('answer', ({ answer, to }) => {
    io.to(to).emit('answer', { answer, from: socket.id });
  });
  socket.on('ice-candidate', ({ candidate, to }) => {
    io.to(to).emit('ice-candidate', { candidate, from: socket.id });
  });

  // ── 텍스트 채팅 ──
  socket.on('chat-message', (message) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    io.to(roomId).emit('chat-message', {
      username: socket.data.username,
      message,
      time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    });
  });

  // ── 화이트보드 드로잉 동기화 ──
  socket.on('draw-start', (data) => socket.to(socket.data.roomId).emit('draw-start', data));
  socket.on('draw-move', (data) => socket.to(socket.data.roomId).emit('draw-move', data));
  socket.on('draw-end', () => socket.to(socket.data.roomId).emit('draw-end'));
  socket.on('draw-shape', (data) => socket.to(socket.data.roomId).emit('draw-shape', data));
  socket.on('draw-line',  (data) => socket.to(socket.data.roomId).emit('draw-line',  data));

  // 기기 목록 공유 (비방장 → 방장에게만 전달)
  socket.on('user-devices', (devices) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    const hostId = rooms[roomId].host;
    if (hostId !== socket.id) {
      io.to(hostId).emit('remote-devices', devices);
    }
  });

  // 기기 목록 요청 (방장 → 상대방에게 요청)
  socket.on('request-user-devices', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    if (rooms[roomId].host !== socket.id) return;
    socket.to(roomId).emit('devices-requested');
  });

  // 방장이 상대방 기기 전환 명령
  socket.on('host-switch-device', (data) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    if (rooms[roomId].host !== socket.id) return;
    socket.to(roomId).emit('host-switch-device', data);
  });

  // 방장이 상대방 마이크 제어
  socket.on('host-control-mic', ({ muted }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    if (rooms[roomId].host !== socket.id) return;
    socket.to(roomId).emit('host-control-mic', { muted });
  });

  // 전체 지우기 — 방장만 허용
  socket.on('whiteboard-clear', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    if (rooms[roomId].host !== socket.id) return;
    socket.to(roomId).emit('whiteboard-clear');
  });

  socket.on('whiteboard-undo', (imageData) => socket.to(socket.data.roomId).emit('whiteboard-undo', imageData));

  // 웹 공유
  socket.on('web-navigate', (url) => socket.to(socket.data.roomId).emit('web-navigate', url));
  socket.on('request-web-url', (targetId) => io.to(targetId).emit('web-url-request', socket.id));
  socket.on('web-url-response', ({ to, url }) => io.to(to).emit('web-url-response', url));

  // ── PDF 공유 (base64 relay) ──
  socket.on('pdf-upload', (data) => socket.to(socket.data.roomId).emit('pdf-upload', data));
  socket.on('pdf-page-change', (page) => socket.to(socket.data.roomId).emit('pdf-page-change', page));

  // ── 화이트보드 상태 동기화 (신규 입장자 요청) ──
  socket.on('request-board-state', (targetSocketId) => {
    io.to(targetSocketId).emit('board-state-request', socket.id);
  });
  socket.on('board-state-response', ({ to, imageData, pdfPage }) => {
    io.to(to).emit('board-state-response', { imageData, pdfPage });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (roomId && rooms[roomId]) {
      rooms[roomId].users = rooms[roomId].users.filter(u => u.socketId !== socket.id);

      // 방장이 나가면 남은 사람에게 방장 이전
      if (rooms[roomId].host === socket.id && rooms[roomId].users.length > 0) {
        rooms[roomId].host = rooms[roomId].users[0].socketId;
        io.to(rooms[roomId].host).emit('host-transferred');
      }

      socket.to(roomId).emit('user-left', { socketId: socket.id, username: socket.data.username });
      if (rooms[roomId].users.length === 0) delete rooms[roomId];
    }
    console.log('disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
