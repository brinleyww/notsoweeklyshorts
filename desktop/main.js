const { app, BrowserWindow, Menu, ipcMain, session, shell } = require("electron");
const fs = require("fs");
const path = require("path");

const SITE = "https://brinleyww.github.io/notsoweeklyshorts/";
const PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen", "pointerLock"]);
const RETRY_MS = 5000;

let win = null;
let retry = 0;

const isSite = url => url.startsWith(SITE);
const fromSite = e => isSite(e.senderFrame?.url ?? "");
const openOutside = url => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
};

const prefsFile = () => path.join(app.getPath("userData"), "desktop.json");
function captureHidden() {
    try {
        return JSON.parse(fs.readFileSync(prefsFile(), "utf8")).hideFromCapture !== false;
    } catch (e) {
        return true;
    }
}

function createWindow() {
    win = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 320,
        minHeight: 200,
        useContentSize: true,
        show: false,
        backgroundColor: "#28346a",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            devTools: false
        }
    });
    // Set before the first paint, so the window never appears in a capture.
    win.setContentProtection(captureHidden());
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => {
        clearTimeout(retry);
        win = null;
    });
    win.on("enter-full-screen", () => win.webContents.send("fullscreen-change", true));
    win.on("leave-full-screen", () => win.webContents.send("fullscreen-change", false));
    win.on("restore", () => win.webContents.setAudioMuted(false));

    const contents = win.webContents;
    contents.setWindowOpenHandler(({ url }) => {
        openOutside(url);
        return { action: "deny" };
    });
    // Only ATO's "Leave the game" navigates the page off the site; links open new windows.
    contents.on("will-navigate", (e, url) => {
        if (isSite(url)) return;
        e.preventDefault();
        openOutside(url);
        contents.setAudioMuted(true);
        win.minimize();
    });
    contents.on("will-prevent-unload", e => e.preventDefault());
    // With no application menu Chromium's own reload and fullscreen keys are gone.
    contents.on("before-input-event", (e, input) => {
        if (input.type !== "keyDown" || input.isAutoRepeat) return;
        if (input.code === "F11" || (input.alt && input.code === "Enter")) {
            win.setFullScreen(!win.isFullScreen());
            e.preventDefault();
        } else if (input.code === "F5" || (input.control && input.code === "KeyR")) {
            contents.reload();
            e.preventDefault();
        }
    });
    contents.on("did-fail-load", (e, code, description, url, isMainFrame) => {
        // -3 is an aborted load, as when a newer navigation replaces it.
        if (!isMainFrame || code === -3 || !isSite(url)) return;
        win.loadFile(path.join(__dirname, "offline.html"));
        clearTimeout(retry);
        retry = setTimeout(() => win?.loadURL(SITE), RETRY_MS);
    });
    win.loadURL(SITE);
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on("second-instance", () => {
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.focus();
    });
    app.on("window-all-closed", () => app.quit());

    ipcMain.on("quit", e => {
        if (fromSite(e)) app.quit();
    });
    ipcMain.on("is-fullscreen", e => {
        e.returnValue = !!win?.isFullScreen();
    });
    ipcMain.on("set-fullscreen", (e, on) => {
        if (fromSite(e)) win?.setFullScreen(!!on);
    });
    ipcMain.on("capture-hidden", e => {
        e.returnValue = captureHidden();
    });
    ipcMain.on("set-capture-hidden", (e, on) => {
        if (!fromSite(e)) return;
        fs.writeFileSync(prefsFile(), JSON.stringify({ hideFromCapture: !!on }));
        win?.setContentProtection(!!on);
    });

    app.whenReady().then(() => {
        Menu.setApplicationMenu(null);
        const ses = session.defaultSession;
        ses.setPermissionRequestHandler((contents, permission, done, details) => {
            done(PERMISSIONS.has(permission) || (permission === "display-capture" && details.isMainFrame && isSite(details.requestingUrl)));
        });
        // Save video records its own page; this captures the page itself, so capture hiding doesn't blank it.
        ses.setDisplayMediaRequestHandler((request, done) => done({ video: request.frame, audio: request.frame }));
        createWindow();
    });
}
