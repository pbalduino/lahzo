import { NextResponse } from "next/server";
import { getOperationalMetrics } from "@/lib/repository";

export async function GET() {
  const metrics = await getOperationalMetrics();

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    metrics,
  });
}
