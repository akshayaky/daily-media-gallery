import { MarkdownRenderChild, setIcon } from "obsidian";
import type DailyMediaPlugin from "./main";
import { MediaEntry } from "./types";
import { canPreview, fileUrl, openInDefaultApp, resourceUrl } from "./util";

export interface BlockOptions {
  date?: string;
  type: "all" | "photos" | "videos";
  size?: number;
  limit?: number;
  names?: boolean;
  time?: boolean;
}

export function parseBlockOptions(source: string): BlockOptions {
  const o: BlockOptions = { type: "all" };
  for (const line of source.split("\n")) {
    const m = /^\s*([a-z]+)\s*:\s*(.+?)\s*$/i.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2];
    if (k === "date") o.date = v;
    else if (k === "type" && ["all", "photos", "videos"].includes(v)) o.type = v as BlockOptions["type"];
    else if (k === "size") o.size = parseInt(v, 10) || undefined;
    else if (k === "limit") o.limit = parseInt(v, 10) || undefined;
    else if (k === "names") o.names = v === "true";
    else if (k === "time") o.time = v === "true";
  }
  return o;
}

const SOURCE_LABEL: Record<MediaEntry["source"], string> = {
  exif: "photo EXIF (taken)",
  quicktime: "video metadata (local recording time)",
  "mp4-utc": "video metadata (UTC creation time)",
  filename: "date in file name",
  "file-system": "file-system date (no embedded date found)",
};

function openLightbox(url: string, alt: string): void {
  const ov = document.body.createDiv({ cls: "dm-lightbox" });
  ov.createEl("img", { attr: { src: url, alt } });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  const close = () => {
    ov.remove();
    document.removeEventListener("keydown", onKey);
  };
  ov.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
}

export class GalleryRenderer extends MarkdownRenderChild {
  private shown: number;
  private lastSig = "";

  constructor(el: HTMLElement, private plugin: DailyMediaPlugin, private dateKey: string, private opts: BlockOptions) {
    super(el);
    this.shown = opts.limit ?? plugin.settings.maxItems;
  }

  onload(): void {
    this.containerEl.addClass("dm-gallery");
    this.registerEvent(this.plugin.index.on("updated", () => this.render()));
    this.render();
  }

  private render(): void {
    const el = this.containerEl;
    const idx = this.plugin.index;
    const items = idx
      .getForDate(this.dateKey)
      .filter((e) => this.opts.type === "all" || (this.opts.type === "photos") === (e.kind === "image"));

    // Don't tear down playing videos when nothing visible changed.
    const sig = `${idx.scanning}|${this.shown}|${items.map((i) => i.path).join("\0")}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    el.empty();
    const s = this.plugin.settings;
    const photos = items.filter((i) => i.kind === "image").length;
    const videos = items.length - photos;

    const head = el.createDiv({ cls: "dm-head" });
    head.createSpan({
      cls: "dm-count",
      text: `${photos} photo${photos === 1 ? "" : "s"} · ${videos} video${videos === 1 ? "" : "s"}`,
    });
    if (idx.scanning) head.createSpan({ cls: "dm-status", text: "indexing…" });
    const refresh = head.createEl("button", { cls: "dm-refresh clickable-icon", attr: { "aria-label": "Rescan media folders" } });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => void idx.scan());

    if (!items.length) {
      let msg = `No photos or videos found for ${this.dateKey}.`;
      if (!s.folders.length) msg = "No media folder selected yet. Add one in Settings → Daily Media Gallery.";
      else if (idx.scanning && !idx.ready) msg = "Looking for media…";
      el.createDiv({ cls: "dm-empty", text: msg });
      return;
    }

    const grid = el.createDiv({ cls: "dm-grid" });
    grid.setCssProps({ "--dm-size": `${this.opts.size ?? s.thumbSize}px` });
    for (const e of items.slice(0, this.shown)) this.renderItem(grid, e);

    if (items.length > this.shown) {
      const more = el.createEl("button", { cls: "dm-more", text: `Show ${Math.min(s.maxItems, items.length - this.shown)} more (${items.length - this.shown} hidden)` });
      more.addEventListener("click", () => {
        this.shown += s.maxItems;
        this.render();
      });
    }
  }

  private renderItem(grid: HTMLElement, e: MediaEntry): void {
    const s = this.plugin.settings;
    const item = grid.createDiv({ cls: `dm-item dm-${e.kind}` });
    const media = item.createDiv({ cls: "dm-media" });
    const url = resourceUrl(this.plugin.app, e.path);

    if (!canPreview(e.name)) {
      this.placeholder(media, e, "No inline preview for this format");
    } else if (e.kind === "image") {
      const img = media.createEl("img", { attr: { loading: "lazy", decoding: "async", alt: e.name } });
      this.withFallback(img, url, fileUrl(e.path), media, e);
      img.addEventListener("click", () => openLightbox(img.currentSrc || img.src, e.name));
    } else {
      const v = media.createEl("video", { attr: { controls: "", preload: "metadata", playsinline: "" } });
      this.withFallback(v, url + "#t=0.1", fileUrl(e.path) + "#t=0.1", media, e);
    }

    const showTime = this.opts.time ?? s.showTime;
    const showNames = this.opts.names ?? s.showNames;
    if (showTime || showNames) {
      const cap = item.createDiv({ cls: "dm-caption" });
      if (showTime) {
        const t = cap.createSpan({ cls: "dm-time", text: e.wall.slice(11, 16) });
        t.setAttr("title", `Date source: ${SOURCE_LABEL[e.source]}`);
        if (e.source === "file-system") t.addClass("dm-weak");
      }
      if (showNames) cap.createSpan({ cls: "dm-name", text: e.name });
    }

    item.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.plugin.showMediaMenu(ev, e);
    });
  }

  private withFallback(el: HTMLImageElement | HTMLVideoElement, primary: string, secondary: string, media: HTMLElement, e: MediaEntry): void {
    let tried = false;
    el.addEventListener("error", () => {
      if (!tried) {
        tried = true;
        el.src = secondary;
        return;
      }
      el.remove();
      this.placeholder(media, e, "Can't preview here: click to open");
    });
    el.src = primary;
  }

  private placeholder(media: HTMLElement, e: MediaEntry, text: string): void {
    const ph = media.createDiv({ cls: "dm-placeholder" });
    const icon = ph.createDiv({ cls: "dm-ph-icon" });
    setIcon(icon, e.kind === "image" ? "image" : "film");
    ph.createDiv({ cls: "dm-ph-text", text });
    ph.createDiv({ cls: "dm-ph-name", text: e.name });
    ph.addEventListener("click", () => openInDefaultApp(e.path));
  }
}
