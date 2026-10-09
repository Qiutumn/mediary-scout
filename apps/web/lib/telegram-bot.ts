import { createHash } from "node:crypto";
import { Agent } from "undici";

export interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; text?: string; caption?: string; sender_chat?: { id: number }; from?: { id: number; is_bot?: boolean }; chat: { id: number; type: string } };
}
export interface BotResult {
  text: string;
  workflowRunId?: string;
  candidates?: Array<{ tmdbId: number; type: "tv" | "movie"; title: string; year?: number | null }>;
}
export interface TelegramRuntime {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  importShare(input: Record<string, unknown>): Promise<BotResult>;
  acquire(input: Record<string, unknown>): Promise<BotResult>;
  drives(): Promise<string>;
  status(id?: string): Promise<{ text: string; terminal?: boolean }>;
}
interface Pending { input: Record<string, unknown>; kind: "import" | "acquire"; candidates: NonNullable<BotResult["candidates"]>; expires: number }
export interface TelegramRouting { mode: "private" | "gateway"; chatIds: Set<number> }
interface Subscription { chatId: number; userId?: number; id: string; deliveryUncertain?: string }
interface Receipt { updateId: number; chatId: number; result: BotResult; userId?: number; subscribed?: boolean; deliveryUncertain?: string }
const HELP = `巡影机器人\n直接发送网盘分享链接：自动识别、转存、重命名。\n/import 链接 | 片名 | movie:157336 或 tv:1396 | s1 | storage=cs_xxx\n/get 片名：搜索并获取\n/choose 1：选择上一次的候选\n/drives：列出可用网盘\n/status：查看活动\n/status 任务ID：查看进度\n只接受授权用户；网关模式仅处理绑定话题。分享导入默认选同品牌唯一网盘。`;

export class TelegramDeliveryUncertain extends Error {
  constructor(public readonly requestId: string = "unknown") { super("Telegram 发送结果待核对"); }
}

/** Gateway requests bypass the global/env proxy and allow its outbound queue
 * plus upstream timeout. Never include token URLs or raw errors in diagnostics. */
export function telegramTransport(token: string, fetchImpl: typeof fetch = fetch, options: { apiRoot?: string; gateway?: boolean } = {}) {
  const root = (options.apiRoot ?? "https://api.telegram.org").replace(/\/+$/, "");
  const dispatcher = options.gateway ? new Agent() : undefined;
  return async <T>(method: string, body: Record<string, unknown>): Promise<T> => {
    let response: Response;
    const init: RequestInit & { dispatcher?: Agent } = {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.gateway ? 95_000 : method === "getUpdates" ? 35_000 : 15_000),
      redirect: "error", ...(dispatcher ? { dispatcher } : {}),
    };
    try { response = await fetchImpl(`${root}/bot${token}/${method}`, init); }
    catch {
      if (options.gateway && method === "sendMessage") throw new TelegramDeliveryUncertain();
      throw new Error("Telegram 网络连接失败");
    }
    const envelope = await response.json().catch(() => null) as { ok?: boolean; result?: T; error_code?: number; description?: string; gateway_request_id?: string } | null;
    const rawId = envelope?.gateway_request_id;
    const requestId = typeof rawId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(rawId) ? rawId : undefined;
    if (options.gateway && method === "sendMessage" && (!envelope || envelope.description?.includes("UPSTREAM_RESULT_UNKNOWN"))) {
      throw new TelegramDeliveryUncertain(requestId);
    }
    if (!response.ok || !envelope?.ok) throw new Error(`Telegram API 失败 (${envelope?.error_code ?? response.status})${requestId ? ` gateway_request_id=${requestId}` : ""}`);
    return envelope.result as T;
  };
}

/** Fail closed on empty user/topic lists; gateway addresses are explicit. */
export function telegramConfiguration(env: Readonly<Record<string, string | undefined>>) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const allowed = new Set((env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(",").map(s => Number(s.trim())).filter(n => Number.isSafeInteger(n) && n > 0));
  const mode = env.TELEGRAM_MODE ?? "private";
  if (!token || !allowed.size || (mode !== "private" && mode !== "gateway")) return null;
  const chatIds = new Set((env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").split(",").map(s => Number(s.trim())).filter(n => Number.isSafeInteger(n) && n < 0));
  const apiRoot = env.TELEGRAM_API_ROOT?.trim() || (mode === "private" ? "https://api.telegram.org" : "");
  try {
    const url = new URL(apiRoot);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  } catch { return null; }
  if (mode === "gateway" && !chatIds.size) return null;
  const routing: TelegramRouting = { mode, chatIds };
  return { token, allowed, apiRoot, routing };
}

export function parseImportMessage(text: string): Record<string, unknown> {
  const [url, ...options] = text.replace(/^\/import(?:@\w+)?\s*/i, "").split(/\s*\|\s*/);
  const input: Record<string, unknown> = { url: url?.trim() ?? "" };
  for (const part of options) {
    const target = /^(movie|tv):(\d+)$/.exec(part);
    const season = /^s(\d+)$/i.exec(part);
    if (target) { input.type = target[1]; input.tmdbId = Number(target[2]); }
    else if (season) input.season = Number(season[1]);
    else if (part.startsWith("storage=")) input.storageId = part.slice(8);
    else if (part) input.query = part;
  }
  return input;
}

/** Single consumer. Persist the business result before replying. Redelivery
 * reuses it; uncertain gateway sends are held for operator review, not retried. */
export class TelegramBot {
  private readonly key: string;
  constructor(private readonly runtime: TelegramRuntime, private readonly allowed: Set<number>, private readonly call: ReturnType<typeof telegramTransport>, botIdentity: string, private readonly routing: TelegramRouting = { mode: "private", chatIds: new Set() }) {
    this.key = `telegram_${createHash("sha256").update(botIdentity).digest("hex").slice(0, 16)}`;
  }
  private async read<T>(name: string, fallback: T): Promise<T> {
    const value = await this.runtime.get(`${this.key}_${name}`);
    return value ? JSON.parse(value) as T : fallback;
  }
  private async write(name: string, value: unknown) { await this.runtime.set(`${this.key}_${name}`, JSON.stringify(value)); }
  private async send(chatId: number, text: string) {
    // Plain text, no Markdown/HTML injection; cap to Telegram's 4096-char limit.
    await this.call("sendMessage", { chat_id: chatId, text: text.slice(0, 4000), link_preview_options: { is_disabled: true } });
  }
  private acceptsChat(chatId: number, userId: number): boolean {
    return this.routing.mode === "gateway" ? this.routing.chatIds.has(chatId) : chatId === userId;
  }
  private async deliver(chatId: number, text: string): Promise<string | undefined> {
    try { await this.send(chatId, text); }
    catch (error) {
      if (!(error instanceof TelegramDeliveryUncertain)) throw error;
      console.warn(`[telegram] 发送结果待核对，停止自动重发 gateway_request_id=${error.requestId}`);
      return error.requestId;
    }
  }
  async handle(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message || message.sender_chat || !message.from || message.from.is_bot || !this.allowed.has(message.from.id)) return;
    if (!this.acceptsChat(message.chat.id, message.from.id)) return;
    if (this.routing.mode === "gateway" ? !["group", "supergroup"].includes(message.chat.type) : message.chat.type !== "private") return;
    let receipt = await this.read<Receipt | null>("receipt", null);
    if (receipt?.updateId !== update.update_id) {
      const text = (message.text ?? message.caption ?? "").trim();
      const result = await this.command(text, message.chat.id, message.from.id);
      receipt = { updateId: update.update_id, chatId: message.chat.id, userId: message.from.id, result };
      await this.write("receipt", receipt);
    }
    if (receipt.result.workflowRunId && !receipt.subscribed) {
      const jobs = await this.read<Subscription[]>("jobs", []);
      if (!jobs.some(j => j.chatId === receipt!.chatId && j.id === receipt!.result.workflowRunId && (j.userId ?? j.chatId) === (receipt!.userId ?? receipt!.chatId))) {
        jobs.push({ chatId: receipt.chatId, userId: receipt.userId ?? receipt.chatId, id: receipt.result.workflowRunId });
        await this.write("jobs", jobs);
      }
      receipt.subscribed = true;
      await this.write("receipt", receipt);
    }
    if (!receipt.deliveryUncertain) {
      const uncertain = await this.deliver(receipt.chatId, receipt.result.text);
      if (uncertain) { receipt.deliveryUncertain = uncertain; await this.write("receipt", receipt); }
    }
  }
  private async command(text: string, chatId: number, userId: number): Promise<BotResult> {
    const session = this.routing.mode === "gateway" ? `${chatId}_${userId}` : String(chatId);
    if (/^\/(start|help)(?:@\w+)?$/.test(text)) return { text: HELP };
    if (/^\/drives(?:@\w+)?$/.test(text)) return { text: await this.runtime.drives() };
    const status = /^\/status(?:@\w+)?(?:\s+(\S+))?$/.exec(text);
    if (status) return this.runtime.status(status[1]);
    const choose = /^\/choose(?:@\w+)?\s+(\d+)$/.exec(text);
    let input: Record<string, unknown>;
    let kind: Pending["kind"];
    if (choose) {
      const pending = await this.read<Pending | null>(`pending_${session}`, null);
      const selected = pending?.candidates[Number(choose[1]) - 1];
      if (!pending || pending.expires < Date.now() || !selected) return { text: "没有有效的候选，请重新发送片名或分享链接。" };
      input = { ...pending.input, tmdbId: selected.tmdbId, type: selected.type };
      kind = pending.kind;
    } else if (/https:\/\//i.test(text) || /^\/import\b/i.test(text)) {
      input = parseImportMessage(text); kind = "import";
    } else if (/^\/get(?:@\w+)?\s+\S/.test(text)) {
      input = { query: text.replace(/^\/get(?:@\w+)?\s+/, "") }; kind = "acquire";
    } else return { text: HELP };
    const result = kind === "import" ? await this.runtime.importShare(input) : await this.runtime.acquire(input);
    if (result.candidates?.length) {
      await this.write(`pending_${session}`, { input, kind, candidates: result.candidates, expires: Date.now() + 86400_000 });
      result.text += "\n" + result.candidates.map((c, i) => `${i + 1}. ${c.title} (${c.year ?? "未知年份"}) [${c.type}]`).join("\n") + "\n回复 /choose 序号";
    } else if (result.workflowRunId) await this.write(`pending_${session}`, null);
    return result;
  }
  async notifyCompleted() {
    const jobs = await this.read<Subscription[]>("jobs", []);
    // Save after each successful delivery, so a failed later recipient doesn't
    // cause earlier notifications to be resent on every tick.
    let remaining = [...jobs];
    for (const job of jobs) {
      if (!this.allowed.has(job.userId ?? job.chatId) || !this.acceptsChat(job.chatId, job.userId ?? job.chatId)) {
        remaining = remaining.filter(j => j !== job); await this.write("jobs", remaining); continue;
      }
      if (job.deliveryUncertain) continue;
      const status = await this.runtime.status(job.id);
      if (!status.terminal) continue;
      const uncertain = await this.deliver(job.chatId, status.text);
      if (uncertain) { job.deliveryUncertain = uncertain; await this.write("jobs", remaining); continue; }
      remaining = remaining.filter(j => j !== job);
      await this.write("jobs", remaining);
    }
  }
  async tick() {
    const offset = await this.read<number>("offset", 0);
    const updates = await this.call<TelegramUpdate[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
    for (const update of updates) {
      await this.handle(update);
      await this.write("offset", update.update_id + 1);
    }
    await this.notifyCompleted();
  }
}

let started = false;
export async function startTelegramBot() {
  if (started || process.env.MEDIA_TRACK_DEMO_MODE === "1" || process.env.TELEGRAM_ENABLED !== "1") return;
  const config = telegramConfiguration(process.env);
  if (!config) { console.warn("[telegram] 未启动：检查 token、用户白名单及网关话题/API 地址配置"); return; }
  const { token, allowed, apiRoot, routing } = config;
  const { createTelegramRuntime } = await import("./telegram-runtime");
  const bot = new TelegramBot(await createTelegramRuntime(), allowed, telegramTransport(token, fetch, { apiRoot, gateway: routing.mode === "gateway" }), routing.mode === "gateway" ? `gateway:${token}` : token, routing);
  started = true;
  const loop = async () => {
    let delay = 1000;
    try { await bot.tick(); } catch (error) { console.warn("[telegram] 本次轮询失败，稍后重试", error instanceof Error && /^Telegram (API 失败|网络连接失败)/.test(error.message) ? error.message : "凭据已隐藏"); delay = 10_000; }
    setTimeout(() => { void loop(); }, delay).unref();
  };
  void loop();
  console.log(`[telegram] ${routing.mode === "gateway" ? "网关话题" : "私聊"}机器人已启动（long polling）`);
}
