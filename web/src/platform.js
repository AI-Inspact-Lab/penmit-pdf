// Small differences between the web app, the desktop app (Electron) and the Android app (Capacitor).
import { bytesToBase64 } from "./sync.js";

export const isDesktop = typeof window.penmitDesktop === "object";
export const isAndroidApp = typeof window.Capacitor === "object" && /android/i.test(navigator.userAgent);
const isAppleTouch = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

let capacitorPlugins = null;
async function capacitor() {
  if (!capacitorPlugins) {
    // Copied into the Android build by CI (see .github/workflows/release.yml).
    const core = await import("../vendor/capacitor/core.js");
    capacitorPlugins = { Filesystem: core.registerPlugin("Filesystem"), Share: core.registerPlugin("Share") };
  }
  return capacitorPlugins;
}

export async function saveFile(name, bytes) {
  if (isDesktop) return window.penmitDesktop.saveFile(name, bytes);

  if (isAndroidApp) {
    const { Filesystem, Share } = await capacitor();
    const written = await Filesystem.writeFile({ path: name, data: await bytesToBase64(bytes), directory: "CACHE" });
    await Share.share({ title: name, files: [written.uri], dialogTitle: name });
    return true;
  }

  const file = new File([bytes], name, { type: "application/pdf" });
  // iPhone and iPad: the share sheet offers "Save to Files", AirDrop and other apps.
  if (isAppleTouch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return true;
    } catch (e) {
      if (e?.name === "AbortError") return false;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

// When a newer version takes over an open app, `onUpdate` runs so the app can reload at a good moment.
export function registerServiceWorker(onUpdate = () => {}) {
  if (isDesktop || isAndroidApp || !("serviceWorker" in navigator)) return;
  if (location.protocol !== "https:" && location.hostname !== "localhost") return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController) onUpdate(); });
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("service worker", e));
}
