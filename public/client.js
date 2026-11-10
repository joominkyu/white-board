/* ────────────────────────────────────────────
   봄노트 실시간 수업 클라이언트
──────────────────────────────────────────── */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// 서버에서 TURN 자격증명을 못 받았을 때 사용
const FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

// 얼굴 영상 최대 비트레이트 — 필기는 영상이 아니라 데이터로 동기화되므로 낮춰도 수업 품질 영향이 적고,
// TURN 중계 비용(트래픽 과금)을 줄임. 음성 포함 약 600kbps
const VIDEO_MAX_BITRATE = 550_000;
// 화면 공유는 글씨가 많아 더 높게 (공유하는 동안만)
const SCREEN_MAX_BITRATE = 1_200_000;
let screenTrack = null;     // 내가 공유 중인 화면 트랙
let remoteSharing = false;  // 상대가 화면 공유 중

// 내 획 식별용 ID — 입장 시 서버가 알려줌 (봄노트 사용자 ID)
let clientId = '';
// 아이콘 (index.html의 스프라이트 참조)
const ic = (name) => `<svg class="ic"><use href="#i-${name}"/></svg>`;

// 봄노트가 발급한 입장 토큰 (URL #token=...)
const liveToken = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
// 지난 수업 다시 보기 (영상·채팅·그리기 없이 필기만)
let reviewMode = false;

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ── 상태 ──
let socket, localStream, peerConnection;
let myUsername = '', myRoomId = '', remoteSocketId = '';
let hasJoined = false;
let inRoom = false;          // 수업방에 들어가 있어 필기를 바로 보낼 수 있음
let disconnectedAt = 0;      // 마지막으로 서버 연결이 끊긴 시각
const strokeSentAt = new Map(); // 내 획 id → 마지막으로 보낸(보내려던) 시각 — 끊긴 사이 빠진 획을 다시 보낼 때 사용
// 연결이 죽은 줄 모르고 보낸 획까지 챙기기 위해, 끊기기 전 이 시간 안에 보낸 획도 다시 확인 (서버 응답 대기 60초 + 여유)
const RESEND_WINDOW_MS = 90 * 1000;
let lastCallRestartAt = 0;
const CALL_RECOVER_MS = 5000; // 영상이 이 시간 넘게 불안정하면 다시 연결
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
let strokeSize = 1;
// 펜·도형과 지우개는 굵기를 따로 기억
let drawSize = 1;
let eraserSize = 20;
let penButtonPrevTool = null; // S펜 버튼으로 잠깐 지우개를 쓰기 전 도구
let lastX = 0, lastY = 0;
let currentShape   = 'rect'; // 'rect' | 'triangle' | 'circle'
let currentPenMode = 'free'; // 'free' | 'line' | 'snap'
let shapeStartX = 0, shapeStartY = 0;

// PDF 상태
let pdfDoc = null, pdfCurrentPage = 1, pdfTotalPages = 0, pdfVersion = null;
// PDF를 내려받는 동안 상대가 넘긴 페이지 — 다 받은 뒤 이 페이지로 이동 (예전에는 무시하고 1쪽에 머물렀음)
let pdfLoading = false, remotePdfPage = 1;
let pendingPdfPage = null; // 연결이 끊긴 동안 내가 넘긴 페이지 — 다시 들어간 뒤 알림
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
const lobbyInfo    = document.getElementById('lobby-info');
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
const screenContent = document.getElementById('screen-content');
const modeWbBtn   = document.getElementById('mode-wb');
const modeScreenBtn = document.getElementById('mode-screen');
const screenView    = document.getElementById('screen-view');
const screenEmpty   = document.getElementById('screen-empty');
const screenShareBtn = document.getElementById('screen-share-btn');
const remoteRecBanner = document.getElementById('remote-rec-banner');
const notifyBtn = document.getElementById('notify-btn');
const notifyMsg = document.getElementById('notify-msg');
const reconnectCallBtn = document.getElementById('reconnect-call-btn');
let canNotify = false;
let canNote = false; // 선생님 [나가기] 때 수업 기록 창
const clearAllBtn = document.getElementById('clear-all-btn');

const recordBtn    = document.getElementById('record-btn');
const recIndicator = document.getElementById('rec-indicator');
const recTimer     = document.getElementById('rec-timer');
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

// 토큰에 담긴 이름·수업 ID를 화면 표시용으로 읽음 (검증은 서버가 함)
(function () {
  try {
    // base64url → UTF-8 (한글 이름이 깨지지 않도록 바이트로 디코딩)
    const bin = atob(liveToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
    myUsername = String(claims.name || '');
    myRoomId = String(claims.sid || '');
    reviewMode = claims.role === 'review';
    lobbyInfo.textContent = reviewMode
      ? '지난 수업 필기를 불러오는 중...'
      : `${myUsername}님, 아래 버튼을 눌러 수업에 입장하세요.`;
    if (reviewMode) joinBtn.classList.add('hidden');
  } catch (_) {
    joinBtn.disabled = true;
    lobbyInfo.textContent = '봄노트에서 [실시간 수업] 버튼으로 입장해주세요.';
  }
})();

// 카메라·소리 재생을 위해 사용자가 버튼을 눌러 입장
joinBtn.addEventListener('click', () => {
  if (!liveToken) return;
  lobbyError.textContent = '';
  initApp();
});

// 카메라 권한을 다시 요청 — 성공하면 새로고침해서 카메라를 켠 채로 다시 입장 (필기는 서버에 남아 있음)
async function retryMedia() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    stream.getTracks().forEach(t => t.stop());
    location.reload();
  } catch (e) {
    alert(mediaErrorMessage(e));
  }
}

function mediaErrorMessage(e) {
  if (e.name === 'NotFoundError') return '카메라나 마이크를 찾을 수 없어요. 기기 연결을 확인해 주세요.';
  if (e.name === 'NotReadableError') return '다른 앱이 카메라를 쓰고 있어요. 그 앱을 닫고 다시 시도해 주세요.';
  return '카메라·마이크가 차단되어 있어요.\n\n'
    + '1. 브라우저 주소창의 사이트 설정(또는 기기 설정)에서 카메라·마이크를 허용해 주세요.\n'
    + '2. 카카오톡 안에서 열었다면 Safari나 Chrome으로 다시 열어 주세요.';
}

// 수업 중 패드·폰 화면이 꺼지지 않게 (지원하는 브라우저만, 다른 앱 갔다 오면 다시 요청)
let wakeLock = null;
async function keepScreenOn() {
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLock) keepScreenOn();
});

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
    nocam.innerHTML = `<span style="font-size:20px">${ic('video-off')}</span><span>카메라/마이크<br>권한을 허용해주세요</span><button type="button" class="nocam-retry">다시 시도</button>`;
    nocam.querySelector('.nocam-retry').addEventListener('click', retryMedia);
    localVideo.parentElement.appendChild(nocam);
  }

  // getUserMedia try-catch 밖에서 호출 — 실패해도 카메라 스트림에 영향 없음
  try { setupMicGain(); } catch (_) {}

  socket = io();
  setupSocketEvents();
  // 최초 연결과 재연결 모두 방에 (다시) 입장
  socket.on('connect', () => {
    socket.emit('join-room', { token: liveToken });
  });

  lobby.classList.add('hidden');
  roomEl.classList.remove('hidden');
  roomTitle.textContent = '봄노트 실시간 수업';
  initCanvasSize();
  keepScreenOn();

  // 입장 후 기기 목록 공유 (방장이 상대방 기기 설정할 수 있도록)
  setTimeout(emitUserDevices, 1000);
}

/* ════════════════════════════════════════════
   Socket.io 이벤트
════════════════════════════════════════════ */
function setupSocketEvents() {

  socket.on('joined', async ({ me, users, isHost: host, canNotify: notifyAllowed, canNote: noteAllowed, state }) => {
    // 서버 상태로 덮어쓰기 전에, 끊기기 직전~끊긴 동안 쓴 내 획을 챙겨 둠
    const since = disconnectedAt - RESEND_WINDOW_MS;
    const unsent = hasJoined ? strokes.filter(s => (strokeSentAt.get(s.id) || 0) >= since) : [];
    canNotify = !!notifyAllowed;
    canNote = !!noteAllowed;
    updateNotifyButton();
    clientId = me;
    if (mediaRecorder && mediaRecorder.state === 'recording') socket.emit('recording-state', true);
    if (screenTrack) socket.emit('screen-share-state', true);
    if (hasJoined) showSystemMsg('서버에 다시 연결되었습니다.');
    hasJoined = true;
    isHost = host;
    updateHostUI();
    const others = users.filter(u => u.socketId !== socket.id);
    if (others.length > 0) {
      remoteSocketId = others[0].socketId;
      remoteLabel.textContent = others[0].username;
    }
    updateNotifyButton();
    // 끊긴 동안 내가 넘긴 페이지가 있으면 (같은 PDF일 때) 서버 페이지 대신 그 페이지로
    const myPage = state.pdf && state.pdf.version === pdfVersion ? pendingPdfPage : null;
    pendingPdfPage = null;
    if (myPage) state.pdfPage = myPage;
    // 서버 필기는 바로 반영되므로, PDF 그리기(화면이 가려져 있으면 멈춤)를 기다리지 않고 바로 필기를 다시 보내고 전송을 재개
    const applied = applyRoomState(state);
    resendStrokes(unsent);
    inRoom = true;
    if (myPage) emitPdfPage(myPage);
    await applied;
  });

  socket.on('disconnect', (reason) => {
    inRoom = false;
    disconnectedAt = Date.now();
    // 직접 나간 경우(io client disconnect)는 안내하지 않음
    if (reason !== 'io client disconnect') showSystemMsg('서버 연결이 끊겼습니다. 다시 연결하는 중...');
  });

  // 학생이 영상 끊김을 알아채고 요청 → 선생님이 다시 연결
  socket.on('call-restart-request', () => { if (isHost) requestCallRestart(); });

  socket.on('host-transferred', () => {
    isHost = true;
    updateHostUI();
    showSystemMsg('방장이 나가서 회원님이 방장이 되었습니다.');
  });

  socket.on('auth-failed', () => {
    leaveRoom();
    lobbyError.textContent = '입장 권한이 없거나 링크가 만료되었습니다. 봄노트에서 다시 입장해주세요.';
  });

  socket.on('room-full', () => {
    leaveRoom();
    alert('방이 꽉 찼습니다 (최대 2명).');
  });

  // 상대방이 나중에 들어옴 → 내가 offer를 보냄 (보드 상태는 서버가 직접 전달)
  socket.on('user-joined', async ({ socketId, username, rejoined }) => {
    remoteSocketId = socketId;
    updateNotifyButton();
    remoteLabel.textContent = username;
    if (!rejoined) showSystemMsg(`${username}님이 입장했습니다.`); // 잠깐 끊겼다 돌아온 경우는 영상만 다시 연결
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
    updateNotifyButton();
    remoteRecBanner.classList.add('hidden');
    if (remoteSharing) {
      remoteSharing = false;
      screenView.srcObject = null;
      screenEmpty.classList.remove('hidden');
      switchMode('wb');
    }
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
    remotePdfPage = 1;
    pdfLoading = true;
    await loadPdfFromServer(version);
    pdfLoading = false;
    await renderPdfPage(remotePdfPage);
  });
  socket.on('pdf-page-change', (page) => {
    remotePdfPage = page;
    if (pdfDoc && !pdfLoading) renderPdfPage(page);
  });

  // 웹 공유
  // [학생에게 알림톡 보내기] 결과
  socket.on('notify-result', ({ ok, reason }) => {
    const msg = ok ? '알림톡을 보냈어요' : {
      no_phone: '학생 전화번호가 등록되지 않았어요',
      too_soon: '잠시 후 다시 보낼 수 있어요',
      ended: '수업이 종료된 상태예요',
      disabled: '알림톡이 설정되지 않았어요',
    }[reason] || '발송에 실패했어요';
    notifyMsg.textContent = msg;
    if (ok || reason === 'too_soon') {
      notifyBtn.disabled = true;
      setTimeout(() => { notifyBtn.disabled = false; notifyMsg.textContent = ''; }, 60 * 1000);
    } else {
      notifyBtn.disabled = false;
    }
  });

  // 상대방 녹화 상태 — 녹화 중이면 상단에 표시
  socket.on('recording-state', ({ recording, username }) => {
    remoteRecBanner.classList.toggle('hidden', !recording);
    showSystemMsg(recording ? `${username}님이 녹화를 시작했습니다.` : `${username}님이 녹화를 중지했습니다.`);
  });

  // 상대방 화면 공유 — 공유 중이면 큰 화면으로 전환
  socket.on('screen-share-state', ({ sharing }) => {
    remoteSharing = sharing;
    screenView.srcObject = sharing ? remoteVideo.srcObject : null;
    screenEmpty.classList.toggle('hidden', sharing);
    switchMode(sharing ? 'screen' : 'wb');
    showSystemMsg(sharing ? '상대방이 화면 공유를 시작했습니다.' : '상대방이 화면 공유를 끝냈습니다.');
  });

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
        if (peerConnection && !screenTrack) {
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
// 선생님이고 학생이 아직 없을 때만 [알림톡 보내기] 표시
function updateNotifyButton() {
  const show = canNotify && !remoteSocketId;
  notifyBtn.classList.toggle('hidden', !show);
  if (!show) notifyMsg.textContent = '';
  // 학생이 방에 있는데 영상이 안 붙었을 때 선생님이 직접 다시 연결
  reconnectCallBtn.classList.toggle('hidden', !(isHost && remoteSocketId));
}

reconnectCallBtn.addEventListener('click', () => {
  lastCallRestartAt = 0;
  showSystemMsg('영상을 다시 연결하는 중...');
  requestCallRestart();
});

// 영상 다시 연결 — 선생님이면 직접 걸고, 학생이면 선생님에게 요청. 5초에 한 번만
function requestCallRestart() {
  if (!socket || !remoteSocketId) return;
  if (Date.now() - lastCallRestartAt < CALL_RECOVER_MS) return;
  lastCallRestartAt = Date.now();
  if (isHost) startCall();
  else socket.emit('call-restart-request');
}

notifyBtn.addEventListener('click', () => {
  if (!socket) return;
  notifyBtn.disabled = true;
  notifyMsg.textContent = '보내는 중...';
  socket.emit('notify-student');
});

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

// TURN 중계를 거쳐 연결됐는지 서버에 알림 (비용 측정용)
async function reportConnectionType(pc) {
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach(s => { if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) pair = s; });
    if (!pair) return;
    let relay = false;
    stats.forEach(s => {
      if ((s.id === pair.localCandidateId || s.id === pair.remoteCandidateId) && s.candidateType === 'relay') relay = true;
    });
    socket && socket.emit('connection-info', { relay });
  } catch (_) {}
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
    localStream.getVideoTracks().forEach(t => peerConnection.addTransceiver(screenTrack || t, {
      direction: 'sendrecv', streams: [localStream],
      sendEncodings: [{ maxBitrate: screenTrack ? SCREEN_MAX_BITRATE : VIDEO_MAX_BITRATE }]
    }));
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
      if (remoteSharing) screenView.srcObject = e.streams[0];
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

  let unstableTimer = null;
  peerConnection.oniceconnectionstatechange = () => {
    if (peerConnection !== pc) return;
    clearTimeout(unstableTimer);
    const s = pc.iceConnectionState;
    // 어느 쪽이 알아채든 다시 연결 (실패하면 바로, 불안정(disconnected)이 5초 넘게 이어져도)
    if (s === 'failed') requestCallRestart();
    else if (s === 'disconnected') {
      unstableTimer = setTimeout(() => {
        if (peerConnection === pc && pc.iceConnectionState === 'disconnected') requestCallRestart();
      }, CALL_RECOVER_MS);
    }
  };

  peerConnection.onconnectionstatechange = () => {
    if (peerConnection !== pc) return;
    const s = pc.connectionState;
    if (s === 'connected') {
      reportConnectionType(pc);
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
    if (peerConnection && !screenTrack) {
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
  remoteMicBtn.innerHTML = ic(remoteMicMuted ? 'mic-off' : 'mic');
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
   나가기
════════════════════════════════════════════ */
leaveBtn.addEventListener('click', () => {
  if (canNote && socket && socket.connected) openLessonNote();
  else leaveRoom();
});

/* ── 수업 기록 (선생님이 [나가기]를 누르면 오늘 수업 내용을 적음) ── */
const lessonNoteModal = document.getElementById('lesson-note-modal');
const lessonNoteText  = document.getElementById('lesson-note-text');
const lessonNoteMsg   = document.getElementById('lesson-note-msg');
const lessonNoteSave  = document.getElementById('lesson-note-save');
let lessonNoteLoaded = false; // 기존 기록을 못 불러왔으면 빈 칸 저장으로 지우지 않게

function openLessonNote() {
  lessonNoteLoaded = false;
  lessonNoteText.value = '';
  lessonNoteMsg.textContent = '불러오는 중...';
  lessonNoteSave.disabled = true;
  lessonNoteModal.classList.remove('hidden');
  socket.emit('lesson-note-get', (r) => {
    lessonNoteSave.disabled = false;
    if (r && r.ok) {
      lessonNoteLoaded = true;
      lessonNoteText.value = r.content || '';
      lessonNoteMsg.textContent = '';
    } else {
      lessonNoteMsg.textContent = '기존 기록을 불러오지 못했어요.';
    }
    lessonNoteText.focus();
  });
}

function closeLessonNote() { lessonNoteModal.classList.add('hidden'); }

lessonNoteSave.addEventListener('click', () => {
  if (!lessonNoteLoaded && !lessonNoteText.value.trim()) { closeLessonNote(); leaveRoom(); return; }
  lessonNoteSave.disabled = true;
  lessonNoteMsg.textContent = '저장 중...';
  socket.emit('lesson-note-save', { content: lessonNoteText.value }, (r) => {
    if (r && r.ok) { closeLessonNote(); leaveRoom(); return; }
    lessonNoteSave.disabled = false;
    lessonNoteMsg.textContent = '저장하지 못했어요. 다시 시도하거나 기록 없이 나가 주세요.';
  });
});
document.getElementById('lesson-note-skip').addEventListener('click', () => { closeLessonNote(); leaveRoom(); });
document.getElementById('lesson-note-close').addEventListener('click', closeLessonNote);

function leaveRoom() {
  if (mediaRecorder && mediaRecorder.state === 'recording') stopRecording();
  if (screenTrack) { screenTrack.stop(); screenTrack = null; }
  screenShareBtn.querySelector('.btn-label').textContent = '화면 공유';
  screenShareBtn.classList.remove('active');
  remoteSharing = false;
  screenView.srcObject = null;
  remoteRecBanner.classList.add('hidden');
  switchMode('wb');
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  pendingCandidates = [];
  iceConfigPromise = null;
  hasJoined = false;
  inRoom = false;
  remoteSocketId = '';
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (micAudioCtx) { micAudioCtx.close(); micAudioCtx = null; }
  gainedAudioTrack = null;
  micOn = true; camOn = true;
  isHost = false;
  remoteMicMuted = false;
  remoteMicBtn.innerHTML = ic('mic');
  remoteMicBtn.classList.remove('muted');
  remoteVolSlider.value = 100;
  remoteVolDisplay.textContent = '100%';
  remoteControls.classList.add('hidden');
  if (socket) { socket.disconnect(); socket = null; }
  pdfDoc = null;
  pdfVersion = null;
  strokes = [];
  myStroke = null;
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
// 빈 보드(16:9)를 화면 크기에 맞춤 — 패드처럼 작은 화면에서도 처음부터 전체가 보이게
function initCanvasSize() {
  const fit = Math.min((canvasContainer.clientWidth || 1600) / 1600, (canvasContainer.clientHeight || 900) / 900, 2);
  const w = Math.floor(1600 * fit), h = Math.floor(900 * fit);
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

// 펜 필압(0~1) → 굵기 배율. 필압 정보가 없으면 1
const pressureScale = (p) => (p === undefined ? 1 : 0.3 + 1.4 * p);

// W·H: 그릴 캔버스 크기 (기본은 화면 캔버스, PDF 내보내기 때는 페이지 이미지 크기)
function drawStroke(ctx, s, W = drawCanvas.width, H = drawCanvas.height) {
  const pts = s.points.map(([x, y]) => [x * W, y * H]);
  const size = s.size * W;
  if (s.kind === 'shape') {
    renderShape(ctx, s.shape, pts[0][0], pts[0][1], pts[1][0], pts[1][1], s.color, size, s.filled);
    return;
  }
  if (s.kind === 'line') {
    renderLine(ctx, pts[0][0], pts[0][1], pts[1][0], pts[1][1], s.color, size);
    return;
  }
  setupCtx(ctx, s.tool, s.color, size);
  // 필압이 있는 펜 획은 구간마다 굵기를 바꿔 그림
  if (s.points[0].length > 2) {
    for (let i = 0; i < pts.length; i++) {
      const j = Math.max(0, i - 1);
      ctx.lineWidth = size * pressureScale((s.points[j][2] + s.points[i][2]) / 2);
      ctx.beginPath();
      ctx.moveTo(pts[j][0], pts[j][1]);
      ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    }
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 1) ctx.lineTo(pts[0][0], pts[0][1]); // 점 하나
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

// 그리는 중인 자유선의 한 구간만 그림 (독립된 path라 동시에 그려도 섞이지 않음)
function drawSegment(s, from, to) {
  const [x1, y1] = toPx(from), [x2, y2] = toPx(to);
  setupCtx(drawCtx, s.tool, s.color, s.size * drawCanvas.width * pressureScale(to[2] === undefined ? undefined : ((from[2] ?? to[2]) + to[2]) / 2));
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
  emitStroke('stroke-start', stroke, stroke.id);
}

// 필기 전송 — 수업방에 있을 때만 보내고, 보낸 시각을 기록해 두었다가 다시 연결되면 빠진 것을 다시 보냄
function emitStroke(event, data, id) {
  strokeSentAt.set(id, Date.now());
  if (socket && inRoom) socket.emit(event, data);
}

// 다시 들어온 뒤: 서버에 없거나 덜 저장된 내 획을 다시 보내고 화면에도 되살림
function resendStrokes(list) {
  for (const s of list) {
    const saved = strokes.find(x => x.id === s.id);
    if (!saved) {
      strokes.push(s);
      socket.emit('stroke-start', s);
    } else if (saved.points.length < s.points.length) {
      socket.emit('stroke-points', { id: s.id, points: s.points.slice(saved.points.length) });
      saved.points = s.points;
    }
  }
  strokeSentAt.clear();
  if (list.length) redrawBoard();
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

// 마우스·터치·펜을 Pointer Events 하나로 처리
let activePointerId = null;
let activePointerType = null;
// 손바닥 인식: 펜을 쓰는 동안(마지막 펜 입력 후 10초)에는 손가락·손바닥 터치로 그리지 않음
const PEN_HOLD_MS = 10 * 1000;
let lastPenAt = 0;

// 정규화 좌표 + 펜일 때만 필압(0~1)
function strokePoint(e) {
  const { x, y } = getPos(e);
  const p = toNorm(x, y);
  if (e.pointerType === 'pen' && currentTool !== 'eraser') p.push(Math.round(e.pressure * 100) / 100); // 지우개는 필압 없이 고정 굵기
  return p;
}

drawCanvas.addEventListener('pointerdown', e => {
  if (reviewMode) return;
  if (e.pointerType === 'pen') lastPenAt = Date.now();
  if (e.pointerType === 'touch' && Date.now() - lastPenAt < PEN_HOLD_MS) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (activePointerId !== null) {
    // 두 번째 손가락(핀치 줌 등)이 닿으면 그리던 획을 마무리
    finishDrawing(e, false);
    // 펜은 한 번에 하나뿐 → 앞 획이 끝난 신호를 놓친 것이므로 이 펜 입력으로 새 획 시작
    if (!(e.pointerType === 'pen' && activePointerType === 'pen')) return;
  }
  activePointerId = e.pointerId;
  activePointerType = e.pointerType;
  // S펜 옆 버튼(또는 지우개 끝)을 누른 채 쓰면 그 획만 지우개
  if (e.pointerType === 'pen' && (e.buttons & 34) && currentTool !== 'eraser') {
    penButtonPrevTool = currentTool;
    currentTool = 'eraser';
    strokeSize = eraserSize;
  }
  // 캔버스 밖으로 나가도 획이 끊기지 않도록 (포인터가 이미 해제됐으면 실패해도 그리기는 계속)
  try { drawCanvas.setPointerCapture(e.pointerId); } catch (_) {}

  isDrawing = true;
  const { x, y } = getPos(e);
  lastX = x; lastY = y;
  if (usesPreview()) { shapeStartX = x; shapeStartY = y; return; }
  const p = strokePoint(e);
  myStroke = {
    id: uid(), owner: clientId, page: currentPageKey(), kind: 'path',
    tool: currentTool, color: strokeColor, size: normSize(), points: [p]
  };
  strokes.push(myStroke);
  drawSegment(myStroke, p, p);
  emitStroke('stroke-start', myStroke, myStroke.id);
});

drawCanvas.addEventListener('pointermove', e => {
  if (e.pointerId !== activePointerId || !isDrawing) return;
  if (usesPreview()) {
    const { x, y } = getPos(e);
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
  // 펜은 이벤트 사이 좌표도 모아서 그려 선을 매끄럽게
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  const added = [];
  for (const ev of (events.length ? events : [e])) {
    const p = strokePoint(ev);
    const prev = myStroke.points[myStroke.points.length - 1];
    myStroke.points.push(p);
    drawSegment(myStroke, prev, p);
    added.push(p);
  }
  emitStroke('stroke-points', { id: myStroke.id, points: added }, myStroke.id);
});

function finishDrawing(e, commit) {
  activePointerId = null;
  if (!isDrawing) return;
  isDrawing = false;
  if (usesPreview()) {
    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    if (!commit) return;
    const { x, y } = getPos(e);
    const base = { id: uid(), owner: clientId, page: currentPageKey(), color: strokeColor, size: normSize() };
    if (currentTool === 'shape') {
      commitStroke({ ...base, kind: 'shape', shape: currentShape, filled: shapeFilled,
        points: [toNorm(shapeStartX, shapeStartY), toNorm(x, y)] });
    } else {
      const [ex, ey] = snapEnd(x, y);
      commitStroke({ ...base, kind: 'line', points: [toNorm(shapeStartX, shapeStartY), toNorm(ex, ey)] });
    }
    return;
  }
  myStroke = null;
  if (penButtonPrevTool) { currentTool = penButtonPrevTool; strokeSize = drawSize; penButtonPrevTool = null; }
}

drawCanvas.addEventListener('pointerup', e => { if (e.pointerId === activePointerId) finishDrawing(e, true); });
drawCanvas.addEventListener('pointercancel', e => { if (e.pointerId === activePointerId) finishDrawing(e, false); });

// 핀치 줌
let pinchStartDist = 0, pinchStartZoom = 1, pinchStartMid = null, pinchStartScroll = null;
function touchMid(t) {
  const r = canvasContainer.getBoundingClientRect();
  return { x: (t[0].clientX + t[1].clientX) / 2 - r.left, y: (t[0].clientY + t[1].clientY) / 2 - r.top };
}
// 길게 눌렀을 때 뜨는 브라우저 메뉴 차단
canvasContainer.addEventListener('contextmenu', e => e.preventDefault());

canvasContainer.addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    pinchStartDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    pinchStartZoom = zoomLevel;
    pinchStartMid = touchMid(e.touches);
    pinchStartScroll = { left: canvasContainer.scrollLeft, top: canvasContainer.scrollTop };
  }
}, { passive: true });
canvasContainer.addEventListener('touchmove', e => {
  // 보드 위 한 손가락·펜 움직임은 브라우저 기본 동작을 막음 → iPad 손글씨 인식(Scribble)이 펜 입력을 가로채지 못하게
  if (e.touches.length === 1) { if (e.target === drawCanvas) e.preventDefault(); return; }
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
  // 두 손가락 사이 지점이 손가락을 따라가도록 스크롤 → 확대 기준점 + 두 손가락 이동
  const mid = touchMid(e.touches);
  const ratio = zoomLevel / pinchStartZoom;
  canvasContainer.scrollLeft = (pinchStartScroll.left + pinchStartMid.x) * ratio - mid.x;
  canvasContainer.scrollTop  = (pinchStartScroll.top  + pinchStartMid.y) * ratio - mid.y;
}, { passive: false });

// 패드 회전·창 크기 변경 시 보드를 다시 화면에 맞춤
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (roomEl.classList.contains('hidden')) return;
    if (pdfDoc) renderPdfPage(pdfCurrentPage); else initCanvasSize();
  }, 200);
});

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

const PEN_ICONS = { free: ic('pencil'), line: '╱', snap: '┼' };

toolPen.addEventListener('click', (e) => {
  e.stopPropagation();
  currentTool = 'pen';
  applyToolSize();
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
    applyToolSize();
    penPopup.classList.add('hidden');
    toolPen.classList.add('active');
    toolEraser.classList.remove('active');
    toolShapeBtn.classList.remove('active');
    toolShapeBtn.innerHTML = ic('shapes');
    toolPen.innerHTML = PEN_ICONS[currentPenMode];
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
    applyToolSize();
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
  applyToolSize();
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

function applyToolSize() {
  strokeSize = currentTool === 'eraser' ? eraserSize : drawSize;
  sizeSlider.value = strokeSize;
  sizeDisplay.textContent = strokeSize;
}

sizeSlider.addEventListener('input', e => {
  strokeSize = parseInt(e.target.value, 10);
  if (currentTool === 'eraser') eraserSize = strokeSize; else drawSize = strokeSize;
  sizeDisplay.textContent = strokeSize;
  if (currentTool === 'eraser') setEraserCursor(strokeSize);
});

function updateHostUI() {
  localLabel.innerHTML = isHost ? `${ic('crown')} ${escHtml(myUsername)}` : escHtml(myUsername);
  clearAllBtn.style.opacity = isHost ? '1' : '0.3';
  clearAllBtn.style.cursor  = isHost ? 'pointer' : 'not-allowed';
  clearAllBtn.title = isHost ? '전체 지우기' : '방장만 지울 수 있습니다';
  if (isHost) remoteControls.classList.remove('hidden');
  else        remoteControls.classList.add('hidden');
}

clearAllBtn.addEventListener('click', () => {
  if (!isHost) return;
  if (!confirm('이 페이지 필기를 모두 지울까요? 되돌릴 수 없어요.')) return;
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
  if (reviewMode) return;
  const page = currentPageKey();
  const mine = strokes.findLast(s => s.owner === clientId && s.page === page);
  if (!mine) return;
  strokes = strokes.filter(s => s !== mine);
  if (myStroke === mine) { myStroke = null; isDrawing = false; }
  redrawBoard();
  socket && socket.emit('stroke-undo', mine.id);
}

document.getElementById('tool-undo').addEventListener('click', undo);

function clearPdfCanvas() {
  pdfCtx.clearRect(0, 0, pdfCanvas.width, pdfCanvas.height);
}

/* ════════════════════════════════════════════
   서버에서 받은 방 상태 적용 (입장/재접속 시)
════════════════════════════════════════════ */
async function applyRoomState({ pdf, pdfPage, strokes: serverStrokes }) {
  strokes = serverStrokes;
  myStroke = null;
  isDrawing = false;

  if (pdf) {
    remotePdfPage = pdfPage;
    if (pdf.version !== pdfVersion) {
      pdfLoading = true;
      await loadPdfFromServer(pdf.version);
      pdfLoading = false;
    }
    await renderPdfPage(remotePdfPage);
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
  // 약한 와이파이에서 한 번 실패해도 2초 간격으로 3번까지 다시 시도
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`/rooms/${encodeURIComponent(myRoomId)}/pdf?v=${version}`, { headers: { 'X-Socket-Id': socket.id } });
      if (res.ok) { await loadPdfData(new Uint8Array(await res.arrayBuffer()), version); return; }
    } catch (_) {}
    if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
  }
  showSystemMsg('PDF를 불러오지 못했습니다.');
}

// 내가 넘긴 페이지를 상대에게 알림 — 연결이 끊긴 동안이면 기억했다가 다시 들어간 뒤 알림
function emitPdfPage(page) {
  if (socket && inRoom) socket.emit('pdf-page-change', page);
  else pendingPdfPage = page;
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
      emitPdfPage(page);
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
  emitPdfPage(pdfCurrentPage);
});

pdfNext.addEventListener('click', () => {
  if (!pdfDoc || pdfCurrentPage >= pdfTotalPages) return;
  renderPdfPage(pdfCurrentPage + 1);
  emitPdfPage(pdfCurrentPage);
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
  socket && socket.emit('recording-state', true);
  recStartTime = Date.now();

  // UI
  recordBtn.innerHTML = `${ic('stop')} 중지`;
  recordBtn.classList.add('recording');
  recIndicator.classList.remove('hidden');
  recTimerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - recStartTime) / 1000);
    recTimer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  socket && socket.emit('recording-state', false);
  clearInterval(recTimerInterval);
  recordBtn.innerHTML = `${ic('record')} 녹화`;
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
   모드 전환 (화이트보드 ↔ 화면 공유 보기)
════════════════════════════════════════════ */
modeWbBtn.addEventListener('click', () => switchMode('wb'));
modeScreenBtn.addEventListener('click', () => switchMode('screen'));

function switchMode(mode) {
  const wb = mode === 'wb';
  wbContent.classList.toggle('hidden', !wb);
  screenContent.classList.toggle('hidden', wb);
  pagesPanel.classList.toggle('hidden', !wb || !pdfDoc);
  modeWbBtn.classList.toggle('active', wb);
  modeScreenBtn.classList.toggle('active', !wb);
  clearAllBtn.style.display = wb ? '' : 'none';
}

/* ════════════════════════════════════════════
   화면 공유 (보내는 영상을 카메라 ↔ 화면으로 교체)
════════════════════════════════════════════ */
function videoSender() {
  return peerConnection && peerConnection.getSenders().find(s => s.track?.kind === 'video');
}

async function setSenderBitrate(sender, maxBitrate) {
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
  params.encodings[0].maxBitrate = maxBitrate;
  try { await sender.setParameters(params); } catch (_) {}
}

async function startScreenShare() {
  // 패드·폰 브라우저 대부분은 화면 공유 미지원 — 안내 없이 눌러도 아무 반응이 없던 문제
  if (!navigator.mediaDevices?.getDisplayMedia) {
    alert('이 기기의 브라우저는 화면 공유를 지원하지 않아요. PC에서 공유해 주세요.');
    return;
  }
  if (!localStream || !localStream.getVideoTracks()[0]) {
    alert('카메라가 연결된 상태에서만 화면 공유를 할 수 있어요.');
    return;
  }
  const sender = videoSender();
  if (!sender) {
    alert('상대방이 입장한 뒤 화면을 공유할 수 있어요.');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
  } catch (_) {
    return; // 사용자가 취소
  }
  screenTrack = stream.getVideoTracks()[0];
  screenTrack.contentHint = 'detail'; // 글씨 선명도 우선
  screenTrack.onended = stopScreenShare; // 브라우저의 [공유 중지] 버튼
  await sender.replaceTrack(screenTrack);
  await setSenderBitrate(sender, SCREEN_MAX_BITRATE);
  localVideo.srcObject = new MediaStream([screenTrack]);
  screenShareBtn.querySelector('.btn-label').textContent = '공유 중지';
  screenShareBtn.classList.add('active');
  socket && socket.emit('screen-share-state', true);
  showSystemMsg('화면 공유를 시작했습니다.');
}

async function stopScreenShare() {
  if (!screenTrack) return;
  const track = screenTrack;
  screenTrack = null;
  track.stop();
  const sender = videoSender();
  const camTrack = localStream && localStream.getVideoTracks()[0];
  if (sender && camTrack) {
    await sender.replaceTrack(camTrack);
    await setSenderBitrate(sender, VIDEO_MAX_BITRATE);
  }
  localVideo.srcObject = localStream;
  screenShareBtn.querySelector('.btn-label').textContent = '화면 공유';
  screenShareBtn.classList.remove('active');
  socket && socket.emit('screen-share-state', false);
  showSystemMsg('화면 공유를 끝냈습니다.');
}

screenShareBtn.addEventListener('click', () => (screenTrack ? stopScreenShare() : startScreenShare()));

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
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); return; }
  if (e.key === 'ArrowLeft') pdfPrev.click();
  if (e.key === 'ArrowRight') pdfNext.click();
  if (e.key === 'p' || e.key === 'P') toolPen.click();
  if (e.key === 'e' || e.key === 'E') toolEraser.click();
});

/* ════════════════════════════════════════════
   지난 수업 다시 보기 (보기 전용) + PDF로 저장
════════════════════════════════════════════ */
const exportPdfBtn = document.getElementById('export-pdf-btn');

async function initReview() {
  const headers = { Authorization: `Bearer ${liveToken}` };
  try {
    const res = await fetch('/review/state', { headers });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const state = await res.json();

    document.body.classList.add('review-mode');
    lobby.classList.add('hidden');
    roomEl.classList.remove('hidden');
    roomTitle.textContent = '지난 수업 다시 보기';
    initCanvasSize();
    strokes = state.strokes;

    if (state.pdf) {
      const pdfRes = await fetch('/review/pdf', { headers });
      if (!pdfRes.ok) throw new Error(`PDF status ${pdfRes.status}`);
      await loadPdfData(new Uint8Array(await pdfRes.arrayBuffer()), 'review');
      await renderPdfPage(1);
    } else {
      redrawBoard();
    }
  } catch (err) {
    console.error('다시 보기 실패:', err);
    lobbyInfo.textContent = '';
    lobbyError.textContent = '보관 기간이 지났거나 볼 수 없는 수업입니다. 봄노트에서 다시 열어주세요.';
  }
}

let jsPdfLoading = null;
function loadJsPdf() {
  if (!jsPdfLoading) {
    jsPdfLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
      script.onload = () => resolve(window.jspdf.jsPDF);
      script.onerror = () => { jsPdfLoading = null; reject(new Error('jsPDF 로드 실패')); };
      document.head.appendChild(script);
    });
  }
  return jsPdfLoading;
}

// 배경(PDF 페이지 또는 흰 바탕) 위에 해당 페이지 필기를 합친 이미지
function composePage(background, W, H, page) {
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  if (background) ctx.drawImage(background, 0, 0);
  // 지우개(destination-out)가 배경까지 지우지 않도록 필기는 별도 레이어에 그림
  const layer = document.createElement('canvas');
  layer.width = W; layer.height = H;
  const lctx = layer.getContext('2d');
  strokes.forEach(s => { if (s.page === page) drawStroke(lctx, s, W, H); });
  ctx.drawImage(layer, 0, 0);
  return out;
}

async function exportPdf() {
  exportPdfBtn.disabled = true;
  exportPdfBtn.textContent = '만드는 중...';
  try {
    const JsPDF = await loadJsPdf();
    let doc = null;
    const addPage = (canvas) => {
      const w = canvas.width, h = canvas.height;
      const orientation = w > h ? 'l' : 'p';
      if (!doc) doc = new JsPDF({ orientation, unit: 'pt', format: [w, h] });
      else doc.addPage([w, h], orientation);
      doc.addImage(canvas.toDataURL('image/jpeg', 0.85), 'JPEG', 0, 0, w, h);
    };

    // PDF 없이 빈 보드에 쓴 필기가 있으면 첫 장
    if (strokes.some(s => s.page === 0)) addPage(composePage(null, 1600, 900, 0));
    if (pdfDoc) {
      for (let i = 1; i <= pdfTotalPages; i++) {
        const page = await pdfDoc.getPage(i);
        const viewport = page.getViewport({ scale: 1.5 });
        const bg = document.createElement('canvas');
        bg.width = Math.floor(viewport.width); bg.height = Math.floor(viewport.height);
        await page.render({ canvasContext: bg.getContext('2d'), viewport }).promise;
        addPage(composePage(bg, bg.width, bg.height, i));
      }
    }

    if (!doc) { alert('저장할 필기가 없습니다.'); return; }
    doc.save(`수업필기_${new Date().toLocaleDateString('sv-SE')}.pdf`);
  } catch (err) {
    console.error('PDF 저장 실패:', err);
    alert('PDF를 만들지 못했습니다. 다시 시도해주세요.');
  } finally {
    exportPdfBtn.disabled = false;
    exportPdfBtn.innerHTML = `${ic('file')} PDF로 저장`;
  }
}

exportPdfBtn.addEventListener('click', exportPdf);

if (reviewMode) initReview();
