# Daily Media Gallery (Obsidian plugin)

Shows the photos and videos from a folder on your computer inside your **daily notes**, matched by the
date the media was actually **captured**. Files are only *referenced* from where they live, nothing is copied into the vault.

Requires: Obsidian desktop 1.4+ and the core **Daily notes** plugin (or Periodic Notes' daily notes).

## Install (manual)

```bash
npm install
npm run build
```

Copy `main.js`, `manifest.json` and `styles.css` into `<your vault>/.obsidian/plugins/daily-media-gallery/`,
then enable **Daily Media Gallery** under Settings → Community plugins.
(`npm run dev` rebuilds on every change while developing.)

## Use

1. Settings → Daily Media Gallery → **Add a folder** (Browse… or paste a path such as `D:\Photos\Phone`).
2. New daily notes automatically get a block under `## Media` when media exists for that day:

   ````
   ```daily-media
   ```
   ````

   Existing notes: run **Insert media gallery into this daily note** (or enable “Also add when opening an existing daily note”).
3. Optional block options, one per line: `date: 2024-05-01`, `type: photos|videos`, `size: 220`, `limit: 30`, `names: true`, `time: false`.

The block is rendered live from the index, so your note only contains those two lines.

## Which date is used (the "not the Windows properties" part)

Windows' *Date created / Date modified* are file-system timestamps and change whenever a file is copied, synced or re-saved.
This plugin reads what's *inside* the file, in this order:

| Step | Photos | Videos (MP4 / MOV / M4V / 3GP) |
|------|--------|--------------------------------|
| 1. Embedded date | EXIF `DateTimeOriginal`, then `CreateDate` (JPEG, HEIC, AVIF, TIFF, DNG) | Apple `com.apple.quicktime.creationdate` (local time + offset), else `©day`, else the `mvhd` creation time (UTC, same value Windows 11 shows as "Media created") |
| 2. File name | `IMG_20240501_211403`, `PXL_…`, `IMG-20240501-WA0001` (toggle) | same |
| 3. File system | earliest of created/modified (configurable, or skip) | same |

* EXIF times and Apple creation dates are *wall-clock time where it was shot*, so the day is exactly what you saw on the phone.
* UTC-only videos (most Android / cameras) are converted using the timezone you set (blank = this computer). 
* "Day starts at" lets 1 a.m. clips belong to the previous day.
* Hover a time label to see which source was used; times from the file system are shown faded.
* MKV / AVI / WMV / WebM don't have a reader yet and fall back to step 2 / 3.

Metadata is cached (`media-cache.json` in the plugin folder, keyed by size + modified time), so rescans are fast.

## Right-click: open the daily note of a photo/video

* **On a thumbnail in the gallery**: Open daily note (also in a new tab) · Open in default app · Show in folder · Copy path.
* **On a photo/video in Obsidian's file explorer** (files inside your vault): *Open daily note for this file's date*.
* **Command palette**: *Open daily note for the active photo/video*.
* **In Windows Explorer** (optional): the plugin registers `obsidian://daily-media?file=<path>`. Save this as `daily-media.reg` and double-click it:

```reg
Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\Software\Classes\SystemFileAssociations\image\shell\ObsidianDailyNote]
@="Open Obsidian daily note for this date"

[HKEY_CURRENT_USER\Software\Classes\SystemFileAssociations\image\shell\ObsidianDailyNote\command]
@="cmd /c start \"\" \"obsidian://daily-media?file=%1\""

[HKEY_CURRENT_USER\Software\Classes\SystemFileAssociations\video\shell\ObsidianDailyNote]
@="Open Obsidian daily note for this date"

[HKEY_CURRENT_USER\Software\Classes\SystemFileAssociations\video\shell\ObsidianDailyNote\command]
@="cmd /c start \"\" \"obsidian://daily-media?file=%1\""
```

On Windows 11 the entry appears under **Show more options** (Shift+F10). Paths containing `&`, `#` or `%` won't survive the
trip through `cmd`; rename those or use the in-Obsidian menus. Remove the keys under `…\SystemFileAssociations\image\shell` and `\video\shell` to undo it.

## Notes & limits

* Thumbnails are the original files scaled down by the browser, so folders with thousands of full-size photos in one day load lazily and may feel heavy.
* HEIC/HEIF, TIFF, DNG, AVI, WMV, MTS don't display in Obsidian's Chromium; they appear as a tile that opens in your default app (their dates are still read).
* HEVC (H.265) videos only play if your GPU/OS supports it; otherwise you get the same click-to-open tile.
* If your media folder is on OneDrive with "Files On-Demand", reading metadata can trigger downloads; prefer a local folder.

## Disclosures

- **Desktop only.** The plugin needs Node.js and Electron APIs, so it does not work on Obsidian mobile.
- **Reads files outside your vault.** It reads the media folders you choose in settings. It only reads them: it never modifies, moves, copies or deletes your photos and videos. It reads file contents only to extract the capture date, which means the first few hundred KB of photos and the metadata section of videos.
- **Writes inside your vault.** It adds a `daily-media` code block to daily notes (automatically only if you leave "Add gallery to new daily notes" on, or when you run the command). It also stores a metadata cache, `media-cache.json`, in its own plugin folder.
- **Opens other apps.** The right-click options "Open in default app" and "Show in folder" use Electron's shell to launch your operating system's file handler or file manager.
- **Optional Windows Explorer integration.** The plugin registers an `obsidian://daily-media` URI. It only does something if you add the registry entry shown above yourself.
- **No network use.** The plugin makes no network requests, sends no telemetry, requires no account, and shows no ads.
- **Open source.** The full source code is in this repository (MIT licensed).
