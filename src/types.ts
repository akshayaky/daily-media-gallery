export type MediaKind = "image" | "video";

/** Where the date used for a file came from. */
export type DateSource = "exif" | "quicktime" | "mp4-utc" | "filename" | "file-system";

export interface MediaEntry {
  path: string; // absolute path on disk
  name: string;
  kind: MediaKind;
  size: number;
  /** Wall-clock capture time, "YYYY-MM-DDTHH:mm:ss" (no timezone). */
  wall: string;
  /** Daily-note date key, "YYYY-MM-DD" (after applying the "day starts at" setting). */
  dateKey: string;
  source: DateSource;
}

/** Raw metadata read from inside the file. Cached so files are only parsed once. */
export interface RawMeta {
  /** Local wall-clock time recorded by the camera (EXIF, or Apple QuickTime creation date). */
  wall?: string;
  wallSource?: "exif" | "quicktime";
  /** UTC instant from the MP4/MOV `mvhd` atom (videos that don't store a local time). */
  utcMs?: number;
}

export interface CacheEntry {
  s: number; // size
  m: number; // mtimeMs
  b: number; // birthtimeMs
  meta: RawMeta;
}
