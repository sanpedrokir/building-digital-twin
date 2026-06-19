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

// Character-level edit distance to handle typos within a word
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
  return dp[m][n];
}

// Fuzzy similarity between two individual words (0–1)
function fuzzyWordMatch(w1: string, w2: string): number {
  if (w1 === w2) return 1;
  const maxLen = Math.max(w1.length, w2.length);
  if (maxLen === 0) return 1;
  return Math.max(0, 1 - levenshtein(w1, w2) / maxLen);
}

// Each query word finds its best fuzzy match in the asset words, averaged.
// Short identifiers (≤2 chars, e.g. "A", "B") in the DB asset name must match exactly
// in the user's input — prevents "Lift S" from matching "Lift A" or "Lift B".
function wordSimilarity(a: string, b: string): number {
  const na = normalizeAssetName(a);
  const nb = normalizeAssetName(b);
  if (na === nb) return 1;
  const wordsA = na.split(" ").filter(Boolean);
  const wordsB = nb.split(" ").filter(Boolean);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;
  for (const w of wordsB) {
    if (w.length <= 2 && !wordsA.includes(w)) return 0;
  }
  const scoreA = wordsA.map((w) => Math.max(...wordsB.map((v) => fuzzyWordMatch(w, v))));
  const scoreB = wordsB.map((w) => Math.max(...wordsA.map((v) => fuzzyWordMatch(w, v))));
  return ([...scoreA, ...scoreB].reduce((s, x) => s + x, 0)) / (scoreA.length + scoreB.length);
}

const updateAssetStatusTool = tool(
  async ({ asset_name, status, floor_no }) => {
    const normalized = STATUS_MAP[status.toLowerCase().trim()] ?? status.toLowerCase().trim();

    // Fetch all assets and find fuzzy matches
    const allAssets = await pool.query("SELECT id, asset_name, floor_no FROM building_assets");
    const threshold = 0.4;

    // Score every asset
    const scored = (allAssets.rows as { id: number; asset_name: string; floor_no: number }[])
      .map((row) => ({ ...row, score: wordSimilarity(asset_name, row.asset_name) }))
      .filter((row) => row.score >= threshold)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      return `Asset not found. Could not find a close match for "${asset_name}".`;
    }

    const topScore = scored[0].score;
    const topMatches = scored.filter((r) => r.score === topScore);

    // Multiple floors match — require floor_no to disambiguate
    if (topMatches.length > 1 && !floor_no) {
      const floors = topMatches.map((r) => r.floor_no).sort((a, b) => a - b).join(", ");
      return `"${scored[0].asset_name}" exists on multiple floors (${floors}). Please specify a floor number, e.g. "Update Lift B on floor 5 to faulty".`;
    }

    // Pick by floor if provided, otherwise take the single top match
    let target = topMatches[0];
    if (floor_no) {
      const floorMatch = scored.find((r) => r.floor_no === floor_no);
      if (!floorMatch) return `No match for "${asset_name}" on floor ${floor_no}.`;
      target = floorMatch;
    }

    const result = await pool.query(
      "UPDATE building_assets SET status = $1, last_updated = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *",
      [normalized, target.id]
    );

    if (result.rows.length === 0) return "Asset not found.";

    const updated = result.rows[0];
    const wasExact = normalizeAssetName(asset_name) === normalizeAssetName(updated.asset_name);
    const note = wasExact ? "" : ` (matched to "${updated.asset_name}")`;

    // Auto-create a ticket whenever an asset is marked faulty or maintenance
    let ticketNote = "";
    if (normalized === "faulty" || normalized === "maintenance") {
      const existing = await pool.query(
        "SELECT id FROM maintenance_tickets WHERE LOWER(asset_name) = LOWER($1) AND floor_no = $2 AND status = 'open'",
        [updated.asset_name, updated.floor_no]
      );
      if (existing.rows.length === 0) {
        const priority = updated.asset_name.toLowerCase().includes("lift") || updated.asset_name.toLowerCase().includes("fire") ? "high" : "medium";
        const ticket = await pool.query(
          `INSERT INTO maintenance_tickets (asset_name, floor_no, issue, priority, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'open', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id`,
          [updated.asset_name, updated.floor_no, `${updated.asset_name} reported as ${normalized}`, priority]
        );
        ticketNote = ` Ticket #${ticket.rows[0].id} created automatically.`;
      }
    }

    return `Updated ${updated.asset_name} on floor ${updated.floor_no} to ${updated.status}${note}.${ticketNote}`;
  },
  {
    name: "update_asset_status",
    description: "Update the status of a building asset. Valid status values: operational, faulty, maintenance. If the asset exists on multiple floors, floor_no is required.",
    schema: z.object({
      asset_name: z.string(),
      status: z.string().describe("Use: operational, faulty, or maintenance"),
      floor_no: z.number().optional().describe("Floor number — required when the asset name exists on multiple floors"),
    }),
  }
);

export async function POST(req: Request) {
  try {
    const { message, history = [] } = await req.json();

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

You help users understand and manage the current state of a building.

Use the tools when the user:
- asks about building health or asset status
- asks about faulty or maintenance assets
- wants to update an asset (commands like "update X to faulty")
- reports that an asset IS broken/damaged/faulty/not working (treat these as update requests)
- asks simulation questions

When the user says something like "X is broken", "X is not working", "X is damaged", treat it as a request to update that asset's status — call update_asset_status ONCE only.

CRITICAL RULES for update_asset_status:
- NEVER call update_asset_status more than once per user message.
- NEVER loop over floors or call the tool multiple times for the same asset.
- If the tool response says the asset exists on multiple floors, relay that message to the user and wait for them to specify a floor. Do NOT call the tool again.
- Only call the tool a second time if the user has explicitly provided a floor number in their follow-up message.

When updating asset status, always use one of these exact values: operational, faulty, maintenance.
Map user words: broken/damaged/fault/failed/error/offline → faulty, working/ok/good/running → operational, warning/repair → maintenance.

When giving answers:
- be clear and short
- confirm what was updated and on which floor
- if disambiguation is needed, ask the user which floor
`;


    const historyMessages = (history as { role: string; content: string }[]).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    const firstResponse = await model.invoke([
      { role: "system", content: systemPrompt },
      ...historyMessages,
      { role: "user", content: message },
    ]);

    const toolCalls = firstResponse.tool_calls || [];

    if (toolCalls.length === 0) {
      return NextResponse.json({
        reply: firstResponse.content,
      });
    }

    const toolMessages = [];

    // Allow only one update_asset_status call per request — drop the rest
    let updateCallSeen = false;

    for (const call of toolCalls) {
      let selectedTool;
      let toolResult: string;

      if (call.name === "get_building_status") {
        selectedTool = getBuildingStatusTool;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toolResult = await (selectedTool as any).invoke(call.args);
      } else if (call.name === "get_faulty_assets") {
        selectedTool = getFaultyAssetsTool;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toolResult = await (selectedTool as any).invoke(call.args);
      } else {
        if (updateCallSeen) {
          toolResult = "Skipped: only one asset update is allowed per message. Ask the user to specify the floor.";
        } else {
          updateCallSeen = true;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          toolResult = await (updateAssetStatusTool as any).invoke(call.args);
        }
      }

      toolMessages.push({
        role: "tool" as const,
        tool_call_id: call.id!,
        content: toolResult,
      });
    }

    const finalResponse = await model.invoke([
      { role: "system", content: systemPrompt },
      ...historyMessages,
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
