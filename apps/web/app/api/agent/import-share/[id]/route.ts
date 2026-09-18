import { connection, NextResponse, type NextRequest } from "next/server";
import { agentApiGuard } from "../../../../../lib/agent-api/guard";
import { getOwnerAccountId } from "../../../../../lib/agent-api/owner";
import { shareImportStatus, ImportRequestError } from "../../../../../lib/share-import";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  await connection();
  const denied = await agentApiGuard(request);
  if (denied) return denied;
  try { return NextResponse.json(await shareImportStatus((await context.params).id, await getOwnerAccountId())); }
  catch (error) {
    return NextResponse.json({ error: error instanceof ImportRequestError ? error.message : "读取失败" }, { status: error instanceof ImportRequestError ? error.status : 500 });
  }
}
