process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { NextResponse } from "next/server";
import { runAgent } from "../route";

const DAILY_GOAL =
  "Perform a full daily building assessment: " +
  "1) Check all faulty assets. " +
  "2) Calculate floor risk scores. " +
  "3) Identify repeat offenders. " +
  "4) Create tickets for any faulty assets that don't have an open ticket. " +
  "5) Update each ticketed faulty asset status to maintenance. " +
  "6) Send a comprehensive email report to the manager with risk level, " +
  "all faulty assets, floor risk scores, actions taken, and recommendations.";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const secret = searchParams.get("secret");

    if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await runAgent(DAILY_GOAL);

    return NextResponse.json({
      status: "completed",
      steps_taken: result.steps.length,
      summary: result.summary,
      ran_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Scheduled agent error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
