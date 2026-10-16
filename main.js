const { app, BrowserWindow, session, shell, dialog } = require('electron');
const path = require('path');
// 빌드된 exe에서도 읽히도록 앱 폴더 기준 경로 사용 (.env는 빌드에 포함됨)
require('dotenv').config({ path: path.join(__dirname, '.env') });

const SERVER_URL = process.env.SERVER_URL;

function setupPermissions() {
  const allowed = ['media', 'camera', 'microphone', 'audioCapture', 'videoCapture'];
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(allowed.includes(permission)));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => allowed.includes(permission));
}

function createMainWindow() {
  if (!SERVER_URL) {
    dialog.showErrorBox('서버 주소 없음', '.env 파일에 SERVER_URL을 설정한 뒤 다시 빌드해주세요.');
    app.quit();
    return;
  }

  setupPermissions();

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: '화상 화이트보드',
    backgroundColor: '#0f1117',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  });
  win.setMenuBarVisibility(false);

  // 새 창(웹 공유 팝업, 새 탭 링크)은 앱 안에서 열지 않고 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadURL(SERVER_URL);
}

app.whenReady().then(createMainWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
