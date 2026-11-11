// The only bridge between the web app and the desktop: save dialog and "Open with" files.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("penmitDesktop", {
  saveFile: (name, bytes) => ipcRenderer.invoke("save-file", { name, bytes }),
  onOpenFiles: (callback) => {
    ipcRenderer.on("open-files", (_event, files) => callback(files));
  },
});
