const { app, BrowserWindow, session } = require('electron');
const net = require('net');

// 내장 서버 시작
require('./server');

function waitForServer(port, cb) {
  const client = new net.Socket();
  client.connect(port, '127.0.0.1', () => {
    client.destroy();
    cb();
  });
  client.on('error', () => {
    setTimeout(() => waitForServer(port, cb), 100);
  });
}

function createWindow() {
  // 카메라/마이크 권한 자동 허용
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'camera', 'microphone', 'audioCapture', 'videoCapture'];
    callback(allowed.includes(permission));
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    const allowed = ['media', 'camera', 'microphone', 'audioCapture', 'videoCapture'];
    return allowed.includes(permission);
  });

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

  waitForServer(3000, () => {
    win.loadURL('http://localhost:3000');
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
