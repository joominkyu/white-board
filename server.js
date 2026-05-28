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

// rooms: { roomId: [{ socketId, username }] }
const rooms = {};

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  socket.on('join-room', ({ roomId, username }) => {
    if (!rooms[roomId]) rooms[roomId] = [];

    if (rooms[roomId].length >= 2) {
      socket.emit('room-full');
      return;
    }

    rooms[roomId].push({ socketId: socket.id, username });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = username;

    const others = rooms[roomId].filter(u => u.socketId !== socket.id);

    if (others.length > 0) {
      // 먼저 있던 사람에게 새 유저가 왔음을 알림 → 먼저 있던 쪽이 offer 보냄
      socket.to(roomId).emit('user-joined', { socketId: socket.id, username });
    }

    socket.emit('joined', {
      roomId,
      users: rooms[roomId],
    });

    console.log(`${username} joined room ${roomId}, total: ${rooms[roomId].length}`);
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
  socket.on('whiteboard-clear', () => socket.to(socket.data.roomId).emit('whiteboard-clear'));
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
      rooms[roomId] = rooms[roomId].filter(u => u.socketId !== socket.id);
      socket.to(roomId).emit('user-left', { socketId: socket.id, username: socket.data.username });
      if (rooms[roomId].length === 0) delete rooms[roomId];
    }
    console.log('disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
