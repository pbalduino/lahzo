import { NextResponse } from "next/server";
import { listConversations } from "@/lib/repository";

export async function GET() {
  return NextResponse.json({ conversations: await listConversations() });
}
