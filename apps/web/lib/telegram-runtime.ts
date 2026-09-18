import { getWorkflowRepository } from "./workflow-runtime";
import { getOwnerAccountId } from "./agent-api/owner";
import { acquireMedia, type AcquireInput } from "./agent-api/acquire";
import { importShare, ImportRequestError } from "./share-import";
import type { TelegramRuntime } from "./telegram-bot";

export async function createTelegramRuntime(): Promise<TelegramRuntime> {
  const repo = getWorkflowRepository();
  const owner = await getOwnerAccountId();
  return {
    get: key => repo.getAccountSetting(owner, key),
    set: (key, value) => repo.setAccountSetting(owner, key, value),
    async importShare(input) {
      try {
        const result = await importShare(input, owner);
        return { text: `${result.title}：${result.workflowStatus}\n任务：${result.workflowRunId}`, workflowRunId: result.workflowRunId };
      } catch (error) {
        if (error instanceof ImportRequestError) return { text: error.message, ...(Array.isArray(error.details.candidates) ? { candidates: error.details.candidates } : {}) };
        return { text: "导入暂时失败，请检查网盘/元数据配置后重试。" };
      }
    },
    async acquire(input) {
      try {
        const result = await acquireMedia(input as unknown as AcquireInput, owner);
        return { text: result.message, ...(result.workflowRunId ? { workflowRunId: result.workflowRunId } : {}), ...(result.candidates ? { candidates: result.candidates } : {}) };
      } catch { return { text: "获取请求失败，请检查服务配置后重试。" }; }
    },
    async drives() {
      const drives = await repo.listConnectedStorages(owner);
      return drives.map(d => `${d.label ?? d.provider} (${d.status})\n${d.id}`).join("\n\n") || "尚未连接网盘，请先在网页设置中添加。";
    },
    async status(id) {
      if (!id) {
        const runs = await repo.listActiveWorkflowRuns(owner);
        return { text: runs.map(r => `${r.title.title}：${r.workflowRun.status}\n${r.workflowRun.id}`).join("\n\n") || "当前没有运行中的任务。" };
      }
      const run = await repo.getWorkflowRunSnapshot(id, owner);
      if (!run) return { text: `任务 ${id} 不存在或已清理。`, terminal: true };
      const status = run.workflowRun.status;
      return { text: `${run.title.title}：${status}\n${id}\n${run.notifications.map(n => n.body).join("\n")}`, terminal: !["queued", "running", "reserved"].includes(status) };
    },
  };
}
