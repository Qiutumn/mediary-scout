import { connection, NextResponse, type NextRequest } from "next/server";
import { agentApiGuard } from "../../../../lib/agent-api/guard";
import { getOwnerAccountId } from "../../../../lib/agent-api/owner";
import { importShare, ImportRequestError } from "../../../../lib/share-import";
import { isDemoMode } from "../../../../lib/demo-mode";

export async function POST(request: NextRequest) {
  await connection();
  const denied = await agentApiGuard(request);
  if (denied) return denied;
  if (isDemoMode()) return NextResponse.json({ error: "demo 模式禁止写操作" }, { status: 403 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 }); }
  try {
    const result = await importShare(body, await getOwnerAccountId());
    return NextResponse.json(result, { status: result.status === "queued" ? 202 : 200 });
  } catch (error) {
    if (error instanceof ImportRequestError) return NextResponse.json({ error: error.message, ...error.details }, { status: error.status });
    // Raw provider errors may embed credentials. Keep these out of responses/logs.
    return NextResponse.json({ error: "导入请求失败，请检查网盘和元数据服务后重试。" }, { status: 502 });
  }
}
