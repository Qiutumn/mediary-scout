import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkflowRepository, type MediaTitle } from "@media-track/workflow";
const mocks = vi.hoisted(() => ({ search: vi.fn(), movie: vi.fn(), accesses: vi.fn() }));
vi.mock("./workflow-runtime", () => ({ getAccountScopedSettings: () => ({}), getTmdbAccesses: mocks.accesses, getWorkflowRepository: vi.fn() }));
vi.mock("@media-track/workflow", async importOriginal => ({
  ...await importOriginal<typeof import("@media-track/workflow")>(),
  createTmdbSearchProvider: () => ({ searchMedia: mocks.search }),
  createTmdbMetadataProvider: () => ({}), prepareMovieTarget: mocks.movie,
}));
import { importShare, importShareUnlocked, shareImportSchema, type ShareImportDeps } from "./share-import";
const title: MediaTitle = { id: "tmdb_movie_42", tmdbId: 42, type: "movie", title: "Test", originalTitle: "Test", year: 2024, aliases: [] };
async function fixture(): Promise<ShareImportDeps> {
  const repository = new InMemoryWorkflowRepository();
  await repository.upsertConnectedStorage({ id: "drive", accountId: "acct_default", provider: "quark", providerUid: "u", label: "Drive", payload: { cookie: "test-only" }, rootCid: "root", moviesCid: "movies", tvCid: "tv", animeCid: "anime", createdAt: new Date().toISOString() });
  return { repository, preview: vi.fn(async () => ["Test.2024.1080p.mkv"]), accesses: mocks.accesses };
}
beforeEach(() => {
  vi.clearAllMocks(); delete process.env.MEDIA_TRACK_DEMO_MODE;
  mocks.accesses.mockResolvedValue([]);
  mocks.movie.mockResolvedValue({ title, keyword: "Test" });
  mocks.search.mockResolvedValue([{ tmdbId: 42, mediaType: "movie", title: "Test", originalTitle: "Test", year: 2024 }]);
});
describe("share import submission", () => {
  it("automatically resolves a bare link and persists a pinned source", async () => {
    const deps = await fixture();
    const result = await importShareUnlocked({ url: "https://pan.quark.cn/s/abc" }, "acct_default", deps);
    expect(result.status).toBe("queued");
    const run = await deps.repository.getWorkflowRunSnapshot(result.workflowRunId);
    expect(run?.workflowRun.suppliedShare?.url).toBe("https://pan.quark.cn/s/abc");
    expect(run?.connectedStorageId).toBe("drive");
  });
  it("serializes simultaneous duplicates, preserving terminal results across retries", async () => {
    const deps = await fixture();
    const input = { url: "https://pan.quark.cn/s/abc", tmdbId: 42, type: "movie" };
    const results = await Promise.all([importShare(input, "acct_default", deps), importShare(input, "acct_default", deps)]);
    expect(results.map(r => r.status)).toEqual(["queued", "existing"]);
    expect(results[0]!.workflowRunId).toBe(results[1]!.workflowRunId);
    expect(await deps.repository.listActiveWorkflowRuns()).toHaveLength(1);
  });
  it("resolves an obfuscated share title against exact metadata and year", async () => {
    const deps = await fixture();
    vi.mocked(deps.preview).mockResolvedValue(["年z会z不z能z停！2 (2026) 4K 60帧 HDR"]);
    mocks.search.mockResolvedValue([{ tmdbId: 42, mediaType: "movie", title: "年会不能停2！", year: 2026 }]);
    const result = await importShareUnlocked({ url: "https://pan.quark.cn/s/abc" }, "acct_default", deps);
    expect(mocks.search).toHaveBeenCalledWith({ query: "年会不能停！2" });
    expect(result.status).toBe("queued");
  });
  it("rejects cross-account or incompatible drives before reading the share", async () => {
    const deps = await fixture();
    await expect(importShareUnlocked({ url: "https://pan.quark.cn/s/abc", storageId: "drive" }, "stranger", deps)).rejects.toMatchObject({ status: 409 });
    await expect(importShareUnlocked({ url: "https://115.com/s/abc", storageId: "drive" }, "acct_default", deps)).rejects.toMatchObject({ status: 409 });
    expect(deps.preview).not.toHaveBeenCalled();
  });
  it("does not choose between ambiguous media or different titles in a share", async () => {
    const deps = await fixture();
    mocks.search.mockResolvedValue([{ tmdbId: 42, mediaType: "movie", title: "Test", year: 2024 }, { tmdbId: 43, mediaType: "tv", title: "Test", year: 2024 }]);
    await expect(importShareUnlocked({ url: "https://pan.quark.cn/s/abc" }, "acct_default", deps)).rejects.toMatchObject({ status: 409, details: { candidates: expect.any(Array) } });
    vi.mocked(deps.preview).mockResolvedValue(["Movie A", "Movie B"]);
    await expect(importShareUnlocked({ url: "https://pan.quark.cn/s/abc" }, "acct_default", deps)).rejects.toMatchObject({ status: 409 });
    expect(await deps.repository.listActiveWorkflowRuns()).toHaveLength(0);
  });
  it("rejects malformed bodies and demo writes", async () => {
    for (const body of [null, [], { url: 42 }, { url: "x", tmdbId: 1 }, { url: "x", season: -1 }, { url: "x", accountId: "other" }]) expect(shareImportSchema.safeParse(body).success).toBe(false);
    process.env.MEDIA_TRACK_DEMO_MODE = "1";
    await expect(importShareUnlocked({ url: "https://pan.quark.cn/s/abc" }, "acct_default", await fixture())).rejects.toThrow(/只读/);
  });
});
