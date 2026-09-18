import { createHash } from "node:crypto";

export interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; text?: string; caption?: string; from?: { id: number; is_bot?: boolean }; chat: { id: number; type: string } };
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
interface Subscription { chatId: number; id: string }
interface Receipt { updateId: number; chatId: number; result: BotResult; subscribed?: boolean }
const HELP = `巡影机器人\n直接发送网盘分享链接：自动识别、转存、重命名。\n/import 链接 | 片名 | movie:157336 或 tv:1396 | s1 | storage=cs_xxx\n/get 片名：搜索并获取\n/choose 1：选择上一次的候选\n/drives：列出可用网盘\n/status：查看活动\n/status 任务ID：查看进度\n只接受授权用户的私聊。分享导入默认选同品牌唯一网盘。`;

/** Long polling needs no public port. Transport never logs the token URL. */
export function telegramTransport(token: string, fetchImpl: typeof fetch = fetch) {
  return async <T>(method: string, body: Record<string, unknown>): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(method === "getUpdates" ? 35_000 : 15_000),
      });
    } catch { throw new Error("Telegram 网络连接失败"); }
    const envelope = await response.json().catch(() => null) as { ok?: boolean; result?: T; error_code?: number } | null;
    if (!response.ok || !envelope?.ok) throw new Error(`Telegram API 失败 (${envelope?.error_code ?? response.status})`);
    return envelope.result as T;
  };
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

/** Single consumer. Offset advances only AFTER persisted result + successful
 * reply; redelivery reuses the receipt instead of repeating an acquisition. */
export class TelegramBot {
  private readonly key: string;
  constructor(private readonly runtime: TelegramRuntime, private readonly allowed: Set<number>, private readonly call: ReturnType<typeof telegramTransport>, botIdentity: string) {
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
  async handle(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message || message.chat.type !== "private" || message.from?.is_bot || !message.from || !this.allowed.has(message.from.id) || message.chat.id !== message.from.id) return;
    let receipt = await this.read<Receipt | null>("receipt", null);
    if (receipt?.updateId !== update.update_id) {
      const text = (message.text ?? message.caption ?? "").trim();
      const result = await this.command(text, message.chat.id);
      receipt = { updateId: update.update_id, chatId: message.chat.id, result };
      await this.write("receipt", receipt);
    }
    if (receipt.result.workflowRunId && !receipt.subscribed) {
      const jobs = await this.read<Subscription[]>("jobs", []);
      if (!jobs.some(j => j.chatId === receipt!.chatId && j.id === receipt!.result.workflowRunId)) {
        jobs.push({ chatId: receipt.chatId, id: receipt.result.workflowRunId });
        await this.write("jobs", jobs);
      }
      receipt.subscribed = true;
      await this.write("receipt", receipt);
    }
    await this.send(receipt.chatId, receipt.result.text);
  }
  private async command(text: string, chatId: number): Promise<BotResult> {
    if (/^\/(start|help)(?:@\w+)?$/.test(text)) return { text: HELP };
    if (/^\/drives(?:@\w+)?$/.test(text)) return { text: await this.runtime.drives() };
    const status = /^\/status(?:@\w+)?(?:\s+(\S+))?$/.exec(text);
    if (status) return this.runtime.status(status[1]);
    const choose = /^\/choose(?:@\w+)?\s+(\d+)$/.exec(text);
    let input: Record<string, unknown>;
    let kind: Pending["kind"];
    if (choose) {
      const pending = await this.read<Pending | null>(`pending_${chatId}`, null);
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
      await this.write(`pending_${chatId}`, { input, kind, candidates: result.candidates, expires: Date.now() + 86400_000 });
      result.text += "\n" + result.candidates.map((c, i) => `${i + 1}. ${c.title} (${c.year ?? "未知年份"}) [${c.type}]`).join("\n") + "\n回复 /choose 序号";
    } else if (result.workflowRunId) await this.write(`pending_${chatId}`, null);
    return result;
  }
  async notifyCompleted() {
    const jobs = await this.read<Subscription[]>("jobs", []);
    // Save after each successful delivery, so a failed later recipient doesn't
    // cause earlier notifications to be resent on every tick.
    let remaining = [...jobs];
    for (const job of jobs) {
      if (!this.allowed.has(job.chatId)) {
        remaining = remaining.filter(j => j !== job); await this.write("jobs", remaining); continue;
      }
      const status = await this.runtime.status(job.id);
      if (!status.terminal) continue;
      await this.send(job.chatId, status.text);
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
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const allowed = new Set((process.env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(",").map(s => Number(s.trim())).filter(n => Number.isSafeInteger(n) && n > 0));
  if (!token || !allowed.size) { console.warn("[telegram] 未启动：需要 Bot Token 和用户 ID 白名单"); return; }
  started = true;
  const { createTelegramRuntime } = await import("./telegram-runtime");
  const bot = new TelegramBot(await createTelegramRuntime(), allowed, telegramTransport(token), token);
  const loop = async () => {
    let delay = 1000;
    try { await bot.tick(); } catch { console.warn("[telegram] 本次轮询失败，稍后重试（凭据已隐藏）"); delay = 10_000; }
    setTimeout(() => { void loop(); }, delay).unref();
  };
  void loop();
  console.log("[telegram] 私聊机器人已启动（long polling）");
}
