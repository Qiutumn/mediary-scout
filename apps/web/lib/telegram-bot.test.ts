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

// Virtual topics retain real sender IDs; the negative chat address is routing,
// never the principal. All gateway updates must pass both allowlists.
describe("Telegram gateway topics", () => {
  const chat = -7000000000042;
  function gatewayFixture(users = [123, 456], chats = [chat]) {
    const f = setup();
    const bot = new TelegramBot(f.runtime, new Set(users), f.call, "gateway-token", { mode: "gateway", chatIds: new Set(chats) });
    const message = (text: string, userId = 123, chatId = chat, id = 1): TelegramUpdate => ({ update_id: id, message: { message_id: id, text, from: { id: userId }, chat: { id: chatId, type: "supergroup" } } });
    return { ...f, bot, message };
  }
  it("accepts authorized topic commands, replies to the virtual address, and notifies completion", async () => {
    const f = gatewayFixture();
    await f.bot.handle(f.message("https://pan.quark.cn/s/abc"));
    expect(f.runtime.importShare).toHaveBeenCalledTimes(1);
    expect(f.call).toHaveBeenCalledWith("sendMessage", expect.objectContaining({ chat_id: chat, text: "queued" }));
    await f.bot.notifyCompleted();
    expect(f.call).toHaveBeenLastCalledWith("sendMessage", expect.objectContaining({ chat_id: chat, text: "done" }));
    await f.bot.notifyCompleted();
    expect(f.call).toHaveBeenCalledTimes(2);
  });
  it("rejects nonmembers, other topics, anonymous senders, missing users and empty allowlists", async () => {
    const f = gatewayFixture();
    const anonymous = f.message("/get movie"); anonymous.message!.sender_chat = { id: chat };
    const missing = f.message("/get movie"); delete missing.message!.from;
    for (const u of [f.message("/get movie", 999), f.message("/get movie", 123, chat - 1), anonymous, missing]) await f.bot.handle(u);
    for (const closed of [gatewayFixture([]), gatewayFixture([123], [])]) {
      await closed.bot.handle(f.message("/get movie"));
      expect(closed.runtime.acquire).not.toHaveBeenCalled(); expect(closed.call).not.toHaveBeenCalled();
    }
    const callback = { update_id: 2, callback_query: { from: { id: 999 }, data: "/get movie" } };
    await f.bot.handle(callback);
    expect(f.runtime.acquire).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled();
  });
  it("isolates candidate selection by both topic and sender across restarts", async () => {
    const f = gatewayFixture([123, 456], [chat, chat - 1]);
    vi.mocked(f.runtime.importShare).mockResolvedValueOnce({ text: "choose", candidates: [{ tmdbId: 42, type: "movie", title: "Movie" }] });
    await f.bot.handle(f.message("https://pan.quark.cn/s/abc"));
    const restarted = new TelegramBot(f.runtime, new Set([123, 456]), f.call, "gateway-token", { mode: "gateway", chatIds: new Set([chat, chat - 1]) });
    await restarted.handle(f.message("/choose 1", 456, chat, 2));
    await restarted.handle(f.message("/choose 1", 123, chat - 1, 3));
    expect(f.runtime.importShare).toHaveBeenCalledTimes(1);
    await restarted.handle(f.message("/choose 1", 123, chat, 4));
    expect(f.runtime.importShare).toHaveBeenCalledTimes(2);
  });
  it("drops subscriptions after sender or topic access is revoked", async () => {
    for (const [users, chats] of [[[456], [chat]], [[123], []]]) {
      const f = gatewayFixture();
      await f.bot.handle(f.message("https://pan.quark.cn/s/abc"));
      const restarted = new TelegramBot(f.runtime, new Set(users), f.call, "gateway-token", { mode: "gateway", chatIds: new Set(chats) });
      await restarted.notifyCompleted();
      expect(f.call).toHaveBeenCalledTimes(1);
    }
  });
  it("does not automatically resend an uncertain gateway reply or notification", async () => {
    const { TelegramDeliveryUncertain } = await import("./telegram-bot");
    const f = gatewayFixture();
    f.call.mockRejectedValueOnce(new TelegramDeliveryUncertain("request-42"));
    await f.bot.handle(f.message("https://pan.quark.cn/s/abc"));
    await f.bot.handle(f.message("https://pan.quark.cn/s/abc"));
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(f.runtime.importShare).toHaveBeenCalledTimes(1);
    f.call.mockRejectedValueOnce(new TelegramDeliveryUncertain("request-43"));
    await f.bot.notifyCompleted(); await f.bot.notifyCompleted();
    expect(f.call).toHaveBeenCalledTimes(2);
    expect([...f.values.values()].some(v => v.includes("request-43"))).toBe(true);
  });
  it("uses the gateway address, bypasses the global proxy, and preserves request IDs on errors", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: [] })));
    const transport = telegramTransport("app-secret", fetcher, { apiRoot: "http://host.docker.internal:18765/", gateway: true });
    await transport("getUpdates", { timeout: 25 });
    expect(fetcher).toHaveBeenCalledWith("http://host.docker.internal:18765/botapp-secret/getUpdates", expect.objectContaining({ dispatcher: expect.any(Object), redirect: "error" }));
    fetcher.mockResolvedValue(new Response(JSON.stringify({ ok: false, description: "UPSTREAM_RESULT_UNKNOWN", gateway_request_id: "request-44" }), { status: 502 }));
    await expect(transport("sendMessage", {})).rejects.toMatchObject({ requestId: "request-44" });
    fetcher.mockResolvedValue(new Response(JSON.stringify({ ok: false, description: "UPSTREAM_CONNECT_FAILED", gateway_request_id: "request-45" }), { status: 503 }));
    await expect(transport("sendMessage", {})).rejects.toThrow("gateway_request_id=request-45");
  });
  it("fails closed when gateway or principal configuration is incomplete", async () => {
    const { telegramConfiguration } = await import("./telegram-bot");
    const env = { TELEGRAM_MODE: "gateway", TELEGRAM_BOT_TOKEN: "app-secret", TELEGRAM_ALLOWED_USER_IDS: "123", TELEGRAM_ALLOWED_CHAT_IDS: String(chat), TELEGRAM_API_ROOT: "http://host.docker.internal:18765" };
    expect(telegramConfiguration(env)?.allowed).toEqual(new Set([123]));
    for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_IDS", "TELEGRAM_ALLOWED_CHAT_IDS", "TELEGRAM_API_ROOT"]) expect(telegramConfiguration({ ...env, [key]: "" })).toBeNull();
    expect(telegramConfiguration({ ...env, TELEGRAM_ALLOWED_CHAT_IDS: "123" })).toBeNull();
    expect(telegramConfiguration({ ...env, TELEGRAM_API_ROOT: "http://user:secret@localhost" })).toBeNull();
  });
});
