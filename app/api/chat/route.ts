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

const updateAssetStatusTool = tool(
  async ({ asset_name, status }) => {
    const result = await pool.query(
      "UPDATE building_assets SET status = $1, last_updated = CURRENT_TIMESTAMP WHERE LOWER(asset_name) = LOWER($2) RETURNING *",
      [status, asset_name]
    );

    if (result.rows.length === 0) {
      return "Asset not found.";
    }

    return `Updated ${result.rows[0].asset_name} to ${result.rows[0].status}`;
  },
  {
    name: "update_asset_status",
    description: "Update the status of a building asset",
    schema: z.object({
      asset_name: z.string(),
      status: z.string(),
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

      const toolResult = await selectedTool.invoke(call.args as any);

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