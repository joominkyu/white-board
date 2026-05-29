const { app, BrowserWindow, session } = require('electron');

const SERVER_URL = 'https://upbeat-dream-production-a20c.up.railway.app';

function setupPermissions() {
  const allowed = ['media', 'camera', 'microphone', 'audioCapture', 'videoCapture'];
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(allowed.includes(permission)));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => allowed.includes(permission));
}

function createMainWindow() {
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
  win.loadURL(SERVER_URL);
}

app.whenReady().then(createMainWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
