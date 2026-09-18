import { connection, NextResponse, type NextRequest } from "next/server";
import { agentApiGuard } from "../../../../../../lib/agent-api/guard";
import { getOwnerAccountId } from "../../../../../../lib/agent-api/owner";
import { getWorkflowRepository } from "../../../../../../lib/workflow-runtime";
import { isDemoMode } from "../../../../../../lib/demo-mode";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  await connection();
  const denied = await agentApiGuard(request);
  if (denied) return denied;
  if (isDemoMode()) return NextResponse.json({ error: "demo 模式禁止写操作" }, { status: 403 });
  const owner = await getOwnerAccountId();
  const id = (await context.params).id;
  const repo = getWorkflowRepository();
  const snapshot = await repo.getWorkflowRunSnapshot(id, owner);
  if (!snapshot?.workflowRun.suppliedShare) return NextResponse.json({ error: "未找到导入任务" }, { status: 404 });
  const result = await repo.retryFailedWorkflowRun(id, owner);
  return NextResponse.json(result, { status: result.status === "retried" ? 202 : 409 });
}
