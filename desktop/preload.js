const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electron", {
    quit: () => ipcRenderer.send("quit"),
    addFullscreenChangeListener: listener => ipcRenderer.on("fullscreen-change", () => listener()),
    isFullscreen: () => ipcRenderer.sendSync("is-fullscreen"),
    setFullscreen: on => ipcRenderer.send("set-fullscreen", on),
    getArgv: () => [],
    log: () => {},
    captureHidden: () => ipcRenderer.sendSync("capture-hidden"),
    setCaptureHidden: on => ipcRenderer.send("set-capture-hidden", on)
});
