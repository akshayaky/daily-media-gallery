import { FileSystemAdapter, Menu, Notice, Plugin, TFile, moment } from "obsidian";
import * as path from "path";
import {
  appHasDailyNotesPluginLoaded,
  createDailyNote,
  getAllDailyNotes,
  getDailyNote,
  getDateFromFile,
} from "obsidian-daily-notes-interface";
import { GalleryRenderer, parseBlockOptions } from "./gallery";
import { MediaIndex } from "./mediaIndex";
import { DailyMediaSettingTab, DailyMediaSettings, DEFAULT_SETTINGS } from "./settings";
import { MediaEntry } from "./types";
import { getKind, openInDefaultApp, showInFolder } from "./util";

export default class DailyMediaPlugin extends Plugin {
  settings!: DailyMediaSettings;
  index!: MediaIndex;
  private rescanTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.index = new MediaIndex(this);
    await this.index.loadCache();
    this.addSettingTab(new DailyMediaSettingTab(this.app, this));

    /* ```daily-media``` block: renders the gallery for the note's date (or `date: YYYY-MM-DD`) */
    this.registerMarkdownCodeBlockProcessor("daily-media", (source, el, ctx) => {
      const opts = parseBlockOptions(source);
      let dateKey = opts.date;
      if (!dateKey) {
        const f = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
        const m = f instanceof TFile ? getDateFromFile(f, "day") : null;
        if (m) dateKey = m.format("YYYY-MM-DD");
      }
      if (!dateKey) {
        el.createDiv({ cls: "dm-empty", text: "daily-media: this isn't a daily note. Add a line like “date: 2024-05-01”." });
        return;
      }
      if (this.settings.rescanMinutes > 0) {
        void this.index.ensureFresh(this.settings.rescanMinutes * 60_000);
      }
      ctx.addChild(new GalleryRenderer(el, this, dateKey, opts));
    });

    /* Commands */
    this.addCommand({
      id: "insert-gallery",
      name: "Insert media gallery into this daily note",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || !getDateFromFile(f, "day")) return false;
        if (!checking) {
          void this.insertGallery(f, false).then((ok) => new Notice(ok ? "Gallery added." : "This note already has a gallery."));
        }
        return true;
      },
    });
    this.addCommand({
      id: "rescan",
      name: "Rescan media folders",
      callback: async () => {
        await this.index.scan();
        new Notice(`Indexed ${this.index.entries.size} media files.`);
      },
    });
    this.addCommand({
      id: "open-daily-note-for-active-media",
      name: "Open daily note for the active photo/video",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || !getKind(f.name)) return false;
        if (!checking) void this.openDailyNoteForVaultFile(f);
        return true;
      },
    });

    /* Right-click a photo/video in the file explorer (files inside the vault) */
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || !getKind(file.name)) return;
        menu.addItem((item) =>
          item
            .setTitle("Open daily note for this file's date")
            .setIcon("calendar-days")
            .onClick(() => void this.openDailyNoteForVaultFile(file))
        );
      })
    );

    /* obsidian://daily-media?file=<absolute path>  (lets Windows Explorer's right-click menu call us, see README) */
    this.registerObsidianProtocolHandler("daily-media", (params) => {
      if (params.file) void this.openDailyNoteForPath(params.file);
    });

    this.app.workspace.onLayoutReady(() => {
      if (!appHasDailyNotesPluginLoaded()) {
        new Notice("Daily Media Gallery: please enable the core “Daily notes” plugin.", 8000);
      }
      if (!this.settings.folders.length) {
        new Notice("Daily Media Gallery: choose a media folder in the plugin settings.", 6000);
      } else {
        void this.index.scan();
      }

      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (!this.settings.autoInsert || !(file instanceof TFile) || file.extension !== "md") return;
          window.setTimeout(() => void this.autoInsert(file), 1500); // let the template finish writing
        })
      );
      this.registerEvent(
        this.app.workspace.on("file-open", (file) => {
          if (this.settings.autoInsertOnOpen && file) void this.autoInsert(file);
        })
      );
      this.setupRescanTimer();
    });
  }

  onunload(): void {
    if (this.rescanTimer !== null) window.clearInterval(this.rescanTimer);
  }

  /* ----------------------------------------------------------------- settings */

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<DailyMediaSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    if (data?.showNames === undefined) {
      this.settings.showNames = true;
    }
    if (typeof this.settings.folders === "string") {
      const trimmed = (this.settings.folders as string).trim();
      this.settings.folders = trimmed ? [trimmed] : [];
    } else if (!Array.isArray(this.settings.folders)) {
      this.settings.folders = [];
    } else {
      this.settings.folders = this.settings.folders
        .map((f) => (typeof f === "string" ? f.trim() : ""))
        .filter((f) => f.length > 0);
    }
  }

  /** @param rescan true when folder list / recursion changed (re-walk the disk), false = just recompute dates */
  async saveSettings(rescan: boolean): Promise<void> {
    await this.saveData(this.settings);
    if (rescan) await this.index.scan();
    else this.index.rebuild();
  }

  setupRescanTimer(): void {
    if (this.rescanTimer !== null) window.clearInterval(this.rescanTimer);
    this.rescanTimer = null;
    if (this.settings.rescanMinutes > 0) {
      this.rescanTimer = window.setInterval(() => void this.index.scan(), this.settings.rescanMinutes * 60_000);
    }
  }

  /* -------------------------------------------------------------- daily notes */

  private async autoInsert(file: TFile): Promise<void> {
    if (file.extension !== "md" || !getDateFromFile(file, "day")) return;
    if (this.settings.rescanMinutes > 0) {
      await this.index.ensureFresh(this.settings.rescanMinutes * 60_000);
    }
    await this.insertGallery(file, true);
  }

  async insertGallery(file: TFile, onlyIfMedia: boolean): Promise<boolean> {
    const m = getDateFromFile(file, "day");
    if (!m) return false;
    if (onlyIfMedia) {
      await this.index.whenReady();
      if (!this.index.getForDate(m.format("YYYY-MM-DD")).length) return false;
    }
    let inserted = false;
    await this.app.vault.process(file, (data) => {
      if (/^```daily-media/m.test(data)) return data;
      inserted = true;
      const block = "```daily-media\n```";
      const h = this.settings.heading.trim();
      if (h) {
        const lines = data.split("\n");
        const i = lines.findIndex((l) => l.trim() === h);
        if (i >= 0) {
          lines.splice(i + 1, 0, "", block, "");
          return lines.join("\n");
        }
        return data.replace(/\s*$/, "") + `\n\n${h}\n\n${block}\n`;
      }
      return data.replace(/\s*$/, "") + `\n\n${block}\n`;
    });
    return inserted;
  }

  async openDailyNoteForDate(dateKey: string, newTab = false): Promise<void> {
    if (!appHasDailyNotesPluginLoaded()) {
      new Notice("Enable the core “Daily notes” plugin first.");
      return;
    }
    const date = (moment as unknown as (s: string, f: string) => NonNullable<ReturnType<typeof getDateFromFile>>)(
      dateKey,
      "YYYY-MM-DD"
    );
    let note: TFile | undefined = getDailyNote(date, getAllDailyNotes());
    if (!note) {
      if (!this.settings.createIfMissing) {
        new Notice(`No daily note exists for ${dateKey}.`);
        return;
      }
      note = await createDailyNote(date);
    }
    if (!note) return;
    await this.app.workspace.getLeaf(newTab ? "tab" : false).openFile(note);
  }

  async openDailyNoteForPath(absPath: string): Promise<void> {
    const e = await this.index.entryFor(path.normalize(absPath));
    if (!e) {
      new Notice("Couldn't read a date from that file.");
      return;
    }
    if (e.source === "file-system") {
      new Notice(`No capture date found inside the file; using its file-system date (${e.dateKey}).`, 6000);
    }
    await this.openDailyNoteForDate(e.dateKey);
  }

  async openDailyNoteForVaultFile(file: TFile): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    await this.openDailyNoteForPath(adapter.getFullPath(file.path));
  }

  /* ------------------------------------------------- right-click menu (gallery) */

  showMediaMenu(ev: MouseEvent, e: MediaEntry): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle(`Open daily note (${e.dateKey})`).setIcon("calendar-days").onClick(() => void this.openDailyNoteForDate(e.dateKey))
    );
    menu.addItem((i) =>
      i.setTitle("Open daily note in new tab").setIcon("file-plus").onClick(() => void this.openDailyNoteForDate(e.dateKey, true))
    );
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Open in default app").setIcon("external-link").onClick(() => openInDefaultApp(e.path)));
    menu.addItem((i) => i.setTitle("Show in folder").setIcon("folder-open").onClick(() => showInFolder(e.path)));
    menu.addItem((i) =>
      i.setTitle("Copy file path").setIcon("copy").onClick(() => {
        void navigator.clipboard.writeText(e.path);
        new Notice("Path copied.");
      })
    );
    menu.showAtMouseEvent(ev);
  }
}
