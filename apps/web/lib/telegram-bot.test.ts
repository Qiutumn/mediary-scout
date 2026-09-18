import { describe, it, expect, vi } from "vitest";
import { TelegramBot, telegramTransport, parseImportMessage, type TelegramRuntime, type TelegramUpdate } from "./telegram-bot";

function setup() {
  const values = new Map<string, string>();
  const runtime: TelegramRuntime = {
    get: async k => values.get(k) ?? null, set: async (k, v) => { values.set(k, v); },
    importShare: vi.fn(async () => ({ text: "queued", workflowRunId: "share_1" })),
    acquire: vi.fn(async () => ({ text: "queued" })),
    drives: vi.fn(async () => "drive"), status: vi.fn(async () => ({ text: "done", terminal: true })),
  };
  const call = vi.fn().mockResolvedValue([]);
  const bot = new TelegramBot(runtime, new Set([123]), call, "test-token");
  const update = (text: string, id = 1): TelegramUpdate => ({ update_id: id, message: { message_id: id, text, from: { id: 123 }, chat: { id: 123, type: "private" } } });
  return { bot, runtime, call, update, values };
}

describe("Telegram authorization and durable delivery", () => {
  it("ignores unauthorized users and groups before doing any work", async () => {
    const { bot, runtime, call, update } = setup();
    const group = update("https://pan.quark.cn/s/abc"); group.message!.chat.type = "group";
    const stranger = update("/get movie"); stranger.message!.from!.id = 999;
    await bot.handle(group); await bot.handle(stranger);
    expect(runtime.importShare).not.toHaveBeenCalled(); expect(runtime.acquire).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
  });
  it("survives send failure + restart without re-enqueuing; notifies completion", async () => {
    const { bot, runtime, call, update } = setup();
    call.mockRejectedValueOnce(new Error("offline"));
    await expect(bot.handle(update("https://pan.quark.cn/s/abc"))).rejects.toThrow();
    const restarted = new TelegramBot(runtime, new Set([123]), call, "test-token");
    await restarted.handle(update("https://pan.quark.cn/s/abc"));
    expect(runtime.importShare).toHaveBeenCalledTimes(1);
    await restarted.notifyCompleted();
    const sent = call.mock.calls.length;
    await restarted.notifyCompleted();
    expect(call.mock.calls.length).toBe(sent);
  });
  it("persists candidate choice across restart", async () => {
    const { bot, runtime, call, update } = setup();
    vi.mocked(runtime.importShare).mockResolvedValueOnce({ text: "choose", candidates: [{ tmdbId: 42, type: "movie", title: "Movie", year: 2024 }] });
    await bot.handle(update("https://pan.quark.cn/s/abc"));
    await new TelegramBot(runtime, new Set([123]), call, "test-token").handle(update("/choose 1", 2));
    expect(runtime.importShare).toHaveBeenLastCalledWith({ url: "https://pan.quark.cn/s/abc", tmdbId: 42, type: "movie" });
  });
  it("advances getUpdates offset only after successful reply", async () => {
    const { bot, call, update } = setup();
    call.mockImplementation(async method => method === "getUpdates" ? [update("/help", 20)] : {});
    await bot.tick(); await bot.tick();
    expect(call.mock.calls.filter(([m]) => m === "getUpdates")[1]![1]).toMatchObject({ offset: 21, timeout: 25 });
  });
  it("parses explicit metadata and drive without sending credentials", () => {
    expect(parseImportMessage("/import https://115.com/s/a | 片名 | tv:42 | s2 | storage=cs_a")).toEqual({ url: "https://115.com/s/a", query: "片名", type: "tv", tmdbId: 42, season: 2, storageId: "cs_a" });
  });
  it("redacts tokens from transport failures", async () => {
    const transport = telegramTransport("secret", vi.fn().mockRejectedValue(new Error("https://api.telegram.org/botsecret/getUpdates")));
    await expect(transport("getUpdates", {})).rejects.toThrow("Telegram 网络连接失败");
  });
});
