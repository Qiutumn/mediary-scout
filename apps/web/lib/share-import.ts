import { createHash } from "node:crypto";
import { z } from "zod";
import {
  parseSuppliedShare, mediaHintFromName, createTmdbSearchProvider, createTmdbMetadataProvider,
  prepareMovieTarget, prepareTrackingTarget, movieAnchorSeason, createEpisodeStates,
  QuarkCookieClient, Pan115CookieClient, Pan123Client, TianyiClient,
  type SuppliedShare, type ConnectedStorage, type WorkflowRepository, type MediaSearchCandidate, type MediaTitle, type TrackedSeason,
} from "@media-track/workflow";
import { getWorkflowRepository, getAccountScopedSettings, getTmdbAccesses } from "./workflow-runtime";
import { assertNotDemoFromEnv } from "./demo-mode";

export const shareImportSchema = z.object({
  url: z.string().trim().min(1).max(4096),
  password: z.string().trim().max(32).optional(),
  query: z.string().trim().min(1).max(200).optional(),
  type: z.enum(["movie", "tv"]).optional(),
  tmdbId: z.number().int().positive().optional(),
  season: z.number().int().min(1).max(200).optional(),
  storageId: z.string().min(1).max(128).optional(),
}).strict().refine(x => !x.tmdbId || x.type, { message: "指定 tmdbId 时必须同时指定 type（movie/tv）" });
export type ShareImportInput = z.infer<typeof shareImportSchema>;

export class ImportRequestError extends Error {
  constructor(public readonly status: number, message: string, public readonly details: Record<string, unknown> = {}) { super(message); }
}

export async function previewShareNames(share: SuppliedShare, drive: ConnectedStorage): Promise<string[]> {
  const creds = drive.payload as Record<string, string>;
  switch (share.provider) {
    case "quark": {
      const client = new QuarkCookieClient({ cookie: creds.cookie ?? "" });
      const stoken = await client.getShareToken({ pwd_id: share.shareCode, passcode: share.password });
      return (await client.listShareDetail({ pwd_id: share.shareCode, stoken })).map(f => f.file_name ?? "").filter(Boolean);
    }
    case "pan115": return new Pan115CookieClient({ cookie: creds.cookie ?? "" }).previewShare({ shareCode: share.shareCode, receiveCode: share.password });
    case "pan123": return (await new Pan123Client({ token: creds.token ?? "" }).listShareDir({ shareKey: share.shareCode, sharePwd: share.password })).map(f => f.name);
    case "tianyi": {
      const client = new TianyiClient({ sessionKey: creds.sessionKey ?? "", accessToken: creds.accessToken ?? "", refreshToken: creds.refreshToken ?? "" });
      const info = await client.getShareInfo(share.shareCode);
      return (await client.listShareDir({ ...info, accessCode: share.password })).map(f => f.name);
    }
  }
}

export interface ShareImportDeps {
  repository: WorkflowRepository;
  preview: typeof previewShareNames;
  accesses: typeof getTmdbAccesses;
}

// Single web/worker process: serialize submissions, including Telegram redelivery.
// Persistence below gives restart idempotency; the repository owns reservation locks.
let importTail: Promise<unknown> = Promise.resolve();
export function importShare(raw: unknown, accountId: string, overrides?: ShareImportDeps) {
  const result = importTail.then(() => importShareUnlocked(raw, accountId, overrides));
  importTail = result.catch(() => undefined);
  return result;
}

export async function importShareUnlocked(raw: unknown, accountId: string, overrides?: ShareImportDeps) {
  assertNotDemoFromEnv(process.env);
  const validation = shareImportSchema.safeParse(raw);
  if (!validation.success) throw new ImportRequestError(400, validation.error.issues.map(i => i.message).join("；"));
  const input = validation.data;
  let share: SuppliedShare;
  try { share = parseSuppliedShare(input.url, input.password); }
  catch (error) { throw new ImportRequestError(400, (error as Error).message); }
  const repo = overrides?.repository ?? getWorkflowRepository();
  const drives = await repo.listConnectedStorages(accountId);
  const compatible = drives.filter(d => d.provider === share.provider && d.status === "active");
  const drive = input.storageId ? compatible.find(d => d.id === input.storageId) : compatible.length === 1 ? compatible[0] : undefined;
  if (!drive) throw new ImportRequestError(409, "请选择一块已连接且与分享同品牌的网盘。", { storages: compatible.map(d => ({ id: d.id, provider: d.provider, label: d.label })) });

  let query = input.query;
  let season = input.season;
  let year: number | undefined;
  if (!query && !input.tmdbId) {
    let names: string[];
    try { names = await (overrides?.preview ?? previewShareNames)(share, drive); }
    catch { throw new ImportRequestError(422, "无法读取分享内容，请检查链接、提取码和网盘登录状态，或补充 query / tmdbId 与 type。"); }
    const hints = names.map(mediaHintFromName).filter(h => h.query);
    const unique = [...new Set(hints.map(h => h.query))];
    if (unique.length !== 1) throw new ImportRequestError(409, "分享中无法确定唯一作品，请补充 query 或 tmdbId 与 type。", { titles: unique.slice(0, 10) });
    query = unique[0]!;
    year = hints[0]?.year;
    const seasons = [...new Set(hints.flatMap(h => h.season ? [h.season] : []))];
    if (!season && seasons.length > 1) throw new ImportRequestError(409, "分享包含多季，请通过 season 指定本次整理的季。", { seasons });
    season ??= seasons[0];
  }
  const accesses = await (overrides?.accesses ?? getTmdbAccesses)(getAccountScopedSettings(accountId));
  let tmdbId = input.tmdbId;
  let type = input.type;
  if (!tmdbId) {
    const candidates = (await createTmdbSearchProvider(accesses).searchMedia({ query: query! }))
      .filter(c => !type || c.mediaType === type).filter(c => !year || c.year === year);
    if (!candidates.length) throw new ImportRequestError(404, "未找到匹配的影视信息，请补充准确片名或 tmdbId。", { candidates: [] });
    const normalize = (s: string) => s.toLocaleLowerCase().replace(/[\s\p{P}]/gu, "");
    const exact = candidates.filter(c => [c.title, c.originalTitle ?? ""].some(t => normalize(t) === normalize(query!)));
    if (exact.length !== 1) throw new ImportRequestError(409, "请确认影视作品，再带 tmdbId 与 type 重发。", { candidates: candidates.slice(0, 5).map(candidateSummary) });
    tmdbId = exact[0]!.tmdbId;
    type = exact[0]!.mediaType;
  }
  const metadataProvider = createTmdbMetadataProvider(accesses);
  const target: { title: MediaTitle; season?: TrackedSeason; keyword: string } = type === "movie"
    ? await prepareMovieTarget({ tmdbId, qualityPreference: "4K", metadataProvider })
    : await prepareTrackingTarget({ tmdbId, mediaType: "tv", seasonNumber: season ?? 1, qualityPreference: "4K", metadataProvider });
  const targetSeason = target.season ?? movieAnchorSeason({ titleId: target.title.id, qualityPreference: "4K", storageDirectoryId: "" });
  const key = JSON.stringify([accountId, drive.id, share.provider, share.shareCode, share.password, type, tmdbId, targetSeason.seasonNumber]);
  const workflowRunId = `share_${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
  const prior = await repo.getWorkflowRunSnapshot(workflowRunId, accountId);
  if (prior) return { status: "existing", workflowRunId, workflowStatus: prior.workflowRun.status, title: prior.title.title, storageId: drive.id };
  const existing = (await repo.listTrackedSeasonStates({ accountId, connectedStorageId: drive.id })).find(s => s.season.id === targetSeason.id);
  // Retain existing metadata/episode state while the new task is queued.
  const episodes = existing?.episodes ?? (type === "movie" ? [] : createEpisodeStates({ trackedSeasonId: targetSeason.id, seasonNumber: targetSeason.seasonNumber, totalEpisodes: targetSeason.totalEpisodes, latestAiredEpisode: targetSeason.latestAiredEpisode }));
  const reservation = await repo.reserveWorkflowRun({
    accountId, connectedStorageId: drive.id, title: target.title, season: existing?.season ?? targetSeason,
    workflowRun: { id: workflowRunId, kind: type === "movie" ? "movie_init" : "type2_init", status: "queued", trackedSeasonId: targetSeason.id, startedAt: new Date().toISOString(), finishedAt: null, suppliedShare: share,
      auditEvents: [{ type: "share_import_queued", message: "用户分享已加入转存与整理队列", data: { provider: share.provider } }] },
    episodes, resourceSnapshots: [], decisions: [], transferAttempts: [], notifications: [], blockIfTitleHasActiveRun: true,
  });
  if (reservation.status !== "reserved") throw new ImportRequestError(409, "该作品已有任务运行，请完成后重试。", { workflowRunId: reservation.status === "already_active" ? reservation.snapshot.workflowRun.id : null });
  return { status: "queued", workflowRunId, workflowStatus: "queued", title: target.title.title, storageId: drive.id };
}

function candidateSummary(c: MediaSearchCandidate) { return { tmdbId: c.tmdbId, type: c.mediaType, title: c.title, year: c.year }; }

export async function shareImportStatus(id: string, accountId: string) {
  const snapshot = await getWorkflowRepository().getWorkflowRunSnapshot(id, accountId);
  if (!snapshot || !snapshot.workflowRun.suppliedShare) throw new ImportRequestError(404, "未找到导入任务。");
  return { workflowRunId: id, status: snapshot.workflowRun.status, title: snapshot.title.title,
    storageId: snapshot.connectedStorageId, progress: snapshot.workflowRun.progress ?? null,
    obtainedEpisodes: snapshot.obtainedEpisodes, finishedAt: snapshot.workflowRun.finishedAt,
    reports: snapshot.notifications.map(n => ({ title: n.title, body: n.body })) };
}
