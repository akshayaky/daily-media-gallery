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
  const close = () => {
    ov.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  ov.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
}

const BATCH_SIZE = 12;

interface LazyLoadableElement extends HTMLElement {
  _dmLoadMedia?: () => void;
}

export class GalleryRenderer extends MarkdownRenderChild {
  private shown: number;
  private lastItemsSig = "";
  private observer: IntersectionObserver | null = null;

  private headEl: HTMLElement | null = null;
  private countSpan: HTMLElement | null = null;
  private statusSpan: HTMLElement | null = null;
  private gridEl: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private moreBtn: HTMLElement | null = null;

  private currentItems: MediaEntry[] = [];
  private renderedCount = 0;
  private renderGen = 0;
  private pendingFrame: number | null = null;

  constructor(el: HTMLElement, private plugin: DailyMediaPlugin, private dateKey: string, private opts: BlockOptions) {
    super(el);
    this.shown = opts.limit ?? plugin.settings.maxItems;
  }

  onload(): void {
    this.containerEl.addClass("dm-gallery");

    if (typeof IntersectionObserver !== "undefined") {
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              const target = entry.target as LazyLoadableElement;
              const loadFn = target._dmLoadMedia;
              if (loadFn) {
                delete target._dmLoadMedia;
                this.observer?.unobserve(target);
                loadFn();
              }
            }
          }
        },
        { rootMargin: "300px 0px" }
      );
    }

    this.registerEvent(this.plugin.index.on("updated", () => this.render()));
    this.render();
  }

  onunload(): void {
    if (this.pendingFrame !== null) {
      window.cancelAnimationFrame(this.pendingFrame);
      this.pendingFrame = null;
    }
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  private render(): void {
    const el = this.containerEl;
    const idx = this.plugin.index;
    const items = idx
      .getForDate(this.dateKey)
      .filter((e) => this.opts.type === "all" || (this.opts.type === "photos") === (e.kind === "image"));

    this.currentItems = items;
    const s = this.plugin.settings;
    const photos = items.filter((i) => i.kind === "image").length;
    const videos = items.length - photos;

    if (!this.headEl) {
      this.headEl = el.createDiv({ cls: "dm-head" });
      this.countSpan = this.headEl.createSpan({ cls: "dm-count" });
      this.statusSpan = this.headEl.createSpan({ cls: "dm-status" });
      const refresh = this.headEl.createEl("button", {
        cls: "dm-refresh clickable-icon",
        attr: { "aria-label": "Rescan media folders" },
      });
      setIcon(refresh, "refresh-cw");
      refresh.addEventListener("click", () => void idx.scan());
    }

    if (this.countSpan) {
      this.countSpan.textContent = `${photos} photo${photos === 1 ? "" : "s"} · ${videos} video${videos === 1 ? "" : "s"}`;
    }
    if (this.statusSpan) {
      this.statusSpan.textContent = idx.scanning ? "indexing…" : "";
      this.statusSpan.style.display = idx.scanning ? "" : "none";
    }

    if (!items.length) {
      if (this.gridEl) {
        this.gridEl.remove();
        this.gridEl = null;
      }
      if (this.moreBtn) {
        this.moreBtn.remove();
        this.moreBtn = null;
      }
      if (!this.emptyEl) {
        this.emptyEl = el.createDiv({ cls: "dm-empty" });
      }
      let msg = `No photos or videos found for ${this.dateKey}.`;
      if (!s.folders.length) msg = "No media folder selected yet. Add one in Settings → Daily Media Gallery.";
      else if (idx.scanning && !idx.ready) msg = "Looking for media…";
      this.emptyEl.textContent = msg;
      this.lastItemsSig = "";
      this.renderedCount = 0;
      return;
    }

    if (this.emptyEl) {
      this.emptyEl.remove();
      this.emptyEl = null;
    }

    const itemsSig = `${this.opts.size ?? s.thumbSize}|${items.map((i) => i.path).join("\0")}`;
    const itemsChanged = itemsSig !== this.lastItemsSig;

    if (itemsChanged) {
      this.lastItemsSig = itemsSig;
      this.renderGen++;
      this.renderedCount = 0;
      if (this.gridEl) {
        this.gridEl.empty();
      } else {
        this.gridEl = el.createDiv({ cls: "dm-grid" });
      }
      this.gridEl.setCssProps({ "--dm-size": `${this.opts.size ?? s.thumbSize}px` });
    }

    if (!this.gridEl) {
      this.gridEl = el.createDiv({ cls: "dm-grid" });
      this.gridEl.setCssProps({ "--dm-size": `${this.opts.size ?? s.thumbSize}px` });
    }

    this.scheduleBatchRender();
    this.updateMoreButton();
  }

  private scheduleBatchRender(): void {
    const targetCount = Math.min(this.shown, this.currentItems.length);
    if (this.renderedCount >= targetCount || !this.gridEl) return;

    if (this.pendingFrame !== null) {
      window.cancelAnimationFrame(this.pendingFrame);
      this.pendingFrame = null;
    }

    const currentGen = this.renderGen;

    const renderNextBatch = () => {
      this.pendingFrame = null;
      if (currentGen !== this.renderGen || !this.gridEl) return;

      const end = Math.min(this.renderedCount + BATCH_SIZE, targetCount);
      for (let i = this.renderedCount; i < end; i++) {
        this.renderItem(this.gridEl, this.currentItems[i]);
      }
      this.renderedCount = end;

      if (this.renderedCount < targetCount) {
        this.pendingFrame = window.requestAnimationFrame(renderNextBatch);
      }
    };

    renderNextBatch();
  }

  private updateMoreButton(): void {
    const el = this.containerEl;
    const s = this.plugin.settings;
    const total = this.currentItems.length;

    if (total > this.shown) {
      const remaining = total - this.shown;
      const nextBatch = Math.min(s.maxItems, remaining);
      const text = `Show ${nextBatch} more (${remaining} hidden)`;

      if (!this.moreBtn) {
        this.moreBtn = el.createEl("button", { cls: "dm-more" });
        this.moreBtn.addEventListener("click", () => {
          this.shown += s.maxItems;
          this.scheduleBatchRender();
          this.updateMoreButton();
        });
      }
      this.moreBtn.textContent = text;
      el.appendChild(this.moreBtn);
    } else if (this.moreBtn) {
      this.moreBtn.remove();
      this.moreBtn = null;
    }
  }

  private renderItem(grid: HTMLElement, e: MediaEntry): void {
    const s = this.plugin.settings;
    const item = grid.createDiv({ cls: `dm-item dm-${e.kind}` });
    const media = item.createDiv({ cls: "dm-media" }) as LazyLoadableElement;
    const url = resourceUrl(this.plugin.app, e.path);

    if (!canPreview(e.name)) {
      this.placeholder(media, e, "No inline preview for this format");
    } else {
      const loadMedia = () => {
        if (e.kind === "image") {
          const img = media.createEl("img", { attr: { decoding: "async", alt: e.name } });
          this.withFallback(img, url, fileUrl(e.path), media, e);
          img.addEventListener("click", () => openLightbox(img.currentSrc || img.src, e.name));
        } else {
          const v = media.createEl("video", {
            attr: { controls: "", preload: "metadata", playsinline: "" },
          });
          this.withFallback(v, url + "#t=0.1", fileUrl(e.path) + "#t=0.1", media, e);
        }
      };

      if (this.observer) {
        media._dmLoadMedia = loadMedia;
        this.observer.observe(media);
      } else {
        loadMedia();
      }
    }

    const showTime = this.opts.time ?? s.showTime;
    const showNames = this.opts.names !== undefined ? this.opts.names : (s.showNames || showTime);
    if (showTime || showNames) {
      const cap = item.createDiv({ cls: "dm-caption" });
      if (showTime) {
        const t = cap.createSpan({ cls: "dm-time", text: e.wall.slice(11, 16) });
        t.setAttr("title", `Date source: ${SOURCE_LABEL[e.source]}`);
        if (e.source === "file-system") t.addClass("dm-weak");
      }
      if (showNames) {
        const nameSpan = cap.createSpan({ cls: "dm-name", text: e.name });
        nameSpan.setAttr("title", e.name);
      }
    }

    item.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.plugin.showMediaMenu(ev, e);
    });
  }

  private withFallback(
    el: HTMLImageElement | HTMLVideoElement,
    primary: string,
    secondary: string,
    media: HTMLElement,
    e: MediaEntry
  ): void {
    if (primary === secondary) {
      el.addEventListener("error", () => {
        el.remove();
        this.placeholder(media, e, "Can't preview here: click to open");
      });
      el.src = primary;
      return;
    }
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
