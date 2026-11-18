import { App, Notice, PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";
import type DailyMediaPlugin from "./main";
import { pickFolder } from "./util";
import { appHasDailyNotesPluginLoaded } from "obsidian-daily-notes-interface";

export type FsFallback = "earliest" | "modified" | "created" | "skip";

export interface DailyMediaSettings {
  folders: string[];
  recursive: boolean;
  includePhotos: boolean;
  includeVideos: boolean;
  useFilenameFallback: boolean;
  fsFallback: FsFallback;
  videoTimezone: string;
  dayStartHour: number;
  autoInsert: boolean;
  autoInsertOnOpen: boolean;
  heading: string;
  createIfMissing: boolean;
  thumbSize: number;
  showTime: boolean;
  showNames: boolean;
  maxItems: number;
  rescanMinutes: number;
}

export const DEFAULT_SETTINGS: DailyMediaSettings = {
  folders: [],
  recursive: true,
  includePhotos: true,
  includeVideos: true,
  useFilenameFallback: true,
  fsFallback: "earliest",
  videoTimezone: "",
  dayStartHour: 0,
  autoInsert: true,
  autoInsertOnOpen: false,
  heading: "## Media",
  createIfMissing: true,
  thumbSize: 180,
  showTime: true,
  showNames: false,
  maxItems: 60,
  rescanMinutes: 0,
};

export class DailyMediaSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: DailyMediaPlugin) {
    super(app, plugin);
  }

  override getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    if (key === "videoTimezone" && typeof value === "string") {
      s[key] = value.trim();
    } else {
      s[key] = value;
    }
    const needsRescan = key === "recursive";
    await this.plugin.saveSettings(needsRescan);
    if (key === "rescanMinutes") {
      this.plugin.setupRescanTimer();
    }
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const p = this.plugin;
    const s = p.settings;
    const idx = p.index;

    if (typeof s.folders === "string") {
      const trimmed = (s.folders as string).trim();
      s.folders = trimmed ? [trimmed] : [];
    } else if (!Array.isArray(s.folders)) {
      s.folders = [];
    }

    const addFolder = async (path: string) => {
      const v = path.trim().replace(/^["']|["']$/g, "").trim();
      if (!v) return;
      if (!Array.isArray(s.folders)) s.folders = [];
      if (!s.folders.includes(v)) {
        s.folders.push(v);
        await p.saveSettings(true);
        new Notice(`Added folder: ${v}`);
      } else {
        new Notice(`Folder already added: ${v}`);
      }
      this.refresh();
    };

    const photos = [...idx.entries.values()].filter((e) => e.kind === "image").length;
    const videos = idx.entries.size - photos;

    const items: SettingDefinitionItem[] = [];

    if (!appHasDailyNotesPluginLoaded()) {
      items.push({
        name: "Daily notes plugin required",
        desc: "The core “Daily notes” plugin (or Periodic Notes) is not enabled. This plugin needs it.",
        render: (setting) => {
          setting.settingEl.addClass("mod-warning");
        },
      });
    }

    items.push(
      {
        type: "group",
        heading: "Media folders",
        items: [
          {
            name: "Storage locations",
            desc: "Folders on your computer. Files are referenced where they are; nothing is copied into the vault.",
            searchable: false,
          },
          ...s.folders.map((folder, i) => ({
            name: folder,
            render: (setting: Setting) => {
              setting.addExtraButton((b) =>
                b
                  .setIcon("trash")
                  .setTooltip("Remove")
                  .onClick(async () => {
                    s.folders.splice(i, 1);
                    await p.saveSettings(true);
                    this.refresh();
                  })
              );
            },
          })),
          {
            name: "Add a folder",
            desc: "Browse, or paste a full path such as D:\\Photos\\Phone",
            render: (setting: Setting) => {
              let typed = "";
              setting
                .addText((t) => {
                  t.setPlaceholder("D:\\Photos\\Phone").onChange((v) => (typed = v));
                  t.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void addFolder(typed);
                    }
                  });
                })
                .addButton((b) => b.setButtonText("Add").onClick(() => void addFolder(typed)))
                .addButton((b) =>
                  b.setButtonText("Browse…").onClick(async () => {
                    const picked = await pickFolder();
                    if (picked) await addFolder(picked);
                    else new Notice("Couldn't open the folder picker. Paste the path instead.");
                  })
                );
            },
          },
          {
            name: "Include sub-folders",
            control: {
              key: "recursive",
              type: "toggle",
            },
          },
          {
            name: "Include photos",
            control: {
              key: "includePhotos",
              type: "toggle",
            },
          },
          {
            name: "Include videos",
            control: {
              key: "includeVideos",
              type: "toggle",
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Date detection",
        items: [
          {
            name: "Date detection order",
            desc:
              "Order used: (1) date stored inside the file (photo EXIF, video creation date), " +
              "(2) date in the file name, (3) file-system date. Windows' “Date created/modified” are only used as a last resort.",
            searchable: false,
          },
          {
            name: "Use date in file name as fallback",
            desc: "Matches names like IMG_20240501_211403.jpg or PXL_20240501_….mp4",
            control: {
              key: "useFilenameFallback",
              type: "toggle",
            },
          },
          {
            name: "File-system fallback",
            desc: "When a file has no embedded date and no date in its name. “Earliest” is safest: copying a file resets “created”, but usually keeps “modified”.",
            control: {
              key: "fsFallback",
              type: "dropdown",
              options: {
                earliest: "Earliest of created / modified",
                modified: "Modified date",
                created: "Created date",
                skip: "Skip these files",
              },
            },
          },
          {
            name: "Timezone for UTC-only videos",
            desc:
              "Android and many cameras store video dates in UTC only. Enter an IANA timezone (e.g. Asia/Kolkata) to convert it " +
              "to the local day. Leave blank to use this computer's timezone. iPhone videos already carry their local time.",
            control: {
              key: "videoTimezone",
              type: "text",
              placeholder: "(this computer)",
            },
          },
          {
            name: "Day starts at (hour)",
            desc: "Set to e.g. 4 if clips filmed after midnight should belong to the previous day's note.",
            control: {
              key: "dayStartHour",
              type: "slider",
              min: 0,
              max: 12,
              step: 1,
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Daily notes",
        items: [
          {
            name: "Add gallery to new daily notes",
            desc: "When a daily note is created and has media for that day, a gallery block is inserted automatically.",
            control: {
              key: "autoInsert",
              type: "toggle",
            },
          },
          {
            name: "Also add when opening an existing daily note",
            desc: "Adds the block to older notes that have media but no gallery yet.",
            control: {
              key: "autoInsertOnOpen",
              type: "toggle",
            },
          },
          {
            name: "Heading to insert under",
            desc: "If this heading exists in the note the gallery goes beneath it, otherwise it is appended. Blank = no heading.",
            control: {
              key: "heading",
              type: "text",
            },
          },
          {
            name: "Create the daily note if missing",
            desc: "Used by “Open daily note for this photo/video”.",
            control: {
              key: "createIfMissing",
              type: "toggle",
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Display",
        items: [
          {
            name: "Thumbnail size (px)",
            control: {
              key: "thumbSize",
              type: "slider",
              min: 100,
              max: 400,
              step: 10,
            },
          },
          {
            name: "Show capture time",
            control: {
              key: "showTime",
              type: "toggle",
            },
          },
          {
            name: "Show file names",
            control: {
              key: "showNames",
              type: "toggle",
            },
          },
          {
            name: "Items shown before “Show more”",
            control: {
              key: "maxItems",
              type: "number",
              min: 1,
              step: 1,
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Index",
        items: [
          {
            name: `${photos} photos, ${videos} videos indexed`,
            desc: idx.lastScan ? `Last scan: ${new Date(idx.lastScan).toLocaleString()}` : "Not scanned yet",
            render: (setting: Setting) => {
              setting
                .addButton((b) =>
                  b.setButtonText("Rescan now").onClick(async () => {
                    await idx.scan();
                    this.refresh();
                  })
                )
                .addButton((b) =>
                  b.setButtonText("Clear cache").onClick(async () => {
                    await idx.clearCache();
                    await idx.scan();
                    this.refresh();
                  })
                );
            },
          },
          {
            name: "Auto-rescan every (minutes)",
            desc: "0 = only on startup, when a daily note is created, and via the command.",
            control: {
              key: "rescanMinutes",
              type: "number",
              min: 0,
              step: 1,
            },
          },
        ],
      }
    );

    return items;
  }

  private refresh(): void {
    if (typeof this.update === "function") {
      this.update();
    } else {
      const { containerEl: el } = this;
      el.empty();
      this.renderLegacy(el);
    }
  }

  display(): void {
    const { containerEl: el } = this;
    el.empty();
    this.renderLegacy(el);
  }

  private renderLegacy(el: HTMLElement): void {
    const p = this.plugin;
    const s = p.settings;

    if (!appHasDailyNotesPluginLoaded()) {
      el.createDiv({
        cls: "mod-warning",
        text: "The core “Daily notes” plugin (or Periodic Notes) is not enabled. This plugin needs it.",
      });
    }

    /* ---- folders ---- */
    new Setting(el).setName("Media folders").setHeading();
    el.createEl("p", {
      cls: "setting-item-description",
      text: "Folders on your computer. Files are referenced where they are; nothing is copied into the vault.",
    });

    if (typeof s.folders === "string") {
      const trimmed = (s.folders as string).trim();
      s.folders = trimmed ? [trimmed] : [];
    } else if (!Array.isArray(s.folders)) {
      s.folders = [];
    }

    s.folders.forEach((folder, i) => {
      new Setting(el).setName(folder).addExtraButton((b) =>
        b
          .setIcon("trash")
          .setTooltip("Remove")
          .onClick(async () => {
            s.folders.splice(i, 1);
            await p.saveSettings(true);
            this.refresh();
          })
      );
    });

    let typed = "";
    const addFolder = async (path: string) => {
      const v = path.trim().replace(/^["']|["']$/g, "").trim();
      if (!v) return;
      if (!Array.isArray(s.folders)) s.folders = [];
      if (!s.folders.includes(v)) {
        s.folders.push(v);
        await p.saveSettings(true);
        new Notice(`Added folder: ${v}`);
      } else {
        new Notice(`Folder already added: ${v}`);
      }
      this.refresh();
    };
    new Setting(el)
      .setName("Add a folder")
      .setDesc("Browse, or paste a full path such as D:\\Photos\\Phone")
      .addText((t) => {
        t.setPlaceholder("D:\\Photos\\Phone").onChange((v) => (typed = v));
        t.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void addFolder(typed);
          }
        });
      })
      .addButton((b) => b.setButtonText("Add").onClick(() => void addFolder(typed)))
      .addButton((b) =>
        b.setButtonText("Browse…").onClick(async () => {
          const picked = await pickFolder();
          if (picked) await addFolder(picked);
          else new Notice("Couldn't open the folder picker. Paste the path instead.");
        })
      );

    new Setting(el)
      .setName("Include sub-folders")
      .addToggle((t) =>
        t.setValue(s.recursive).onChange(async (v) => {
          s.recursive = v;
          await p.saveSettings(true);
        })
      );
    new Setting(el)
      .setName("Include photos")
      .addToggle((t) =>
        t.setValue(s.includePhotos).onChange(async (v) => {
          s.includePhotos = v;
          await p.saveSettings(false);
        })
      );
    new Setting(el)
      .setName("Include videos")
      .addToggle((t) =>
        t.setValue(s.includeVideos).onChange(async (v) => {
          s.includeVideos = v;
          await p.saveSettings(false);
        })
      );

    /* ---- date detection ---- */
    new Setting(el).setName("Date detection").setHeading();
    el.createEl("p", {
      cls: "setting-item-description",
      text:
        "Order used: (1) date stored inside the file (photo EXIF, video creation date), " +
        "(2) date in the file name, (3) file-system date. Windows' “Date created/modified” are only used as a last resort.",
    });

    new Setting(el)
      .setName("Use date in file name as fallback")
      .setDesc("Matches names like IMG_20240501_211403.jpg or PXL_20240501_….mp4")
      .addToggle((t) =>
        t.setValue(s.useFilenameFallback).onChange(async (v) => {
          s.useFilenameFallback = v;
          await p.saveSettings(false);
        })
      );
    new Setting(el)
      .setName("File-system fallback")
      .setDesc("When a file has no embedded date and no date in its name. “Earliest” is safest: copying a file resets “created”, but usually keeps “modified”.")
      .addDropdown((d) =>
        d
          .addOptions({
            earliest: "Earliest of created / modified",
            modified: "Modified date",
            created: "Created date",
            skip: "Skip these files",
          })
          .setValue(s.fsFallback)
          .onChange(async (v) => {
            s.fsFallback = v as FsFallback;
            await p.saveSettings(false);
          })
      );
    new Setting(el)
      .setName("Timezone for UTC-only videos")
      .setDesc(
        "Android and many cameras store video dates in UTC only. Enter an IANA timezone (e.g. Asia/Kolkata) to convert it " +
          "to the local day. Leave blank to use this computer's timezone. iPhone videos already carry their local time."
      )
      .addText((t) =>
        t
          .setPlaceholder("(this computer)")
          .setValue(s.videoTimezone)
          .onChange(async (v) => {
            s.videoTimezone = v.trim();
            await p.saveSettings(false);
          })
      );
    new Setting(el)
      .setName("Day starts at (hour)")
      .setDesc("Set to e.g. 4 if clips filmed after midnight should belong to the previous day's note.")
      .addSlider((sl) =>
        sl
          .setLimits(0, 12, 1)
          .setValue(s.dayStartHour)
          .onChange(async (v) => {
            s.dayStartHour = v;
            await p.saveSettings(false);
          })
      );

    /* ---- daily notes ---- */
    new Setting(el).setName("Daily notes").setHeading();
    new Setting(el)
      .setName("Add gallery to new daily notes")
      .setDesc("When a daily note is created and has media for that day, a gallery block is inserted automatically.")
      .addToggle((t) =>
        t.setValue(s.autoInsert).onChange(async (v) => {
          s.autoInsert = v;
          await p.saveSettings(false);
        })
      );
    new Setting(el)
      .setName("Also add when opening an existing daily note")
      .setDesc("Adds the block to older notes that have media but no gallery yet.")
      .addToggle((t) =>
        t.setValue(s.autoInsertOnOpen).onChange(async (v) => {
          s.autoInsertOnOpen = v;
          await p.saveSettings(false);
        })
      );
    new Setting(el)
      .setName("Heading to insert under")
      .setDesc("If this heading exists in the note the gallery goes beneath it, otherwise it is appended. Blank = no heading.")
      .addText((t) =>
        t.setValue(s.heading).onChange(async (v) => {
          s.heading = v;
          await p.saveSettings(false);
        })
      );
    new Setting(el)
      .setName("Create the daily note if missing")
      .setDesc("Used by “Open daily note for this photo/video”.")
      .addToggle((t) =>
        t.setValue(s.createIfMissing).onChange(async (v) => {
          s.createIfMissing = v;
          await p.saveSettings(false);
        })
      );

    /* ---- display ---- */
    new Setting(el).setName("Display").setHeading();
    new Setting(el)
      .setName("Thumbnail size (px)")
      .addSlider((sl) =>
        sl
          .setLimits(100, 400, 10)
          .setValue(s.thumbSize)
          .onChange(async (v) => {
            s.thumbSize = v;
            await p.saveSettings(false);
          })
      );
    new Setting(el)
      .setName("Show capture time")
      .addToggle((t) =>
        t.setValue(s.showTime).onChange(async (v) => {
          s.showTime = v;
          await p.saveSettings(false);
        })
      );
    new Setting(el)
      .setName("Show file names")
      .addToggle((t) =>
        t.setValue(s.showNames).onChange(async (v) => {
          s.showNames = v;
          await p.saveSettings(false);
        })
      );
    new Setting(el)
      .setName("Items shown before “Show more”")
      .addText((t) =>
        t.setValue(String(s.maxItems)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (n > 0) {
            s.maxItems = n;
            await p.saveSettings(false);
          }
        })
      );

    /* ---- maintenance ---- */
    new Setting(el).setName("Index").setHeading();
    const idx = p.index;
    const photos = [...idx.entries.values()].filter((e) => e.kind === "image").length;
    const videos = idx.entries.size - photos;
    new Setting(el)
      .setName(`${photos} photos, ${videos} videos indexed`)
      .setDesc(idx.lastScan ? `Last scan: ${new Date(idx.lastScan).toLocaleString()}` : "Not scanned yet")
      .addButton((b) =>
        b.setButtonText("Rescan now").onClick(async () => {
          await idx.scan();
          this.refresh();
        })
      )
      .addButton((b) =>
        b.setButtonText("Clear cache").onClick(async () => {
          await idx.clearCache();
          await idx.scan();
          this.refresh();
        })
      );
    new Setting(el)
      .setName("Auto-rescan every (minutes)")
      .setDesc("0 = only on startup, when a daily note is created, and via the command.")
      .addText((t) =>
        t.setValue(String(s.rescanMinutes)).onChange(async (v) => {
          const n = parseInt(v, 10);
          s.rescanMinutes = isNaN(n) || n < 0 ? 0 : n;
          await p.saveSettings(false);
          p.setupRescanTimer();
        })
      );
  }
}
