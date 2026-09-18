import { describe, it, expect, vi } from "vitest";
import { parseSuppliedShare, mediaHintFromName, suppliedShareProvider } from "../src/share-source.js";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";

describe("supplied share normalization", () => {
  it.each([
    ["https://pan.quark.cn/s/abc 提取码: ab12", "quark", "ab12"],
    ["https://115cdn.com/s/abc?password=1234", "pan115", "1234"],
    ["https://www.123684.com/s/abc?pwd=ABCD", "pan123", "ABCD"],
    ["https://cloud.189.cn/web/share?code=abc&accessCode=abcd", "tianyi", "abcd"],
  ])("parses %s", (url, provider, password) => {
    expect(parseSuppliedShare(url)).toMatchObject({ provider, password, shareCode: "abc" });
  });
  it.each(["http://127.0.0.1/s/x", "https://pan.quark.cn.evil.test/s/x", "https://evil@pan.quark.cn/s/x", "https://pan.quark.cn:444/s/x", "https://pan.quark.cn/other/x", "https://pan.quark.cn/s/a https://pan.quark.cn/s/b"])("rejects untrusted/multiple URL %s", url => expect(() => parseSuppliedShare(url)).toThrow());
  it("keeps the provided source across keywords and run-scopes candidate ids", async () => {
    const provider = suppliedShareProvider(parseSuppliedShare("https://115.com/s/abc"), "Show", 2024);
    const a = await provider.search({ keyword: "Show", workflowRunId: "a" });
    const b = await provider.search({ keyword: "different", workflowRunId: "b" });
    expect(a.candidates[0]!.providerPayload).toEqual(b.candidates[0]!.providerPayload);
    expect(a.candidates[0]!.id).not.toBe(b.candidates[0]!.id);
  });
  it("extracts season/year from release names", () => {
    expect(mediaHintFromName("Breaking.Bad.2008.S02E01.1080p.mkv")).toEqual({ query: "Breaking Bad", year: 2008, season: 2 });
  });
  it("cleans repeated share-title separators without stripping meaningful Latin text", () => {
    expect(mediaHintFromName("年z会z不z能z停！2 (2026) 4K 60帧 HDR")).toEqual({ query: "年会不能停！2", year: 2026 });
    expect(mediaHintFromName("阿Q正传 (1981)").query).toBe("阿Q正传");
    expect(mediaHintFromName("汉a字b混c排").query).toBe("汉a字b混c排");
  });
});

async function fixture(paths = ["original S01E01.mkv", "original S01E01.zh.ass"], movie = false) {
  const storage = new Storage115Simulator({ packs: { pack: { files: paths.map(path => ({ path, sizeBytes: 1000 })) } } });
  const dir = await storage.createDirectory({ name: "target", parentId: "root" });
  await storage.transferCandidate({ candidateId: "pack", intoDirectoryId: dir });
  const sandbox = new TaskSandbox({ provider: new FakeResourceProviderV2(), storage,
    importNaming: { title: "Test Show", year: 2024 }, ...(movie ? { targetMovieDirectoryId: dir } : { targetSeasonDirectoryIds: { 1: dir } }), need: movie ? ["MOVIE"] : ["S01E01"] });
  return { storage, dir, sandbox, files: await storage.listTree({ directoryId: dir }) };
}

describe("verified canonical import naming", () => {
  it("requires rename before success, preserves subtitles and confirms actual names", async () => {
    const { sandbox, files, storage, dir } = await fixture();
    await expect(sandbox.markObtained({ codes: ["S01E01"] })).rejects.toThrow(/Rename/);
    await sandbox.renameImportedMedia({ files: [{ fileId: files.find(f => f.isVideo)!.id, season: 1, episode: 1 }] });
    expect((await storage.listTree({ directoryId: dir })).map(f => f.path)).toEqual(["Test Show (2024) - S01E01.mkv", "Test Show (2024) - S01E01.zh.ass"]);
    await sandbox.markObtained({ codes: ["S01E01"] });
    expect((await sandbox.finish()).coverageMet).toBe(true);
  });
  it("uses title/year for movies", async () => {
    const { sandbox, files, storage, dir } = await fixture(["release.mkv"], true);
    await sandbox.renameImportedMedia({ files: [{ fileId: files[0]!.id }] });
    expect((await storage.listTree({ directoryId: dir }))[0]!.path).toBe("Test Show (2024).mkv");
    await sandbox.markObtained({ codes: ["MOVIE"] });
  });
  it("rejects collisions before any rename, and refuses out-of-scope files", async () => {
    const { sandbox, files, storage } = await fixture(["a.mkv", "b.mkv"]);
    const spy = vi.spyOn(storage, "renameFile");
    await expect(sandbox.renameImportedMedia({ files: files.map(f => ({ fileId: f.id, season: 1, episode: 1 })) })).rejects.toThrow(/collision/);
    expect(spy).not.toHaveBeenCalled();
    await expect(sandbox.renameImportedMedia({ files: [{ fileId: "outside", season: 1, episode: 1 }] })).rejects.toThrow();
    await expect(sandbox.renameImportedMedia({ files: [{ fileId: files[0]!.id, season: 2, episode: 1 }] })).rejects.toThrow();
  });
  it("does not claim success if a provider silently ignores rename", async () => {
    const { sandbox, files, storage } = await fixture();
    vi.spyOn(storage, "renameFile").mockResolvedValue();
    await expect(sandbox.renameImportedMedia({ files: [{ fileId: files[0]!.id, season: 1, episode: 1 }] })).rejects.toThrow(/persist/);
    await expect(sandbox.markObtained({ codes: ["S01E01"] })).rejects.toThrow();
  });
});
