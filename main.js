const { app, BrowserWindow, dialog } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const http = require('http')

let mainWindow = null
let serverProcess = null
const PORT = 8080

// ── Start the Python server ──
function startServer() {
  const serverPath = path.join(__dirname, 'server.py')
  
  // Try python3 first, fall back to python
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'
  
  serverProcess = spawn(pythonCmd, [serverPath], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  serverProcess.stdout.on('data', (data) => {
    console.log(`Server: ${data}`)
  })

  serverProcess.stderr.on('data', (data) => {
    console.error(`Server error: ${data}`)
  })

  serverProcess.on('close', (code) => {
    console.log(`Server exited with code ${code}`)
  })
}

// ── Wait for server to be ready ──
function waitForServer(retries = 20) {
  return new Promise((resolve, reject) => {
    const check = (remaining) => {
      if (remaining <= 0) {
        reject(new Error('Server did not start in time'))
        return
      }
      http.get(`http://127.0.0.1:${PORT}`, (res) => {
        resolve()
      }).on('error', () => {
        setTimeout(() => check(remaining - 1), 500)
      })
    }
    check(retries)
  })
}

// ── Create the main window ──
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'SwimTracker',
    backgroundColor: '#F7F9FC',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    },
    show: false  // Don't show until ready
  })

  mainWindow.loadURL(`http://127.0.0.1:${PORT}`)

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ── App lifecycle ──
app.whenReady().then(async () => {
  startServer()

  try {
    await waitForServer()
    createWindow()
  } catch (err) {
    dialog.showErrorBox(
      'SwimTracker — Startup Error',
      'Could not start the server. Make sure Python and all dependencies are installed.\n\n' + err.message
    )
    app.quit()
  }
})

app.on('window-all-closed', () => {
  // Kill the Python server when app closes
  if (serverProcess) {
    serverProcess.kill()
  }
  app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
})

// Kill server if app crashes
process.on('exit', () => {
  if (serverProcess) serverProcess.kill()
})
