/** Names follow the library's title/year + season/episode convention. The model
 * supplies identity, not a writable filename/path. Keep the original extension. */
export function importMediaName(input: { title: string; year: number; originalName: string; season?: number; episode?: number }): string {
  const ext = /\.(mkv|mp4|avi|ts|m2ts|mov|flv|wmv)$/i.exec(input.originalName)?.[0];
  if (!ext) throw new Error("Only video files can be renamed");
  const title = input.title.replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  if (!title) throw new Error("Missing canonical title");
  const base = `${title}${input.year > 0 ? ` (${input.year})` : ""}`;
  if (input.season === undefined && input.episode === undefined) return base + ext.toLowerCase();
  if (!Number.isInteger(input.season) || !Number.isInteger(input.episode) || input.season! < 1 || input.episode! < 1 || input.episode! > 10000) throw new Error("Invalid episode identity");
  return `${base} - S${String(input.season).padStart(2, "0")}E${String(input.episode).padStart(2, "0")}${ext.toLowerCase()}`;
}
