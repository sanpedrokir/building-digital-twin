// Bypass SSL cert verification for dev environments with proxy/CA issues
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { NextResponse } from "next/server";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { pool } from "../../lib/db";

const getBuildingStatusTool = tool(
  async () => {
    const result = await pool.query(
      "SELECT * FROM building_assets ORDER BY floor_no, asset_name"
    );

    return JSON.stringify(result.rows);
  },
  {
    name: "get_building_status",
    description: "Get all building assets and their current status",
    schema: z.object({}),
  }
);

const getFaultyAssetsTool = tool(
  async () => {
    const result = await pool.query(
      "SELECT * FROM building_assets WHERE status IN ('faulty', 'maintenance') ORDER BY floor_no"
    );

    if (result.rows.length === 0) {
      return "No faulty or maintenance assets found.";
    }

    return JSON.stringify(result.rows);
  },
  {
    name: "get_faulty_assets",
    description: "Get all faulty or maintenance building assets",
    schema: z.object({}),
  }
);

const STATUS_MAP: Record<string, string> = {
  operational: "operational",
  healthy: "operational",
  ok: "operational",
  running: "operational",
  working: "operational",
  good: "operational",
  online: "operational",
  faulty: "faulty",
  broken: "faulty",
  damaged: "faulty",
  fault: "faulty",
  failed: "faulty",
  error: "faulty",
  offline: "faulty",
  maintenance: "maintenance",
  warning: "maintenance",
  repair: "maintenance",
};

// Strip punctuation, normalise whitespace, lowercase
function normalizeAssetName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

// Jaccard word-set similarity (0–1)
function wordSimilarity(a: string, b: string): number {
  const na = normalizeAssetName(a);
  const nb = normalizeAssetName(b);
  if (na === nb) return 1;
  const wordsA = new Set(na.split(" ").filter(Boolean));
  const wordsB = new Set(nb.split(" ").filter(Boolean));
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

const updateAssetStatusTool = tool(
  async ({ asset_name, status }) => {
    const normalized = STATUS_MAP[status.toLowerCase().trim()] ?? status.toLowerCase().trim();

    // Fetch all assets and find the best fuzzy match
    const allAssets = await pool.query("SELECT id, asset_name FROM building_assets");
    let matchedId: number | null = null;
    let matchedName: string | null = null;
    let bestScore = 0;

    for (const row of allAssets.rows) {
      const score = wordSimilarity(asset_name, row.asset_name);
      if (score > bestScore) {
        bestScore = score;
        matchedId = row.id;
        matchedName = row.asset_name;
      }
    }

    if (matchedId === null || bestScore < 0.4) {
      return `Asset not found. Could not find a close match for "${asset_name}".`;
    }

    const result = await pool.query(
      "UPDATE building_assets SET status = $1, last_updated = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *",
      [normalized, matchedId]
    );

    if (result.rows.length === 0) {
      return "Asset not found.";
    }

    const wasExact = normalizeAssetName(asset_name) === normalizeAssetName(matchedName ?? "");
    const note = wasExact ? "" : ` (matched to "${result.rows[0].asset_name}")`;
    return `Updated ${result.rows[0].asset_name} to ${result.rows[0].status}${note}`;
  },
  {
    name: "update_asset_status",
    description: "Update the status of a building asset. Valid status values: operational, faulty, maintenance",
    schema: z.object({
      asset_name: z.string(),
      status: z.string().describe("Use: operational, faulty, or maintenance"),
    }),
  }
);

export async function POST(req: Request) {
  try {
    const { message } = await req.json();

    const model = new ChatOpenAI({
      model: "gpt-4o-mini",
      temperature: 0,
    }).bindTools([
      getBuildingStatusTool,
      getFaultyAssetsTool,
      updateAssetStatusTool,
    ]);

    const systemPrompt = `
You are an AI Building Digital Twin Assistant.

You help users understand the current state of a building.

Use the tools when the user asks about:
- building health
- faulty assets
- asset status
- updating an asset
- simulation questions

When updating asset status, always use one of these exact values: operational, faulty, maintenance

When giving answers:
- be clear
- be short
- mention which assets need attention
- give a simple building health score out of 100 if useful

For simulation questions, use the database status first, then explain the likely operational impact.
`;

    const firstResponse = await model.invoke([
      { role: "system", content: systemPrompt },
      { role: "user", content: message },
    ]);

    const toolCalls = firstResponse.tool_calls || [];

    if (toolCalls.length === 0) {
      return NextResponse.json({
        reply: firstResponse.content,
      });
    }

    const toolMessages = [];

    for (const call of toolCalls) {
      let selectedTool;

      if (call.name === "get_building_status") {
        selectedTool = getBuildingStatusTool;
      } else if (call.name === "get_faulty_assets") {
        selectedTool = getFaultyAssetsTool;
      } else {
        selectedTool = updateAssetStatusTool;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolResult = await (selectedTool as any).invoke(call.args);

      toolMessages.push({
        role: "tool" as const,
        tool_call_id: call.id!,
        content: toolResult,
      });
    }

    const finalResponse = await model.invoke([
      { role: "system", content: systemPrompt },
      { role: "user", content: message },
      firstResponse,
      ...toolMessages,
    ]);

    return NextResponse.json({
      reply: finalResponse.content,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        reply: "Something went wrong. Check the VS Code terminal error.",
      },
      { status: 500 }
    );
  }
}