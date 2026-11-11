// The only bridge between the web app and the desktop: save dialog, "Open with" files and
// Google sign-in and Drive requests (done by the main process; sign-in uses the system browser).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("penmitDesktop", {
  saveFile: (name, bytes) => ipcRenderer.invoke("save-file", { name, bytes }),
  onOpenFiles: (callback) => {
    ipcRenderer.on("open-files", (_event, files) => callback(files));
  },
  google: {
    available: () => ipcRenderer.invoke("google-available"),
    signIn: () => ipcRenderer.invoke("google-sign-in"),
    token: () => ipcRenderer.invoke("google-token"),
    invalidate: () => ipcRenderer.invoke("google-invalidate"),
    signOut: () => ipcRenderer.invoke("google-sign-out"),
    fetch: (url, init) => ipcRenderer.invoke("google-fetch", { url, ...init }),
  },
});
