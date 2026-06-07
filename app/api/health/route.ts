import { NextResponse } from "next/server";
import { getOperationalMetrics } from "@/lib/repository";

export async function GET() {
  try {
    const metrics = await getOperationalMetrics();

    return NextResponse.json({
      ok: true,
      databaseOk: metrics.databaseOk,
      workerHealthy: metrics.workerHealthy,
      timestamp: new Date().toISOString(),
      counts: metrics.counts,
      workerHeartbeatAt: metrics.workerHeartbeatAt,
      lastMessageAt: metrics.lastMessageAt,
      lastJobAt: metrics.lastJobAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "health check failed";
    return NextResponse.json(
      {
        ok: false,
        databaseOk: false,
        workerHealthy: false,
        error: message,
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
