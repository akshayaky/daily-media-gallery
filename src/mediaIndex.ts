import { Events, normalizePath } from "obsidian";
import { promises as fsp } from "fs";
import * as path from "path";
import type DailyMediaPlugin from "./main";
import { readPhotoMeta, readVideoMeta } from "./metadata";
import { CacheEntry, DateSource, MediaEntry, RawMeta } from "./types";
import type { DailyMediaSettings } from "./settings";
import { dateKeyFromWall, getKind, ISOBMFF_EXT, extOf, wallFromFilename, wallFromUtcMs } from "./util";

const SKIP_DIRS = new Set(["$RECYCLE.BIN", "System Volume Information", "@eaDir", "node_modules"]);

async function walk(dir: string, recursive: boolean, out: string[]): Promise<boolean> {
  let items;
  try {
    items = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  const subdirs: string[] = [];
  for (const it of items) {
    if (it.name.startsWith(".") || SKIP_DIRS.has(it.name)) continue;
    const full = path.join(dir, it.name);
    if (it.isDirectory()) {
      if (recursive) subdirs.push(full);
    } else if (it.isFile() && getKind(it.name)) {
      out.push(full);
    }
  }
  if (subdirs.length > 0) {
    await Promise.all(subdirs.map((sub) => walk(sub, true, out)));
  }
  return true;
}

async function runPool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length || 1) }, async () => {
      while (i < items.length) {
        const item = items[i++];
        try {
          await fn(item);
        } catch {
          /* skip unreadable file */
        }
      }
    })
  );
}

function resolveCapture(
  name: string,
  c: CacheEntry,
  s: DailyMediaSettings
): { wall: string; source: DateSource } | null {
  // 1. date stored inside the file
  if (c.meta.wall) return { wall: c.meta.wall, source: c.meta.wallSource === "quicktime" ? "quicktime" : "exif" };
  if (c.meta.utcMs != null) return { wall: wallFromUtcMs(c.meta.utcMs, s.videoTimezone), source: "mp4-utc" };
  // 2. date in the file name
  if (s.useFilenameFallback) {
    const w = wallFromFilename(name);
    if (w) return { wall: w, source: "filename" };
  }
  // 3. file system
  const times = [c.m, c.b].filter((t) => t > 0);
  let ms: number | undefined;
  switch (s.fsFallback) {
    case "skip":
      return null;
    case "modified":
      ms = c.m;
      break;
    case "created":
      ms = c.b;
      break;
    default:
      ms = times.length ? Math.min(...times) : undefined;
  }
  if (!ms) return null;
  return { wall: wallFromUtcMs(ms), source: "file-system" };
}

export class MediaIndex extends Events {
  entries = new Map<string, MediaEntry>();
  byDate = new Map<string, MediaEntry[]>();
  scanning = false;
  ready = false;
  lastScan = 0;

  private files: string[] = [];
  private cache: Record<string, CacheEntry> = {};
  private scanPromise?: Promise<void>;

  constructor(private plugin: DailyMediaPlugin) {
    super();
  }

  private get cachePath(): string {
    const dir = this.plugin.manifest.dir ?? `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
    return normalizePath(`${dir}/media-cache.json`);
  }

  async loadCache(): Promise<void> {
    try {
      const a = this.plugin.app.vault.adapter;
      if (await a.exists(this.cachePath)) this.cache = JSON.parse(await a.read(this.cachePath)) as Record<string, CacheEntry>;
    } catch {
      this.cache = {};
    }
  }

  private async saveCache(): Promise<void> {
    try {
      await this.plugin.app.vault.adapter.write(this.cachePath, JSON.stringify(this.cache));
    } catch {
      /* non-fatal */
    }
  }

  async clearCache(): Promise<void> {
    this.cache = {};
    await this.saveCache();
  }

  scan(): Promise<void> {
    if (!this.scanPromise) {
      this.scanPromise = this.doScan().finally(() => {
        this.scanPromise = undefined;
      });
    }
    return this.scanPromise;
  }

  async ensureFresh(maxAgeMs: number): Promise<void> {
    if (this.scanPromise) return this.scanPromise;
    if (!this.ready || Date.now() - this.lastScan > maxAgeMs) return this.scan();
  }

  async whenReady(): Promise<void> {
    if (this.ready) return;
    await this.scan();
  }

  getForDate(dateKey: string): MediaEntry[] {
    return this.byDate.get(dateKey) ?? [];
  }

  private async doScan(): Promise<void> {
    const s = this.plugin.settings;
    this.scanning = true;
    this.trigger("updated");
    try {
      const found = new Set<string>();
      const okRoots: string[] = [];
      const folders = Array.isArray(s.folders)
        ? s.folders
        : typeof s.folders === "string" && (s.folders as string).trim()
        ? [(s.folders as string).trim()]
        : [];
      for (const root of folders) {
        const r = path.normalize(root);
        const list: string[] = [];
        if (await walk(r, s.recursive, list)) okRoots.push(r);
        list.forEach((f) => found.add(f));
      }
      const files = [...found];
      await runPool(files, 8, (f) => this.ensureCache(f));
      // forget files that disappeared from folders we could actually read
      const isSubPath = (file: string, root: string): boolean => {
        const rel = path.relative(root, file);
        return !rel.startsWith("..") && !path.isAbsolute(rel);
      };
      for (const k of Object.keys(this.cache)) {
        if (!found.has(k) && okRoots.some((r) => isSubPath(k, r))) delete this.cache[k];
      }
      this.files = files.filter((f) => this.cache[f]);
      this.lastScan = Date.now();
      this.ready = true;
      await this.saveCache();
    } finally {
      this.scanning = false;
      this.rebuild();
    }
  }

  private async ensureCache(p: string): Promise<void> {
    const st = await fsp.stat(p);
    const c = this.cache[p];
    if (c && c.s === st.size && c.m === st.mtimeMs) {
      c.b = st.birthtimeMs;
      return;
    }
    const kind = getKind(p);
    let meta: RawMeta = {};
    if (kind === "image") meta = await readPhotoMeta(p);
    else if (kind === "video" && ISOBMFF_EXT.has(extOf(p))) meta = await readVideoMeta(p);
    this.cache[p] = { s: st.size, m: st.mtimeMs, b: st.birthtimeMs, meta };
  }

  /** Re-derive dates from cached metadata (cheap): used after settings change. */
  rebuild(): void {
    this.entries.clear();
    this.byDate.clear();
    for (const p of this.files) {
      const c = this.cache[p];
      const e = c ? this.makeEntry(p, c, false) : null;
      if (!e) continue;
      this.entries.set(p, e);
      const list = this.byDate.get(e.dateKey);
      if (list) list.push(e);
      else this.byDate.set(e.dateKey, [e]);
    }
    for (const list of this.byDate.values()) {
      list.sort((a, b) => (a.wall < b.wall ? -1 : a.wall > b.wall ? 1 : a.name.localeCompare(b.name)));
    }
    this.trigger("updated");
  }

  private makeEntry(p: string, c: CacheEntry, force: boolean): MediaEntry | null {
    const s = this.plugin.settings;
    const name = path.basename(p);
    const kind = getKind(name);
    if (!kind) return null;
    if (!force && ((kind === "image" && !s.includePhotos) || (kind === "video" && !s.includeVideos))) return null;
    const r = resolveCapture(name, c, s);
    if (!r) return null;
    return { path: p, name, kind, size: c.s, wall: r.wall, dateKey: dateKeyFromWall(r.wall, s.dayStartHour), source: r.source };
  }

  /** Entry for any file on disk, even outside the configured folders (used by the context menu). */
  async entryFor(absPath: string): Promise<MediaEntry | null> {
    const p = path.normalize(absPath);
    const hit = this.entries.get(p);
    if (hit) return hit;
    try {
      await this.ensureCache(p);
    } catch {
      return null;
    }
    const c = this.cache[p];
    return c ? this.makeEntry(p, c, true) : null;
  }
}
