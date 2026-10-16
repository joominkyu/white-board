/* ────────────────────────────────────────────
   화상 화이트보드 클라이언트
──────────────────────────────────────────── */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// 서버에서 TURN 자격증명을 못 받았을 때 사용
const FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

// 이 브라우저 탭 고유 ID — 재접속해도 유지되어 내 획 식별에 사용
const clientId = uid();

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ── 상태 ──
let socket, localStream, peerConnection;
let myUsername = '', myRoomId = '', remoteSocketId = '';
let hasJoined = false;
let iceConfigPromise = null;
let pendingCandidates = [];
let isOfferer = false;
let micOn = true, camOn = true;
let micVolumeVal = 100, speakerVolumeVal = 100;
let micAudioCtx = null, micGainNode = null, gainedAudioTrack = null;
let selectedMicId = '', selectedCamId = '', selectedSpeakerId = '';
let isDrawing = false;
let shapeFilled = false;
let isHost = false;
let remoteMicMuted = false;
let currentTool = 'pen';
let strokeColor = '#000000';
let strokeSize = 4;
let lastX = 0, lastY = 0;
let currentShape   = 'rect'; // 'rect' | 'triangle' | 'circle'
let currentPenMode = 'free'; // 'free' | 'line' | 'snap'
let shapeStartX = 0, shapeStartY = 0;

// PDF 상태
let pdfDoc = null, pdfCurrentPage = 1, pdfTotalPages = 0, pdfVersion = null;
let pdfRenderSeq = 0, pdfRenderTask = null;

// 줌
let zoomLevel = 1.0;
let zoomHideTimer = null;
let pdfBaseScale = 1;
let zoomRenderTimer = null;
let canvasZoom = 1; // 캔버스 해상도에 반영된 줌 (PDF는 줌 배율로 다시 렌더링, 빈 보드는 1)

// 녹화 상태
let mediaRecorder = null, recordChunks = [], recordTimer = null;
let audioCtx = null, recTimerInterval = null, recStartTime = 0;

// 획 데이터 — 좌표는 캔버스 대비 0~1 비율, 굵기는 캔버스 너비 대비 비율
// { id, owner, page, kind: 'path'|'line'|'shape', tool, shape, filled, color, size, points: [[x,y], ...] }
let strokes = [];
let myStroke = null; // 그리는 중인 내 자유선 획

// ── DOM ──
const lobby        = document.getElementById('lobby');
const roomEl       = document.getElementById('room');
const usernameInput = document.getElementById('username-input');
const roomInput    = document.getElementById('room-input');
const joinBtn      = document.getElementById('join-btn');
const lobbyError   = document.getElementById('lobby-error');
const roomTitle    = document.getElementById('room-title');
const leaveBtn     = document.getElementById('leave-btn');
const statusBadge  = document.getElementById('connection-status');
const localVideo   = document.getElementById('local-video');
const remoteVideo  = document.getElementById('remote-video');
const waitingOverlay = document.getElementById('waiting-overlay');
const remoteLabel  = document.getElementById('remote-label');
const localLabel   = document.getElementById('local-label');
const settingsBtn  = document.getElementById('settings-btn');
const settingsModal= document.getElementById('settings-modal');
const settingsClose= document.getElementById('settings-close');
const camSelect    = document.getElementById('cam-select');
const micSelect    = document.getElementById('mic-select');
const speakerSelect= document.getElementById('speaker-select');
const settingsCamToggle = document.getElementById('settings-cam-toggle');
const settingsMicToggle = document.getElementById('settings-mic-toggle');
const micVolumeSlider   = document.getElementById('mic-volume-slider');
const micVolumeDisplay  = document.getElementById('mic-volume-display');
const speakerVolumeSlider  = document.getElementById('speaker-volume-slider');
const speakerVolumeDisplay = document.getElementById('speaker-volume-display');
const chatMessages = document.getElementById('chat-messages');
const chatInput    = document.getElementById('chat-input');
const sendBtn      = document.getElementById('send-btn');

// 화이트보드
const canvasContainer = document.getElementById('canvas-container');
const pdfCanvas     = document.getElementById('pdf-canvas');
const drawCanvas    = document.getElementById('draw-canvas');
const previewCanvas = document.getElementById('preview-canvas');
const pdfCtx        = pdfCanvas.getContext('2d');
const drawCtx       = drawCanvas.getContext('2d');
const previewCtx    = previewCanvas.getContext('2d');
const toolPen      = document.getElementById('tool-pen');
const toolEraser   = document.getElementById('tool-eraser');
const colorSwatches = document.querySelectorAll('.color-swatch');
const sizeSlider   = document.getElementById('size-slider');
const sizeDisplay  = document.getElementById('size-display');
const pdfBtn       = document.getElementById('pdf-btn');
const pdfInput     = document.getElementById('pdf-input');
const pdfNav       = document.getElementById('pdf-nav');
const pdfPrev      = document.getElementById('pdf-prev');
const pdfNext      = document.getElementById('pdf-next');
const pdfPageInfo  = document.getElementById('pdf-page-info');
const pagesPanel    = document.getElementById('pages-panel');
const pagesList     = document.getElementById('pages-list');
const canvasWrapper = document.getElementById('canvas-wrapper');
const canvasInner   = document.getElementById('canvas-inner');
const zoomIndicator = document.getElementById('zoom-indicator');

// 모드 탭
const wbContent   = document.getElementById('wb-content');
const webContent  = document.getElementById('web-content');
const modeWbBtn   = document.getElementById('mode-wb');
const modeWebBtn  = document.getElementById('mode-web');
const clearAllBtn = document.getElementById('clear-all-btn');

// 웹 패널
const webFrame    = document.getElementById('web-frame');
const webUrlInput = document.getElementById('web-url');
const webGoBtn    = document.getElementById('web-go');
const webBack     = document.getElementById('web-back');
const webForward  = document.getElementById('web-forward');
const webRefresh  = document.getElementById('web-refresh');
const webNewtab   = document.getElementById('web-newtab');
const webBlocked  = document.getElementById('web-blocked');
const webOpenLink = document.getElementById('web-open-link');
const recordBtn    = document.getElementById('record-btn');
const recIndicator = document.getElementById('rec-indicator');
const recTimer     = document.getElementById('rec-timer');
const copyLinkBtn    = document.getElementById('copy-link-btn');
const chatToggleBtn  = document.getElementById('chat-toggle-btn');
const chatCloseBtn   = document.getElementById('chat-close-btn');
const remoteControls       = document.getElementById('remote-controls');
const remoteMicBtn         = document.getElementById('remote-mic-btn');
const remoteVolSlider      = document.getElementById('remote-vol-slider');
const remoteVolDisplay     = document.getElementById('remote-vol-display');
const remoteSettingsBtn    = document.getElementById('remote-settings-btn');
const remoteSettingsModal  = document.getElementById('remote-settings-modal');
const remoteSettingsClose  = document.getElementById('remote-settings-close');
const remoteCamSelect      = document.getElementById('remote-cam-select');
const remoteMicSelect      = document.getElementById('remote-mic-select');
const remoteSpeakerSelect  = document.getElementById('remote-speaker-select');
const remoteSettingsHint   = document.getElementById('remote-settings-hint');
const chatSection    = document.querySelector('.chat-section');

/* ════════════════════════════════════════════
   로비
════════════════════════════════════════════ */

// URL에 ?room=xxx 이 있으면 방 이름 자동 입력
(function () {
  const params = new URLSearchParams(window.location.search);
  const r = params.get('room');
  if (r) roomInput.value = r;
})();

// 추측하기 어려운 방 이름 생성
document.getElementById('random-room-btn').addEventListener('click', () => {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  roomInput.value = Array.from(bytes, b => chars[b % chars.length]).join('');
});

joinBtn.addEventListener('click', joinRoom);
[usernameInput, roomInput].forEach(el =>
  el.addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); })
);

function joinRoom() {
  const username = usernameInput.value.trim();
  const roomId   = roomInput.value.trim();
  if (!username) { lobbyError.textContent = '닉네임을 입력하세요.'; return; }
  if (!roomId)   { lobbyError.textContent = '방 이름을 입력하세요.'; return; }
  lobbyError.textContent = '';
  myUsername = username;
  myRoomId = roomId;
  initApp();
}

async function initApp() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    localLabel.textContent = myUsername;
    selectedMicId = localStream.getAudioTracks()[0]?.getSettings().deviceId || '';
    selectedCamId = localStream.getVideoTracks()[0]?.getSettings().deviceId || '';
  } catch (e) {
    localStream = null;
    showSystemMsg('카메라/마이크를 사용할 수 없습니다.');
    // 로컬 비디오 박스에 안내 표시
    const nocam = document.createElement('div');
    nocam.className = 'nocam-overlay';
    nocam.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:4px;background:#0a0c14;color:#8892a4;font-size:11px;text-align:center;padding:8px;z-index:1;';
    nocam.innerHTML = '<span style="font-size:20px">📵</span><span>카메라/마이크<br>권한을 허용해주세요</span>';
    localVideo.parentElement.appendChild(nocam);
  }

  // getUserMedia try-catch 밖에서 호출 — 실패해도 카메라 스트림에 영향 없음
  try { setupMicGain(); } catch (_) {}

  socket = io();
  setupSocketEvents();
  // 최초 연결과 재연결 모두 방에 (다시) 입장
  socket.on('connect', () => {
    socket.emit('join-room', { roomId: myRoomId, username: myUsername, clientId });
  });

  lobby.classList.add('hidden');
  roomEl.classList.remove('hidden');
  roomTitle.textContent = `# ${myRoomId}`;
  initCanvasSize();

  // URL에 방 이름 반영 (링크 공유용)
  const shareUrl = new URL(window.location.href);
  shareUrl.searchParams.set('room', myRoomId);
  window.history.replaceState({}, '', shareUrl.toString());

  // 입장 후 기기 목록 공유 (방장이 상대방 기기 설정할 수 있도록)
  setTimeout(emitUserDevices, 1000);
}

/* ════════════════════════════════════════════
   Socket.io 이벤트
════════════════════════════════════════════ */
function setupSocketEvents() {

  socket.on('joined', async ({ users, isHost: host, state }) => {
    if (hasJoined) showSystemMsg('서버에 다시 연결되었습니다.');
    hasJoined = true;
    isHost = host;
    updateHostUI();
    const others = users.filter(u => u.socketId !== socket.id);
    if (others.length > 0) {
      remoteSocketId = others[0].socketId;
      remoteLabel.textContent = others[0].username;
    }
    await applyRoomState(state);
  });

  socket.on('disconnect', (reason) => {
    // 직접 나간 경우(io client disconnect)는 안내하지 않음
    if (reason !== 'io client disconnect') showSystemMsg('서버 연결이 끊겼습니다. 다시 연결하는 중...');
  });

  socket.on('host-transferred', () => {
    isHost = true;
    updateHostUI();
    showSystemMsg('방장이 나가서 회원님이 방장이 되었습니다.');
  });

  socket.on('room-full', () => {
    leaveRoom();
    alert('방이 꽉 찼습니다 (최대 2명).');
  });

  // 상대방이 나중에 들어옴 → 내가 offer를 보냄 (보드 상태는 서버가 직접 전달)
  socket.on('user-joined', async ({ socketId, username }) => {
    remoteSocketId = socketId;
    remoteLabel.textContent = username;
    showSystemMsg(`${username}님이 입장했습니다.`);
    await startCall();
  });

  socket.on('offer', async ({ offer, from, username }) => {
    remoteSocketId = from;
    isOfferer = false;
    if (!remoteLabel.textContent || remoteLabel.textContent === '상대방') {
      remoteLabel.textContent = username || '상대방';
    }
    await createPeerConnection();
    await peerConnection.setRemoteDescription(offer);
    await flushPendingCandidates();
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('answer', { answer, to: from });
  });

  socket.on('answer', async ({ answer }) => {
    if (!peerConnection) return;
    await peerConnection.setRemoteDescription(answer);
    await flushPendingCandidates();
  });

  socket.on('ice-candidate', async ({ candidate }) => {
    if (!candidate) return;
    // 연결 준비 전에 도착한 후보는 보관했다가 나중에 추가
    if (!peerConnection || !peerConnection.remoteDescription) {
      pendingCandidates.push(candidate);
      return;
    }
    try { await peerConnection.addIceCandidate(candidate); } catch (_) {}
  });

  socket.on('user-left', ({ username }) => {
    showSystemMsg(`${username}님이 나갔습니다.`);
    remoteVideo.srcObject = null;
    waitingOverlay.style.display = 'flex';
    remoteLabel.textContent = '상대방';
    statusBadge.textContent = '대기 중';
    statusBadge.className = 'status-badge waiting';
    remoteSocketId = '';
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
  });

  // 채팅
  socket.on('chat-message', ({ username, message, time }) => {
    appendMessage(username, message, time, username === myUsername ? 'mine' : '');
  });

  // 화이트보드 수신 — 상대 획은 구간마다 독립된 path로 그려 내 획과 섞이지 않음
  socket.on('stroke-start', (stroke) => {
    strokes.push(stroke);
    if (stroke.kind === 'path') {
      if (stroke.page === currentPageKey()) drawSegment(stroke, stroke.points[0], stroke.points[0]);
    } else if (stroke.page === currentPageKey()) {
      drawStroke(drawCtx, stroke);
    }
  });
  socket.on('stroke-points', ({ id, points }) => {
    const stroke = strokes.findLast(s => s.id === id);
    if (!stroke) return;
    for (const p of points) {
      const prev = stroke.points[stroke.points.length - 1];
      stroke.points.push(p);
      if (stroke.page === currentPageKey()) drawSegment(stroke, prev, p);
    }
  });
  socket.on('stroke-removed', (id) => {
    strokes = strokes.filter(s => s.id !== id);
    redrawBoard();
  });
  socket.on('board-cleared', (page) => {
    strokes = strokes.filter(s => s.page !== page);
    if (page === currentPageKey()) redrawBoard();
  });

  // PDF 수신
  socket.on('pdf-updated', async ({ name, version }) => {
    showSystemMsg(`상대방이 PDF를 공유했습니다: ${name}`);
    strokes = strokes.filter(s => s.page === 0);
    await loadPdfFromServer(version);
    await renderPdfPage(1);
  });
  socket.on('pdf-page-change', (page) => {
    if (pdfDoc) renderPdfPage(page);
  });

  // 웹 공유
  socket.on('web-navigate', (url) => navigateWebFrame(url, false));

  // 방장이 보낸 마이크 제어 명령 수신
  socket.on('host-control-mic', ({ muted }) => {
    if (!localStream) return;
    localStream.getAudioTracks().forEach(t => t.enabled = !muted);
    micOn = !muted;
    showSystemMsg(muted ? '방장이 마이크를 음소거했습니다.' : '방장이 마이크를 켰습니다.');
  });

  // 방장이 기기 목록 요청
  socket.on('devices-requested', () => emitUserDevices());

  // 방장이 수신: 상대방 기기 목록
  socket.on('remote-devices', (devices) => {
    fillRemoteDeviceSelect(remoteCamSelect,     devices.cameras,  devices.selectedCamId);
    fillRemoteDeviceSelect(remoteMicSelect,     devices.mics,     devices.selectedMicId);
    fillRemoteDeviceSelect(remoteSpeakerSelect, devices.speakers, devices.selectedSpeakerId);
    remoteSettingsHint.style.display = 'none';
  });

  // 방장이 보낸 기기 전환 명령 수신
  socket.on('host-switch-device', async ({ kind, deviceId }) => {
    try {
      if (kind === 'cam') {
        const ns = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
        const newTrack = ns.getVideoTracks()[0];
        const old = localStream?.getVideoTracks()[0];
        if (old) { localStream.removeTrack(old); old.stop(); }
        localStream?.addTrack(newTrack);
        newTrack.enabled = camOn;
        localVideo.srcObject = localStream;
        selectedCamId = deviceId;
        if (peerConnection) {
          const sender = peerConnection.getSenders().find(s => s.track?.kind === 'video');
          if (sender) sender.replaceTrack(newTrack);
        }
      } else if (kind === 'mic') {
        const ns = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
        const newTrack = ns.getAudioTracks()[0];
        const old = localStream?.getAudioTracks()[0];
        if (old) { localStream.removeTrack(old); old.stop(); }
        localStream?.addTrack(newTrack);
        newTrack.enabled = micOn;
        selectedMicId = deviceId;
        setupMicGain();
        if (peerConnection && gainedAudioTrack) {
          const sender = peerConnection.getSenders().find(s => s.track?.kind === 'audio');
          if (sender) sender.replaceTrack(gainedAudioTrack);
        }
      } else if (kind === 'speaker') {
        selectedSpeakerId = deviceId;
        if (typeof remoteVideo.setSinkId === 'function') {
          await remoteVideo.setSinkId(deviceId);
        }
      }
      showSystemMsg('방장이 기기를 변경했습니다.');
      emitUserDevices();
    } catch (e) {
      console.error('기기 전환 실패:', e);
    }
  });
}

/* ════════════════════════════════════════════
   WebRTC
════════════════════════════════════════════ */
// TURN 자격증명은 서버에서 한 번 받아 재사용
function getIceConfig() {
  if (!iceConfigPromise) {
    iceConfigPromise = new Promise(resolve => {
      socket.timeout(5000).emit('get-ice-servers', (err, servers) => {
        resolve({ iceServers: err || !Array.isArray(servers) ? FALLBACK_ICE_SERVERS : servers });
      });
    });
  }
  return iceConfigPromise;
}

// 내가 offer를 보내는 쪽으로 통화 연결 (상대 입장 시 / ICE 실패 후 재연결 시)
async function startCall() {
  if (!remoteSocketId) return;
  isOfferer = true;
  await createPeerConnection();
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit('offer', { offer, to: remoteSocketId });
}

async function flushPendingCandidates() {
  const list = pendingCandidates;
  pendingCandidates = [];
  for (const c of list) {
    try { await peerConnection.addIceCandidate(c); } catch (_) {}
  }
}

async function createPeerConnection() {
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  pendingCandidates = [];
  const config = await getIceConfig();
  if (peerConnection) peerConnection.close(); // 기다리는 사이 다른 연결이 만들어진 경우
  const pc = new RTCPeerConnection(config);
  peerConnection = pc;

  if (localStream) {
    localStream.getVideoTracks().forEach(t => peerConnection.addTrack(t, localStream));
    if (gainedAudioTrack) peerConnection.addTrack(gainedAudioTrack, localStream);
    else localStream.getAudioTracks().forEach(t => peerConnection.addTrack(t, localStream));
  } else {
    // 카메라 없어도 상대방 영상/음성 수신 가능하게 트랜시버 추가
    peerConnection.addTransceiver('video', { direction: 'recvonly' });
    peerConnection.addTransceiver('audio', { direction: 'recvonly' });
  }

  peerConnection.ontrack = (e) => {
    if (e.streams && e.streams[0]) {
      remoteVideo.srcObject = e.streams[0];
    } else {
      // 스트림 없이 트랙만 오는 경우
      if (!remoteVideo.srcObject) remoteVideo.srcObject = new MediaStream();
      remoteVideo.srcObject.addTrack(e.track);
    }
    waitingOverlay.style.display = 'none';
    statusBadge.textContent = '연결됨';
    statusBadge.className = 'status-badge connected';
  };

  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate && remoteSocketId) {
      socket.emit('ice-candidate', { candidate, to: remoteSocketId });
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed' && isOfferer && peerConnection === pc) {
      // ICE 실패 시 offer 쪽에서 새로 협상 (상대는 offer를 받으면 연결을 새로 만듦)
      setTimeout(() => { if (peerConnection === pc) startCall(); }, 1000);
    }
  };

  peerConnection.onconnectionstatechange = () => {
    if (peerConnection !== pc) return;
    const s = pc.connectionState;
    if (s === 'connected') {
      waitingOverlay.style.display = 'none';
      statusBadge.textContent = '연결됨';
      statusBadge.className = 'status-badge connected';
    } else if (s === 'failed' || s === 'closed') {
      waitingOverlay.style.display = 'flex';
      statusBadge.textContent = '대기 중';
      statusBadge.className = 'status-badge waiting';
    }
  };
}

/* ════════════════════════════════════════════
   마이크 게인 설정
════════════════════════════════════════════ */
function setupMicGain() {
  if (!localStream) return;
  if (micAudioCtx) micAudioCtx.close();
  micAudioCtx = new AudioContext();
  const src = micAudioCtx.createMediaStreamSource(localStream);
  micGainNode = micAudioCtx.createGain();
  micGainNode.gain.value = micVolumeVal / 100;
  const dest = micAudioCtx.createMediaStreamDestination();
  src.connect(micGainNode);
  micGainNode.connect(dest);
  gainedAudioTrack = dest.stream.getAudioTracks()[0];
}

/* ════════════════════════════════════════════
   설정 모달
════════════════════════════════════════════ */
settingsBtn.addEventListener('click', async () => {
  await populateDeviceSelects();
  syncSettingsUI();
  settingsModal.classList.remove('hidden');
});

settingsClose.addEventListener('click', () => settingsModal.classList.add('hidden'));
settingsModal.addEventListener('click', e => {
  if (e.target === settingsModal) settingsModal.classList.add('hidden');
});

function syncSettingsUI() {
  settingsMicToggle.textContent = micOn ? '켜짐' : '꺼짐';
  settingsMicToggle.className = 'settings-toggle ' + (micOn ? 'on' : 'off');
  settingsCamToggle.textContent = camOn ? '켜짐' : '꺼짐';
  settingsCamToggle.className = 'settings-toggle ' + (camOn ? 'on' : 'off');
}

async function populateDeviceSelects() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const fill = (el, list, selectedId) => {
    el.innerHTML = list.map((d, i) =>
      `<option value="${d.deviceId}" ${d.deviceId === selectedId ? 'selected' : ''}>${d.label || `장치 ${i + 1}`}</option>`
    ).join('');
  };
  fill(camSelect,     devices.filter(d => d.kind === 'videoinput'),  selectedCamId);
  fill(micSelect,     devices.filter(d => d.kind === 'audioinput'),  selectedMicId);
  fill(speakerSelect, devices.filter(d => d.kind === 'audiooutput'), selectedSpeakerId);
}

// 카메라 토글
settingsCamToggle.addEventListener('click', () => {
  if (!localStream) return;
  camOn = !camOn;
  localStream.getVideoTracks().forEach(t => t.enabled = camOn);
  syncSettingsUI();
});

// 마이크 토글
settingsMicToggle.addEventListener('click', () => {
  if (!localStream) return;
  micOn = !micOn;
  localStream.getAudioTracks().forEach(t => t.enabled = micOn);
  syncSettingsUI();
});

// 마이크 음량
micVolumeSlider.addEventListener('input', () => {
  micVolumeVal = parseInt(micVolumeSlider.value);
  micVolumeDisplay.textContent = micVolumeVal + '%';
  if (micGainNode) micGainNode.gain.value = micVolumeVal / 100;
});

// 스피커 음량
speakerVolumeSlider.addEventListener('input', () => {
  speakerVolumeVal = parseInt(speakerVolumeSlider.value);
  speakerVolumeDisplay.textContent = speakerVolumeVal + '%';
  remoteVideo.volume = speakerVolumeVal / 100;
});

// 카메라 장치 변경
camSelect.addEventListener('change', async () => {
  if (!localStream) return;
  selectedCamId = camSelect.value;
  try {
    const ns = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: selectedCamId } } });
    const newTrack = ns.getVideoTracks()[0];
    const old = localStream.getVideoTracks()[0];
    if (old) { localStream.removeTrack(old); old.stop(); }
    localStream.addTrack(newTrack);
    newTrack.enabled = camOn;
    localVideo.srcObject = localStream;
    if (peerConnection) {
      const sender = peerConnection.getSenders().find(s => s.track?.kind === 'video');
      if (sender) sender.replaceTrack(newTrack);
    }
  } catch (e) { console.error('카메라 변경 실패:', e); }
});

// 마이크 장치 변경
micSelect.addEventListener('change', async () => {
  if (!localStream) return;
  selectedMicId = micSelect.value;
  try {
    const ns = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: selectedMicId } } });
    const newTrack = ns.getAudioTracks()[0];
    const old = localStream.getAudioTracks()[0];
    if (old) { localStream.removeTrack(old); old.stop(); }
    localStream.addTrack(newTrack);
    newTrack.enabled = micOn;
    setupMicGain();
    if (peerConnection && gainedAudioTrack) {
      const sender = peerConnection.getSenders().find(s => s.track?.kind === 'audio');
      if (sender) sender.replaceTrack(gainedAudioTrack);
    }
  } catch (e) { console.error('마이크 변경 실패:', e); }
});

// 스피커 장치 변경
speakerSelect.addEventListener('change', () => {
  selectedSpeakerId = speakerSelect.value;
  if (typeof remoteVideo.setSinkId === 'function') {
    remoteVideo.setSinkId(selectedSpeakerId).catch(e => console.error('스피커 변경 실패:', e));
  }
});

/* ════════════════════════════════════════════
   채팅
════════════════════════════════════════════ */
sendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

function sendChat() {
  const msg = chatInput.value.trim();
  if (!msg || !socket) return;
  socket.emit('chat-message', msg);
  chatInput.value = '';
}

function appendMessage(username, message, time, extraClass = '') {
  const div = document.createElement('div');
  div.className = `chat-msg${extraClass ? ' ' + extraClass : ''}`;
  div.innerHTML = `
    <div class="msg-meta">
      <span class="msg-name ${extraClass}">${escHtml(username)}</span>
      <span class="msg-time">${time}</span>
    </div>
    <div class="msg-body">${escHtml(message)}</div>
  `;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'chat-msg system-msg';
  div.innerHTML = `<div class="msg-body">${escHtml(text)}</div>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ════════════════════════════════════════════
   모바일 채팅 토글
════════════════════════════════════════════ */
chatToggleBtn.addEventListener('click', () => chatSection.classList.toggle('mobile-open'));
chatCloseBtn.addEventListener('click',  () => chatSection.classList.remove('mobile-open'));

/* ════════════════════════════════════════════
   방장 – 상대방 마이크/스피커 제어
════════════════════════════════════════════ */
remoteMicBtn.addEventListener('click', () => {
  if (!isHost || !socket) return;
  remoteMicMuted = !remoteMicMuted;
  socket.emit('host-control-mic', { muted: remoteMicMuted });
  remoteMicBtn.textContent = remoteMicMuted ? '🔇' : '🎤';
  remoteMicBtn.classList.toggle('muted', remoteMicMuted);
});

remoteVolSlider.addEventListener('input', () => {
  const val = parseInt(remoteVolSlider.value);
  remoteVideo.volume = val / 100;
  remoteVolDisplay.textContent = val + '%';
});

// 상대방 기기 설정 모달
remoteSettingsBtn.addEventListener('click', () => {
  if (!isHost) return;
  remoteSettingsHint.style.display = '';
  remoteCamSelect.innerHTML = '';
  remoteMicSelect.innerHTML = '';
  remoteSpeakerSelect.innerHTML = '';
  socket && socket.emit('request-user-devices');
  remoteSettingsModal.classList.remove('hidden');
});
remoteSettingsClose.addEventListener('click', () => remoteSettingsModal.classList.add('hidden'));
remoteSettingsModal.addEventListener('click', e => {
  if (e.target === remoteSettingsModal) remoteSettingsModal.classList.add('hidden');
});

remoteCamSelect.addEventListener('change', () => {
  socket && socket.emit('host-switch-device', { kind: 'cam', deviceId: remoteCamSelect.value });
});
remoteMicSelect.addEventListener('change', () => {
  socket && socket.emit('host-switch-device', { kind: 'mic', deviceId: remoteMicSelect.value });
});
remoteSpeakerSelect.addEventListener('change', () => {
  socket && socket.emit('host-switch-device', { kind: 'speaker', deviceId: remoteSpeakerSelect.value });
});

function fillRemoteDeviceSelect(el, list, selectedId) {
  el.innerHTML = list.map((d, i) =>
    `<option value="${d.deviceId}" ${d.deviceId === selectedId ? 'selected' : ''}>${d.label || `장치 ${i + 1}`}</option>`
  ).join('');
}

async function emitUserDevices() {
  if (!socket) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    socket.emit('user-devices', {
      cameras:  devices.filter(d => d.kind === 'videoinput') .map(d => ({ deviceId: d.deviceId, label: d.label || '' })),
      mics:     devices.filter(d => d.kind === 'audioinput') .map(d => ({ deviceId: d.deviceId, label: d.label || '' })),
      speakers: devices.filter(d => d.kind === 'audiooutput').map(d => ({ deviceId: d.deviceId, label: d.label || '' })),
      selectedCamId, selectedMicId, selectedSpeakerId
    });
  } catch (_) {}
}

/* ════════════════════════════════════════════
   링크 복사
════════════════════════════════════════════ */
copyLinkBtn.addEventListener('click', async () => {
  const url = new URL(window.location.href);
  url.searchParams.set('room', myRoomId);
  const link = url.toString();
  try {
    await navigator.clipboard.writeText(link);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = link;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  copyLinkBtn.textContent = '✓ 복사됨!';
  copyLinkBtn.classList.add('copied');
  setTimeout(() => {
    copyLinkBtn.textContent = '🔗 링크 복사';
    copyLinkBtn.classList.remove('copied');
  }, 2000);
});

/* ════════════════════════════════════════════
   나가기
════════════════════════════════════════════ */
leaveBtn.addEventListener('click', leaveRoom);

function leaveRoom() {
  if (mediaRecorder && mediaRecorder.state === 'recording') stopRecording();
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  pendingCandidates = [];
  iceConfigPromise = null;
  hasJoined = false;
  remoteSocketId = '';
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (micAudioCtx) { micAudioCtx.close(); micAudioCtx = null; }
  gainedAudioTrack = null;
  micOn = true; camOn = true;
  isHost = false;
  remoteMicMuted = false;
  remoteMicBtn.textContent = '🎤';
  remoteMicBtn.classList.remove('muted');
  remoteVolSlider.value = 100;
  remoteVolDisplay.textContent = '100%';
  remoteControls.classList.add('hidden');
  if (socket) { socket.disconnect(); socket = null; }
  pdfDoc = null;
  pdfVersion = null;
  strokes = [];
  myStroke = null;
  window.history.replaceState({}, '', window.location.pathname);
  roomEl.classList.add('hidden');
  lobby.classList.remove('hidden');
  clearDrawCanvas();
  clearPdfCanvas();
  pdfNav.classList.add('hidden');
  pagesPanel.classList.add('hidden');
  pagesList.innerHTML = '';
  chatMessages.innerHTML = '';
  // 카메라 없음 안내가 남아 있으면 제거
  localVideo.parentElement.querySelectorAll('.nocam-overlay').forEach(el => el.remove());
}

/* ════════════════════════════════════════════
   화이트보드 – 캔버스 초기화
════════════════════════════════════════════ */
function initCanvasSize(w = 1600, h = 900) {
  [pdfCanvas, drawCanvas, previewCanvas].forEach(c => { c.width = w; c.height = h; });
  canvasZoom = 1;
  canvasInner.style.width  = w + 'px';
  canvasInner.style.height = h + 'px';
  drawCtx.lineCap  = 'round';
  drawCtx.lineJoin = 'round';
  applyZoom();
  setPencilCursor();
  redrawBoard();
}

function applyZoom() {
  // 캔버스에 이미 반영된 줌(canvasZoom)을 뺀 나머지만 CSS로 확대
  const cssScale = zoomLevel / canvasZoom;
  canvasInner.style.transform = `scale(${cssScale})`;
  canvasWrapper.style.width  = Math.ceil(drawCanvas.width  * cssScale) + 'px';
  canvasWrapper.style.height = Math.ceil(drawCanvas.height * cssScale) + 'px';
  if (pdfDoc) {
    // PDF가 있으면 줌 멈춘 뒤 300ms 후 고해상도로 재렌더링 (필기도 획 데이터로 다시 그림)
    clearTimeout(zoomRenderTimer);
    zoomRenderTimer = setTimeout(() => renderPdfPage(pdfCurrentPage), 300);
  }
}

function showZoomIndicator() {
  zoomIndicator.textContent = Math.round(zoomLevel * 100) + '%';
  zoomIndicator.classList.remove('hidden');
  clearTimeout(zoomHideTimer);
  zoomHideTimer = setTimeout(() => zoomIndicator.classList.add('hidden'), 1200);
}

/* ────────── 획 데이터 ↔ 캔버스 ────────── */
// 빈 보드는 0, PDF는 페이지 번호
function currentPageKey() {
  return pdfDoc ? pdfCurrentPage : 0;
}

const toNorm = (x, y) => [x / drawCanvas.width, y / drawCanvas.height];
const toPx = ([x, y]) => [x * drawCanvas.width, y * drawCanvas.height];
// 슬라이더 굵기(줌 100% 기준 px) → 캔버스 너비 대비 비율
const normSize = () => strokeSize * canvasZoom / drawCanvas.width;

function drawStroke(ctx, s) {
  const pts = s.points.map(toPx);
  const size = s.size * drawCanvas.width;
  if (s.kind === 'shape') {
    renderShape(ctx, s.shape, pts[0][0], pts[0][1], pts[1][0], pts[1][1], s.color, size, s.filled);
    return;
  }
  if (s.kind === 'line') {
    renderLine(ctx, pts[0][0], pts[0][1], pts[1][0], pts[1][1], s.color, size);
    return;
  }
  setupCtx(ctx, s.tool, s.color, size);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 1) ctx.lineTo(pts[0][0], pts[0][1]); // 점 하나
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

// 그리는 중인 자유선의 한 구간만 그림 (독립된 path라 동시에 그려도 섞이지 않음)
function drawSegment(s, from, to) {
  const [x1, y1] = toPx(from), [x2, y2] = toPx(to);
  setupCtx(drawCtx, s.tool, s.color, s.size * drawCanvas.width);
  drawCtx.beginPath();
  drawCtx.moveTo(x1, y1);
  drawCtx.lineTo(x2, y2);
  drawCtx.stroke();
}

function redrawBoard() {
  clearDrawCanvas();
  const page = currentPageKey();
  strokes.forEach(s => { if (s.page === page) drawStroke(drawCtx, s); });
}

// 직선/도형 획을 확정해서 저장·전송
function commitStroke(stroke) {
  strokes.push(stroke);
  drawStroke(drawCtx, stroke);
  socket && socket.emit('stroke-start', stroke);
}

/* ────────── 그리기 이벤트 ────────── */
// preview 캔버스 사용 여부 (도형 / 직선 / 수직선)
function usesPreview() {
  return currentTool === 'shape' ||
    (currentTool === 'pen' && currentPenMode !== 'free');
}

function snapEnd(x, y) {
  if (currentPenMode !== 'snap') return [x, y];
  const dx = Math.abs(x - shapeStartX), dy = Math.abs(y - shapeStartY);
  return dx >= dy ? [x, shapeStartY] : [shapeStartX, y];
}

drawCanvas.addEventListener('mousedown', e => {
  isDrawing = true;
  const { x, y } = getPos(e);
  lastX = x; lastY = y;
  if (usesPreview()) { shapeStartX = x; shapeStartY = y; return; }
  const p = toNorm(x, y);
  myStroke = {
    id: uid(), owner: clientId, page: currentPageKey(), kind: 'path',
    tool: currentTool, color: strokeColor, size: normSize(), points: [p]
  };
  strokes.push(myStroke);
  drawSegment(myStroke, p, p);
  socket && socket.emit('stroke-start', myStroke);
});

drawCanvas.addEventListener('mousemove', e => {
  if (!isDrawing) return;
  const { x, y } = getPos(e);
  if (usesPreview()) {
    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    if (currentTool === 'shape') {
      renderShape(previewCtx, currentShape, shapeStartX, shapeStartY, x, y, strokeColor, strokeSize * canvasZoom, shapeFilled);
    } else {
      const [ex, ey] = snapEnd(x, y);
      renderLine(previewCtx, shapeStartX, shapeStartY, ex, ey, strokeColor, strokeSize * canvasZoom);
    }
    return;
  }
  if (!myStroke) return;
  const p = toNorm(x, y);
  const prev = myStroke.points[myStroke.points.length - 1];
  myStroke.points.push(p);
  drawSegment(myStroke, prev, p);
  lastX = x; lastY = y;
  socket && socket.emit('stroke-points', { id: myStroke.id, points: [p] });
});

['mouseup', 'mouseleave'].forEach(evt =>
  drawCanvas.addEventListener(evt, e => {
    if (!isDrawing) return;
    isDrawing = false;
    if (usesPreview()) {
      previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      if (evt === 'mouseup') {
        const { x, y } = getPos(e);
        const base = { id: uid(), owner: clientId, page: currentPageKey(), color: strokeColor, size: normSize() };
        if (currentTool === 'shape') {
          commitStroke({ ...base, kind: 'shape', shape: currentShape, filled: shapeFilled,
            points: [toNorm(shapeStartX, shapeStartY), toNorm(x, y)] });
        } else {
          const [ex, ey] = snapEnd(x, y);
          commitStroke({ ...base, kind: 'line', points: [toNorm(shapeStartX, shapeStartY), toNorm(ex, ey)] });
        }
      }
      return;
    }
    myStroke = null;
  })
);

// 터치 지원 (멀티터치 시 드로잉 중단)
drawCanvas.addEventListener('touchstart', e => {
  if (e.touches.length > 1) return;
  e.preventDefault();
  drawCanvas.dispatchEvent(new MouseEvent('mousedown', { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY }));
}, { passive: false });
drawCanvas.addEventListener('touchmove', e => {
  if (e.touches.length > 1) { isDrawing = false; return; }
  e.preventDefault();
  drawCanvas.dispatchEvent(new MouseEvent('mousemove', { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY }));
}, { passive: false });
drawCanvas.addEventListener('touchend', e => {
  e.preventDefault();
  // 손을 뗀 위치를 넘겨야 직선/도형 끝점이 맞음
  const t = e.changedTouches[0];
  drawCanvas.dispatchEvent(new MouseEvent('mouseup', t ? { clientX: t.clientX, clientY: t.clientY } : {}));
}, { passive: false });

// 핀치 줌
let pinchStartDist = 0, pinchStartZoom = 1;
canvasContainer.addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    pinchStartDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    pinchStartZoom = zoomLevel;
  }
}, { passive: true });
canvasContainer.addEventListener('touchmove', e => {
  if (e.touches.length !== 2) return;
  e.preventDefault();
  const dist = Math.hypot(
    e.touches[0].clientX - e.touches[1].clientX,
    e.touches[0].clientY - e.touches[1].clientY
  );
  const prevZoom = zoomLevel;
  zoomLevel = Math.min(4.0, Math.max(0.25, Math.round(pinchStartZoom * (dist / pinchStartDist) * 100) / 100));
  if (zoomLevel !== prevZoom) {
    applyZoom();
    showZoomIndicator();
    if (currentTool === 'eraser') setEraserCursor(strokeSize);
  }
}, { passive: false });

function getPos(e) {
  const rect = drawCanvas.getBoundingClientRect();
  const scaleX = drawCanvas.width / rect.width;
  const scaleY = drawCanvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY
  };
}

function setupCtx(ctx, tool, color, size) {
  ctx.lineWidth = size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = color;
  }
}

/* ────────── 펜 모드 팝업 ────────── */
const penPopup  = document.getElementById('pen-popup');
const penOpts   = document.querySelectorAll('.pen-opt');

const PEN_ICONS = { free: '✏️', line: '╱', snap: '┼' };

toolPen.addEventListener('click', (e) => {
  e.stopPropagation();
  currentTool = 'pen';
  toolPen.classList.add('active');
  toolEraser.classList.remove('active');
  toolShapeBtn.classList.remove('active');
  shapePopup.classList.add('hidden');
  setPencilCursor();
  penPopup.classList.toggle('hidden');
});

penOpts.forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    currentPenMode = btn.dataset.mode;
    currentTool    = 'pen';
    penPopup.classList.add('hidden');
    toolPen.classList.add('active');
    toolEraser.classList.remove('active');
    toolShapeBtn.classList.remove('active');
    toolShapeBtn.textContent = '🔷';
    toolPen.textContent = PEN_ICONS[currentPenMode];
    penOpts.forEach(o => o.classList.toggle('active', o.dataset.mode === currentPenMode));
    setPencilCursor();
  });
});

function renderLine(ctx, x1, y1, x2, y2, color, size) {
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = color;
  ctx.lineWidth   = size;
  ctx.lineCap     = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/* ────────── 도형 ────────── */
const toolShapeBtn = document.getElementById('tool-shape');
const shapePopup   = document.getElementById('shape-popup');
const shapeOpts    = document.querySelectorAll('.shape-opt');

const SHAPE_ICONS = {
  rect:     { outline: '▭', filled: '■' },
  triangle: { outline: '△', filled: '▲' },
  circle:   { outline: '○', filled: '●' },
};

toolShapeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  penPopup.classList.add('hidden');
  shapePopup.classList.toggle('hidden');
});

shapeOpts.forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    currentShape = btn.dataset.shape;
    shapeFilled  = btn.dataset.filled === 'true';
    currentTool  = 'shape';
    shapePopup.classList.add('hidden');
    toolPen.classList.remove('active');
    toolEraser.classList.remove('active');
    toolShapeBtn.classList.add('active');
    toolShapeBtn.textContent = SHAPE_ICONS[currentShape][shapeFilled ? 'filled' : 'outline'];
    shapeOpts.forEach(o => o.classList.toggle('active',
      o.dataset.shape === currentShape && (o.dataset.filled === 'true') === shapeFilled
    ));
    drawCanvas.style.cursor = 'crosshair';
  });
});

// 팝업 외부 클릭 시 닫기
document.addEventListener('click', () => {
  shapePopup.classList.add('hidden');
  penPopup.classList.add('hidden');
});

function renderShape(ctx, type, x1, y1, x2, y2, color, size, filled = false) {
  ctx.globalCompositeOperation = 'source-over';
  ctx.lineWidth  = size;
  ctx.lineCap    = 'round';
  ctx.lineJoin   = 'round';
  const padX = Math.abs(x2 - x1) * 0.08;
  const padY = Math.abs(y2 - y1) * 0.08;
  const signX = x2 >= x1 ? 1 : -1;
  const signY = y2 >= y1 ? 1 : -1;
  ctx.beginPath();
  if (type === 'rect') {
    ctx.rect(
      x1 + padX * signX, y1 + padY * signY,
      (x2 - x1) - 2 * padX * signX, (y2 - y1) - 2 * padY * signY
    );
  } else if (type === 'circle') {
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    const rx = Math.max(1, Math.abs(x2 - x1) / 2 - padX);
    const ry = Math.max(1, Math.abs(y2 - y1) / 2 - padY);
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  } else if (type === 'triangle') {
    const pad = padX;
    const cx = (x1 + x2) / 2;
    ctx.moveTo(cx, y1);
    ctx.lineTo(x2 - pad * signX, y2);
    ctx.lineTo(x1 + pad * signX, y2);
    ctx.closePath();
  }
  if (filled) {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.stroke();
  }
}

/* ────────── 커서 ────────── */
function setPencilCursor() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" fill="#222"/></svg>`;
  drawCanvas.style.cursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 2 22, crosshair`;
}

function setEraserCursor(size) {
  const rect = drawCanvas.getBoundingClientRect();
  const scale = rect.width > 0 ? rect.width / drawCanvas.width : 1;
  const px = Math.max(8, Math.min(Math.round(size * canvasZoom * scale), 96));
  const total = px + 6;

  const c = document.createElement('canvas');
  c.width = total; c.height = total;
  const ctx = c.getContext('2d');

  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(3, 3, px, px);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1;
  ctx.strokeRect(3.5, 3.5, px - 1, px - 1);

  const mid = total / 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(mid - 3, mid); ctx.lineTo(mid + 3, mid);
  ctx.moveTo(mid, mid - 3); ctx.lineTo(mid, mid + 3);
  ctx.stroke();

  const hot = Math.floor(total / 2);
  drawCanvas.style.cursor = `url(${c.toDataURL()}) ${hot} ${hot}, crosshair`;
}

/* ────────── 툴 선택 ────────── */
toolEraser.addEventListener('click', () => {
  currentTool = 'eraser';
  toolEraser.classList.add('active');
  toolPen.classList.remove('active');
  toolShapeBtn.classList.remove('active');
  penPopup.classList.add('hidden');
  shapePopup.classList.add('hidden');
  setEraserCursor(strokeSize);
});

colorSwatches.forEach(btn => {
  btn.addEventListener('click', () => {
    strokeColor = btn.dataset.color;
    colorSwatches.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

sizeSlider.addEventListener('input', e => {
  strokeSize = parseInt(e.target.value, 10);
  sizeDisplay.textContent = strokeSize;
  if (currentTool === 'eraser') setEraserCursor(strokeSize);
});

function updateHostUI() {
  localLabel.textContent = isHost ? `👑 ${myUsername}` : myUsername;
  clearAllBtn.style.opacity = isHost ? '1' : '0.3';
  clearAllBtn.style.cursor  = isHost ? 'pointer' : 'not-allowed';
  clearAllBtn.title = isHost ? '전체 지우기' : '방장만 지울 수 있습니다';
  if (isHost) remoteControls.classList.remove('hidden');
  else        remoteControls.classList.add('hidden');
}

clearAllBtn.addEventListener('click', () => {
  if (!isHost) return;
  const page = currentPageKey();
  strokes = strokes.filter(s => s.page !== page);
  redrawBoard();
  socket && socket.emit('board-clear', page);
});

function clearDrawCanvas() {
  drawCtx.globalCompositeOperation = 'source-over';
  drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
}

// 현재 페이지에서 내가 마지막으로 그린 획만 취소 (상대 획은 유지)
function undo() {
  const page = currentPageKey();
  const mine = strokes.findLast(s => s.owner === clientId && s.page === page);
  if (!mine) return;
  strokes = strokes.filter(s => s !== mine);
  if (myStroke === mine) { myStroke = null; isDrawing = false; }
  redrawBoard();
  socket && socket.emit('stroke-undo', mine.id);
}

function clearPdfCanvas() {
  pdfCtx.clearRect(0, 0, pdfCanvas.width, pdfCanvas.height);
}

/* ════════════════════════════════════════════
   서버에서 받은 방 상태 적용 (입장/재접속 시)
════════════════════════════════════════════ */
async function applyRoomState({ pdf, pdfPage, strokes: serverStrokes, webUrl }) {
  strokes = serverStrokes;
  myStroke = null;
  isDrawing = false;
  if (webUrl) navigateWebFrame(webUrl, false);

  if (pdf) {
    if (pdf.version !== pdfVersion) await loadPdfFromServer(pdf.version);
    await renderPdfPage(pdfPage);
  } else if (pdfDoc) {
    // 서버에 PDF가 없으면 (방이 만료된 경우) 빈 보드로
    pdfDoc = null;
    pdfVersion = null;
    pdfNav.classList.add('hidden');
    pagesPanel.classList.add('hidden');
    pagesList.innerHTML = '';
    clearPdfCanvas();
    initCanvasSize();
  } else {
    redrawBoard();
  }
}

/* ════════════════════════════════════════════
   PDF
════════════════════════════════════════════ */
pdfBtn.addEventListener('click', () => pdfInput.click());

pdfInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  pdfInput.value = '';
  if (!file || !socket) return;
  showSystemMsg(`PDF 업로드 중: ${file.name}`);
  try {
    // 서버에 올리면 서버가 상대방에게 알림 (늦게 들어온 사람도 서버에서 받음)
    const res = await fetch(`/rooms/${encodeURIComponent(myRoomId)}/pdf`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        'X-Socket-Id': socket.id,
        'X-File-Name': encodeURIComponent(file.name)
      },
      body: file
    });
    if (res.status === 413) { showSystemMsg('PDF가 너무 큽니다 (최대 50MB).'); return; }
    if (!res.ok) throw new Error(`status ${res.status}`);
    const { version } = await res.json();
    strokes = strokes.filter(s => s.page === 0);
    await loadPdfData(new Uint8Array(await file.arrayBuffer()), version);
    await renderPdfPage(1);
    showSystemMsg(`PDF 공유됨: ${file.name}`);
  } catch (err) {
    console.error('PDF 업로드 실패:', err);
    showSystemMsg('PDF 업로드에 실패했습니다.');
  }
});

async function loadPdfFromServer(version) {
  const res = await fetch(`/rooms/${encodeURIComponent(myRoomId)}/pdf?v=${version}`);
  if (!res.ok) { showSystemMsg('PDF를 불러오지 못했습니다.'); return; }
  await loadPdfData(new Uint8Array(await res.arrayBuffer()), version);
}

async function loadPdfData(bytes, version) {
  pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
  pdfVersion = version;
  pdfTotalPages = pdfDoc.numPages;
  pdfCurrentPage = 1;
  pdfNav.classList.remove('hidden');
  buildPagesList(pdfTotalPages);
}

function buildPagesList(total) {
  pagesList.innerHTML = '';
  for (let i = 1; i <= total; i++) {
    const btn = document.createElement('button');
    btn.className = 'page-num-btn' + (i === 1 ? ' active' : '');
    btn.textContent = i;
    btn.dataset.page = i;
    btn.addEventListener('click', () => {
      const page = parseInt(btn.dataset.page, 10);
      renderPdfPage(page);
      socket && socket.emit('pdf-page-change', page);
    });
    pagesList.appendChild(btn);
  }
  pagesPanel.classList.remove('hidden');
}

function updatePagesListActive(pageNum) {
  pagesList.querySelectorAll('.page-num-btn').forEach(btn => {
    const isActive = parseInt(btn.dataset.page, 10) === pageNum;
    btn.classList.toggle('active', isActive);
    if (isActive) btn.scrollIntoView({ block: 'nearest' });
  });
}

async function renderPdfPage(pageNum) {
  if (!pdfDoc) return;
  clearTimeout(zoomRenderTimer);
  const seq = ++pdfRenderSeq;
  pdfCurrentPage = Math.max(1, Math.min(pageNum, pdfTotalPages));
  pdfPageInfo.textContent = `${pdfCurrentPage} / ${pdfTotalPages}`;
  updatePagesListActive(pdfCurrentPage);

  const page = await pdfDoc.getPage(pdfCurrentPage);
  if (seq !== pdfRenderSeq) return; // 그 사이 다른 페이지/줌 렌더링이 시작됨
  const containerW = canvasContainer.clientWidth || 1200;
  const containerH = canvasContainer.clientHeight || 800;
  const viewport0 = page.getViewport({ scale: 1 });
  pdfBaseScale = Math.min(containerW / viewport0.width, containerH / viewport0.height, 2);
  // 현재 줌 배율을 반영해 렌더링 → 확대해도 선명함
  const viewport = page.getViewport({ scale: pdfBaseScale * zoomLevel });

  const W = Math.floor(viewport.width);
  const H = Math.floor(viewport.height);

  if (pdfRenderTask) pdfRenderTask.cancel();
  [pdfCanvas, drawCanvas, previewCanvas].forEach(c => { c.width = W; c.height = H; });
  canvasZoom = zoomLevel;
  canvasInner.style.width  = W + 'px';
  canvasInner.style.height = H + 'px';
  canvasInner.style.transform = 'scale(1)'; // CSS 스케일 불필요 — 캔버스 자체가 줌 반영
  canvasWrapper.style.width  = W + 'px';
  canvasWrapper.style.height = H + 'px';
  if (currentTool === 'eraser') setEraserCursor(strokeSize);

  // 필기는 획 데이터로 다시 그림 → 페이지를 오가거나 확대해도 유지되고 선명함
  redrawBoard();

  pdfRenderTask = page.render({ canvasContext: pdfCtx, viewport });
  try { await pdfRenderTask.promise; } catch (_) { /* 취소됨 */ }
}

pdfPrev.addEventListener('click', () => {
  if (!pdfDoc || pdfCurrentPage <= 1) return;
  renderPdfPage(pdfCurrentPage - 1);
  socket && socket.emit('pdf-page-change', pdfCurrentPage);
});

pdfNext.addEventListener('click', () => {
  if (!pdfDoc || pdfCurrentPage >= pdfTotalPages) return;
  renderPdfPage(pdfCurrentPage + 1);
  socket && socket.emit('pdf-page-change', pdfCurrentPage);
});

/* ════════════════════════════════════════════
   녹화
════════════════════════════════════════════ */
recordBtn.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopRecording();
  } else {
    startRecording();
  }
});

function startRecording() {
  // 합성 캔버스: 현재 방 화면을 하나로 합침
  const W = 1280, H = 720;
  const comp = document.createElement('canvas');
  comp.width = W; comp.height = H;
  const ctx = comp.getContext('2d');

  const VIDEO_W = 220, REMOTE_H = 165, LOCAL_H = 125;
  const BOARD_X = VIDEO_W + 4;
  const BOARD_W = W - BOARD_X;

  function drawFrame() {
    // 배경
    ctx.fillStyle = '#0f1117';
    ctx.fillRect(0, 0, W, H);

    // 화이트보드 (PDF + 드로잉)
    ctx.fillStyle = '#1a1f2e';
    ctx.fillRect(BOARD_X, 0, BOARD_W, H);

    if (pdfCanvas.width > 0 && pdfCanvas.height > 0) {
      const scale = Math.min(BOARD_W / pdfCanvas.width, H / pdfCanvas.height);
      const dw = pdfCanvas.width * scale, dh = pdfCanvas.height * scale;
      const dx = BOARD_X + (BOARD_W - dw) / 2, dy = (H - dh) / 2;
      ctx.drawImage(pdfCanvas, dx, dy, dw, dh);
      ctx.drawImage(drawCanvas, dx, dy, dw, dh);
    } else {
      ctx.drawImage(drawCanvas, BOARD_X, 0, BOARD_W, H);
    }

    // 상대방 영상
    ctx.fillStyle = '#0a0c14';
    ctx.fillRect(0, 0, VIDEO_W, REMOTE_H);
    if (remoteVideo.srcObject && !remoteVideo.paused) {
      ctx.drawImage(remoteVideo, 0, 0, VIDEO_W, REMOTE_H);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, REMOTE_H - 18, VIDEO_W, 18);
    ctx.fillStyle = '#fff';
    ctx.font = '11px sans-serif';
    ctx.fillText(remoteLabel.textContent, 6, REMOTE_H - 5);

    // 내 영상
    ctx.fillStyle = '#0a0c14';
    ctx.fillRect(0, REMOTE_H + 4, VIDEO_W, LOCAL_H);
    if (localStream) {
      ctx.drawImage(localVideo, 0, REMOTE_H + 4, VIDEO_W, LOCAL_H);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, REMOTE_H + 4 + LOCAL_H - 18, VIDEO_W, 18);
    ctx.fillStyle = '#fff';
    ctx.fillText(localLabel.textContent || '나', 6, REMOTE_H + 4 + LOCAL_H - 5);

    // REC 표시
    const now = Date.now();
    if (Math.floor((now - recStartTime) / 500) % 2 === 0) {
      ctx.fillStyle = '#e74c3c';
      ctx.beginPath();
      ctx.arc(W - 20, 16, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText('REC', W - 50, 21);
    }

  }
  drawFrame();
  // requestAnimationFrame은 탭이 백그라운드면 멈추므로 타이머 사용 (백그라운드에선 브라우저가 느리게 실행)
  recordTimer = setInterval(drawFrame, 1000 / 30);

  // 오디오 믹싱
  audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();
  if (localStream) {
    audioCtx.createMediaStreamSource(localStream).connect(dest);
  }
  if (remoteVideo.srcObject) {
    try { audioCtx.createMediaStreamSource(remoteVideo.srcObject).connect(dest); } catch (_) {}
  }

  const videoTrack = comp.captureStream(30).getVideoTracks()[0];
  const tracks = [videoTrack, ...dest.stream.getAudioTracks()].filter(Boolean);
  const recStream = new MediaStream(tracks);

  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find(t => MediaRecorder.isTypeSupported(t)) || '';

  mediaRecorder = new MediaRecorder(recStream, mimeType ? { mimeType } : {});
  recordChunks = [];

  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordChunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    clearInterval(recordTimer);
    audioCtx.close();
    const blob = new Blob(recordChunks, { type: 'video/webm' });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const suggestedName = `recording-${ts}.webm`;

    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: 'WebM 동영상', accept: { 'video/webm': ['.webm'] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } catch (e) {
        if (e.name !== 'AbortError') fallbackDownload(blob, suggestedName);
      }
    } else {
      fallbackDownload(blob, suggestedName);
    }
  };

  mediaRecorder.start(500);
  recStartTime = Date.now();

  // UI
  recordBtn.textContent = '⏹ 중지';
  recordBtn.classList.add('recording');
  recIndicator.classList.remove('hidden');
  recTimerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - recStartTime) / 1000);
    recTimer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  clearInterval(recTimerInterval);
  recordBtn.textContent = '⏺ 녹화';
  recordBtn.classList.remove('recording');
  recIndicator.classList.add('hidden');
  recTimer.textContent = '00:00';
}

function fallbackDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ════════════════════════════════════════════
   모드 전환 (화이트보드 ↔ 웹)
════════════════════════════════════════════ */
modeWbBtn.addEventListener('click', () => switchMode('wb'));
modeWebBtn.addEventListener('click', () => switchMode('web'));

function switchMode(mode) {
  if (mode === 'wb') {
    wbContent.classList.remove('hidden');
    webContent.classList.add('hidden');
    pagesPanel.classList.toggle('hidden', !pdfDoc);
    modeWbBtn.classList.add('active');
    modeWebBtn.classList.remove('active');
    clearAllBtn.style.display = '';
  } else {
    wbContent.classList.add('hidden');
    webContent.classList.remove('hidden');
    pagesPanel.classList.add('hidden');
    modeWebBtn.classList.add('active');
    modeWbBtn.classList.remove('active');
    clearAllBtn.style.display = 'none';
  }
}

/* ════════════════════════════════════════════
   웹 패널
════════════════════════════════════════════ */
function navigateWebFrame(url, broadcast = true) {
  let target = url.trim();
  if (!target) return;
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  webUrlInput.value = target;
  webNewtab.href = target;
  webOpenLink.href = target;
  webBlocked.classList.add('hidden');
  webFrame.src = target;

  // 로드 후 차단 여부 감지 (같은 도메인만 가능, 크로스 오리진은 오류로 판단)
  webFrame.onload = () => {
    try {
      // cross-origin이면 접근 시 예외 발생 → 로드는 됐지만 확인 불가
      void webFrame.contentDocument;
      webBlocked.classList.add('hidden');
    } catch (_) {
      // 크로스 오리진 정상 로드 (차단 아님)
      webBlocked.classList.add('hidden');
    }
  };
  webFrame.onerror = () => webBlocked.classList.remove('hidden');

  if (broadcast && socket) socket.emit('web-navigate', target);
}

webGoBtn.addEventListener('click', () => navigateWebFrame(webUrlInput.value));
webUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') navigateWebFrame(webUrlInput.value); });
webRefresh.addEventListener('click', () => { webFrame.src = webFrame.src; });
webBack.addEventListener('click', () => { try { webFrame.contentWindow.history.back(); } catch(_) {} });
webForward.addEventListener('click', () => { try { webFrame.contentWindow.history.forward(); } catch(_) {} });

// Ctrl+휠 줌
canvasContainer.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();

  const containerRect = canvasContainer.getBoundingClientRect();
  // 마우스가 가리키는 위치(스크롤 포함)를 캔버스 좌표로 변환
  const mouseX = (e.clientX - containerRect.left + canvasContainer.scrollLeft);
  const mouseY = (e.clientY - containerRect.top  + canvasContainer.scrollTop);

  const prevZoom = zoomLevel;
  const step = e.deltaY < 0 ? 0.1 : -0.1;
  zoomLevel = Math.min(4.0, Math.max(0.25, Math.round((zoomLevel + step) * 100) / 100));
  if (zoomLevel === prevZoom) return;

  applyZoom();
  showZoomIndicator();
  if (currentTool === 'eraser') setEraserCursor(strokeSize);

  // 줌 후에도 마우스 아래 지점이 같은 위치에 오도록 스크롤 보정
  const ratio = zoomLevel / prevZoom;
  canvasContainer.scrollLeft = mouseX * ratio - (e.clientX - containerRect.left);
  canvasContainer.scrollTop  = mouseY * ratio - (e.clientY - containerRect.top);
}, { passive: false });

// 키보드 단축키
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); return; }
  if (e.key === 'ArrowLeft') pdfPrev.click();
  if (e.key === 'ArrowRight') pdfNext.click();
  if (e.key === 'p' || e.key === 'P') toolPen.click();
  if (e.key === 'e' || e.key === 'E') toolEraser.click();
});
