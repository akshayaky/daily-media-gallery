import { App, Platform } from "obsidian";
import { MediaKind } from "./types";

export const IMAGE_EXT = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif", "bmp", "tif", "tiff", "dng",
]);
export const VIDEO_EXT = new Set([
  "mp4", "m4v", "mov", "3gp", "3g2", "mkv", "webm", "avi", "wmv", "mts", "m2ts",
]);
/** Containers whose creation date we can read directly (ISO base media / QuickTime). */
export const ISOBMFF_EXT = new Set(["mp4", "m4v", "mov", "3gp", "3g2"]);
/** Formats Obsidian's Chromium can usually show inline. Others get an "open externally" tile. */
const PREVIEW_IMAGE = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp"]);
const PREVIEW_VIDEO = new Set(["mp4", "m4v", "mov", "webm", "mkv", "3gp", "ogv"]);

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function getKind(name: string): MediaKind | null {
  const e = extOf(name);
  if (IMAGE_EXT.has(e)) return "image";
  if (VIDEO_EXT.has(e)) return "video";
  return null;
}

export function canPreview(name: string): boolean {
  const e = extOf(name);
  return PREVIEW_IMAGE.has(e) || PREVIEW_VIDEO.has(e);
}

export const pad = (n: number): string => String(n).padStart(2, "0");

export function wallFromParts(y: number, mo: number, d: number, h: number, mi: number, s: number): string {
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`;
}

/** Wall-clock string for a UTC instant, in the given IANA timezone (blank = this computer's zone). */
export function wallFromUtcMs(ms: number, tz?: string): string {
  const d = new Date(ms);
  if (tz && tz.trim()) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz.trim(),
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).formatToParts(d);
      const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
      return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}`;
    } catch {
      /* invalid timezone name: fall through to the system zone */
    }
  }
  return wallFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
}

/** "2024-05-01T21:14:03" -> "2024-05-01", shifted back by `dayStartHour` hours. */
export function dateKeyFromWall(wall: string, dayStartHour: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(wall);
  if (!m) return wall.slice(0, 10);
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - dayStartHour * 3_600_000;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Dates embedded in names like IMG_20240501_211403.jpg, PXL_20240501_..., IMG-20240501-WA0001.jpg */
export function wallFromFilename(name: string): string | null {
  const m = /(?<![0-9])((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[-_. T]?([01]\d|2[0-3])[-_.]?([0-5]\d)[-_.]?([0-5]\d))?/.exec(
    name
  );
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (m[4] === undefined) return wallFromParts(y, mo, d, 12, 0, 0); // no time: use noon so day-shift can't flip the date
  return wallFromParts(y, mo, d, +m[4], +m[5], +m[6]);
}

let cachedPrefix: string | null = null;
function resourcePrefix(app: App): string {
  if (cachedPrefix !== null) return cachedPrefix;
  const fromPlatform = (Platform as unknown as { resourcePathPrefix?: string }).resourcePathPrefix;
  if (fromPlatform) return (cachedPrefix = fromPlatform);
  try {
    const m = /^(app:\/\/[^/]+\/)/.exec(app.vault.adapter.getResourcePath("."));
    if (m) return (cachedPrefix = m[1]);
  } catch {
    /* ignore */
  }
  return (cachedPrefix = "");
}

function encodePath(p: string): string {
  return encodeURI(p.replace(/\\/g, "/").replace(/^\/+/, "")).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

/** URL Obsidian can load for an absolute disk path (nothing is copied into the vault). */
export function resourceUrl(app: App, absPath: string): string {
  const prefix = resourcePrefix(app);
  return prefix ? prefix + encodePath(absPath) : fileUrl(absPath);
}

export function fileUrl(absPath: string): string {
  return "file:///" + encodePath(absPath);
}

interface ElectronShell {
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}
interface ElectronWebUtils {
  getPathForFile(file: File): string;
}
interface ElectronDialog {
  showOpenDialog(opts: { properties: string[] }): Promise<{ canceled: boolean; filePaths: string[] }>;
}
interface ElectronRemote {
  dialog: ElectronDialog;
}
interface ElectronModule {
  shell?: ElectronShell;
  remote?: ElectronRemote;
  dialog?: ElectronDialog;
  webUtils?: ElectronWebUtils;
}

function electron(): ElectronModule | null {
  try {
    const win = window as Window & { require?: (m: string) => unknown };
    if (!win.require) return null;
    let remoteMod: ElectronRemote | undefined;
    try {
      remoteMod = win.require("@electron/remote") as ElectronRemote | undefined;
    } catch {
      /* ignore */
    }
    const elMod = (win.require("electron") as ElectronModule) ?? {};
    if (remoteMod?.dialog && !elMod.remote?.dialog) {
      elMod.remote = remoteMod;
    }
    return elMod;
  } catch {
    return null;
  }
}

export function openInDefaultApp(absPath: string): void {
  void electron()?.shell?.openPath(absPath);
}

export function showInFolder(absPath: string): void {
  electron()?.shell?.showItemInFolder(absPath);
}

export async function pickFolder(): Promise<string | null> {
  const el = electron();
  const dialog = el?.remote?.dialog ?? el?.dialog;
  if (dialog?.showOpenDialog) {
    const r = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return r.canceled || !r.filePaths?.length ? null : r.filePaths[0];
  }
  // Fallback: hidden <input webkitdirectory>
  return new Promise((resolve) => {
    const input = createEl("input", {
      type: "file",
      attr: { webkitdirectory: "true" },
    });
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.setCssStyles({ display: "none" });
    document.body.appendChild(input);

    let resolved = false;
    const cleanup = () => {
      input.detach();
    };

    input.onchange = () => {
      if (resolved) return;
      resolved = true;
      const f = input.files?.[0];
      if (!f) {
        cleanup();
        return resolve(null);
      }
      let p: string | undefined = (f as File & { path?: string }).path;
      if (!p) {
        try {
          p = el?.webUtils?.getPathForFile(f);
        } catch {
          /* ignore */
        }
      }
      cleanup();
      if (!p) return resolve(null);
      const rel: string = f.webkitRelativePath; // "Folder/sub/file.jpg"
      const norm = p.replace(/\\/g, "/");
      const root = rel.split("/")[0];
      const base = norm.slice(0, norm.length - rel.length);
      resolve((base + root).replace(/\//g, Platform.isWin ? "\\" : "/"));
    };

    input.oncancel = () => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(null);
      }
    };

    input.click();
  });
}
