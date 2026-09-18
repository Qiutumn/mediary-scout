import { describe, it, expect, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { InMemoryWorkflowRepository, FakeStorageExecutor, movieAnchorSeason, runQueuedMovieAcquisition, runQueuedType2Workflow, parseSuppliedShare, type MediaTitle, type TrackedSeason } from "../src/index.js";

const usage = { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } };
function model(tv: boolean) {
  const steps = [
    ["transferCandidate", { snapshotId: "share_run_supplied", candidateId: "share_run_supplied_1" }],
    ...(tv ? [["moveToSeason", { moves: [{ season: 1, fileIds: ["video"] }] }]] : [["flattenMovie", {}]]),
    ["renameImportedMedia", { files: [{ fileId: "video", ...(tv ? { season: 1, episode: 1 } : {}) }] }],
    ["markObtained", { codes: [tv ? "S01E01" : "MOVIE"] }],
    ["finish", {}],
  ] as Array<[string, unknown]>;
  let step = 0;
  return new MockLanguageModelV3({ doGenerate: async () => {
    const next = steps[step++];
    return { content: next ? [{ type: "tool-call" as const, toolCallId: `step_${step}`, toolName: next[0], input: JSON.stringify(next[1]) }] : [{ type: "text" as const, text: "done" }], finishReason: { unified: next ? "tool-calls" as const : "stop" as const, raw: "stop" }, usage, warnings: [] };
  } });
}

describe("share → existing worker → transfer → canonical naming → persisted result", () => {
  it.each([false, true])("executes pinned-source %s workflow and retains source after restart", async tv => {
    const repository = new InMemoryWorkflowRepository();
    const title: MediaTitle = { id: tv ? "tmdb_tv_42" : "tmdb_movie_42", tmdbId: 42, type: tv ? "tv" : "movie", title: "Test", originalTitle: "Test", year: 2024, aliases: [] };
    const season: TrackedSeason = tv ? { id: "tmdb_tv_42_s1", mediaTitleId: title.id, seasonNumber: 1, status: "active", qualityPreference: "4K", storageDirectoryId: "", totalEpisodes: 1, latestAiredEpisode: 1, latestAiredSource: "metadata" } : movieAnchorSeason({ titleId: title.id, qualityPreference: "4K", storageDirectoryId: "" });
    const share = parseSuppliedShare("https://pan.quark.cn/s/abc?pwd=1234");
    await repository.reserveWorkflowRun({ title, season, workflowRun: { id: "share_run", kind: tv ? "type2_init" : "movie_init", status: "running", trackedSeasonId: season.id, startedAt: new Date().toISOString(), finishedAt: null, auditEvents: [], suppliedShare: share }, episodes: [], resourceSnapshots: [], decisions: [], transferAttempts: [], notifications: [] });
    // Recover from a stopped worker, proving the source survives durable requeue.
    expect(await repository.requeueRunningWorkflowRuns()).toBe(1);
    const storage = new FakeStorageExecutor({ transferOutcomes: { share_run_supplied_1: {
      status: "succeeded", providerMessage: "saved", files: [{ id: "video", providerFileId: "video", storageDirectoryId: "", name: tv ? "raw S01E01.mkv" : "raw.mkv", sizeBytes: 1_000_000, episodeCode: tv ? "S01E01" : null }],
    } } });
    const fallback = { search: vi.fn(async () => { throw new Error("Must not search PanSou for a supplied link"); }) };
    const transfer = vi.spyOn(storage, "transfer");
    const deps = { repository, storage, resourceProvider: fallback, model: model(tv), moviesParentDirectoryId: "movies", storageParentDirectoryId: "tv", resolveAccountContext: async () => ({ storageProvider: "quark" }) };
    const result = tv ? await runQueuedType2Workflow(deps) : await runQueuedMovieAcquisition(deps);
    expect(result).toMatchObject({ status: "ran", workflowStatus: "succeeded" });
    expect(fallback.search).not.toHaveBeenCalled();
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(transfer.mock.calls[0]![0].candidate.providerPayload).toEqual({ url: share.url, password: "1234" });
    const snapshot = (await repository.getWorkflowRunSnapshot("share_run"))!;
    expect(snapshot.workflowRun.suppliedShare).toEqual(share);
    expect(snapshot.obtainedEpisodes).not.toHaveLength(0);
    expect((await storage.listTree({ directoryId: snapshot.season.storageDirectoryId })).map(f => f.path)).toContain(tv ? "Test (2024) - S01E01.mkv" : "Test (2024).mkv");
  });
});
