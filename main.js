const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path   = require('path');
const fs     = require('fs');
const { spawn, execSync } = require('child_process');

let win;

function createWindow() {
    win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 960,
        minHeight: 640,
        backgroundColor: '#0e0e0e',
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        webPreferences: {
            nodeIntegration:    true,
            contextIsolation:   false,
        },
        title: 'BPM Grid',
    });

    win.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('open-file', async () => {
    const result = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac'] }],
    });
    return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('save-file', async (_, { content, defaultName, ext }) => {
    const result = await dialog.showSaveDialog(win, {
        defaultPath: defaultName,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (result.canceled) return null;
    fs.writeFileSync(result.filePath, content, 'utf8');
    return result.filePath;
});

ipcMain.handle('find-python', () => {
    for (const cmd of ['python3', 'python']) {
        try {
            execSync(`${cmd} --version`, { stdio: 'pipe' });
            return cmd;
        } catch {}
    }
    return null;
});

ipcMain.handle('transcribe', async (_, { audioPath, pythonCmd, modelSize }) => {
    return new Promise((resolve) => {
        const scriptPath = app.isPackaged
            ? path.join(process.resourcesPath, 'transcribe.py')
            : path.join(__dirname, 'transcribe.py');
        const proc = spawn(pythonCmd, [scriptPath, audioPath, modelSize || 'base']);
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => {
            stderr += d.toString();
            win.webContents.send('transcribe-progress', d.toString().trim());
        });
        proc.on('close', () => {
            try {
                resolve({ ok: true, data: JSON.parse(stdout) });
            } catch {
                resolve({ ok: false, error: stderr || 'Failed to parse output' });
            }
        });
        proc.on('error', (err) => resolve({ ok: false, error: err.message }));
    });
});
