process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { NextResponse } from "next/server";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { pool } from "../../lib/db";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);
const MANAGER_EMAIL = "sanpedrobeach9@gmail.com";

const getBuildingStatusTool = tool(
  async () => {
    const result = await pool.query(
      "SELECT asset_name, floor_no, status FROM building_assets ORDER BY floor_no, asset_name"
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
      "SELECT asset_name, floor_no, status, last_updated FROM building_assets WHERE status IN ('faulty', 'maintenance') ORDER BY floor_no"
    );
    if (result.rows.length === 0) return "No faulty or maintenance assets found. Building is fully operational.";
    return JSON.stringify(result.rows);
  },
  {
    name: "get_faulty_assets",
    description: "Get all faulty or under-maintenance building assets",
    schema: z.object({}),
  }
);

const getHighEnergyAssetsTool = tool(
  async () => {
    const result = await pool.query(
      "SELECT asset_name, floor_no, energy_usage FROM building_assets WHERE energy_usage IS NOT NULL ORDER BY energy_usage DESC LIMIT 10"
    );
    if (result.rows.length === 0) return "No energy usage data available yet. Energy monitoring not yet configured.";
    return JSON.stringify(result.rows);
  },
  {
    name: "get_high_energy_assets",
    description: "Get assets with the highest energy usage",
    schema: z.object({}),
  }
);

const createMaintenanceTicketTool = tool(
  async ({ asset_name, floor_no, issue, priority }) => {
    const result = await pool.query(
      `INSERT INTO maintenance_tickets (asset_name, floor_no, issue, priority, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'open', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING *`,
      [asset_name, floor_no, issue, priority]
    );
    return `Ticket #${result.rows[0].id} created — ${asset_name} (Floor ${floor_no}): ${issue} [${priority} priority]`;
  },
  {
    name: "create_maintenance_ticket",
    description: "Create a maintenance ticket for a faulty or at-risk asset",
    schema: z.object({
      asset_name: z.string(),
      floor_no: z.number(),
      issue: z.string().describe("Description of the issue"),
      priority: z.enum(["low", "medium", "high", "critical"]),
    }),
  }
);

const getOpenTicketsTool = tool(
  async () => {
    const result = await pool.query(
      "SELECT * FROM maintenance_tickets WHERE status = 'open' ORDER BY created_at DESC"
    );
    if (result.rows.length === 0) return "No open maintenance tickets.";
    return JSON.stringify(result.rows);
  },
  {
    name: "get_open_tickets",
    description: "Get all open maintenance tickets",
    schema: z.object({}),
  }
);

const sendEmailTool = tool(
  async ({ subject, body }) => {
    const { data, error } = await resend.emails.send({
      from: "Building Agent <onboarding@resend.dev>",
      to: MANAGER_EMAIL,
      subject,
      html: `<div style="font-family: sans-serif; max-width: 600px; padding: 24px;">
        <h2 style="color: #1e40af;">🏢 Building Maintenance Report</h2>
        <pre style="background: #f3f4f6; padding: 16px; border-radius: 8px; white-space: pre-wrap; font-size: 14px;">${body}</pre>
        <p style="color: #6b7280; font-size: 12px; margin-top: 24px;">Sent by Building Maintenance Agent</p>
      </div>`,
    });
    if (error) return `Email failed: ${JSON.stringify(error)}`;
    return `Email sent to ${MANAGER_EMAIL} (ID: ${data?.id})`;
  },
  {
    name: "send_email_summary",
    description: "Send an email summary report to the building manager",
    schema: z.object({
      subject: z.string(),
      body: z.string().describe("Plain text email body"),
    }),
  }
);

const tools = [
  getBuildingStatusTool,
  getFaultyAssetsTool,
  getHighEnergyAssetsTool,
  createMaintenanceTicketTool,
  getOpenTicketsTool,
  sendEmailTool,
];

const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));

const TOOL_LABELS: Record<string, string> = {
  get_building_status: "Checking building status",
  get_faulty_assets: "Scanning for faulty assets",
  get_high_energy_assets: "Analysing energy usage",
  create_maintenance_ticket: "Creating maintenance ticket",
  get_open_tickets: "Fetching open tickets",
  send_email_summary: "Sending email report",
};

export async function POST(req: Request) {
  try {
    const { goal, history = [] } = await req.json();

    const model = new ChatOpenAI({
      model: "gpt-4o-mini",
      temperature: 0,
    }).bindTools(tools);

    const systemPrompt = `
You are an autonomous Building Maintenance Agent for a smart building management system.

Given a goal, you independently decide which tools to call and in what sequence to complete the task fully.

Your tools:
- get_building_status: full snapshot of all assets
- get_faulty_assets: only faulty/maintenance assets
- get_high_energy_assets: top energy consumers
- create_maintenance_ticket: log an issue for an asset (call once per faulty asset)
- get_open_tickets: view existing tickets
- send_email_summary: email the building manager a report

Behaviour rules:
- For risk assessment: check faulty assets first, then create tickets for each faulty asset, then send an email summary
- For ticket creation: create one ticket per asset, do not duplicate
- Always end with a concise summary of findings and actions taken
- Be efficient — avoid unnecessary repeated tool calls
- Format email bodies clearly with sections: Risk Level, Faulty Assets, Actions Taken, Recommendations
`;

    const historyMessages = (history as { role: string; content: string }[]).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let messages: any[] = [
      { role: "system", content: systemPrompt },
      ...historyMessages,
      { role: "user", content: goal },
    ];

    const steps: { tool: string; label: string; args: Record<string, unknown>; result: string }[] = [];
    const MAX_ITERATIONS = 15;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await model.invoke(messages);
      const toolCalls = response.tool_calls || [];

      if (toolCalls.length === 0) {
        return NextResponse.json({ steps, summary: response.content });
      }

      const toolMessages = [];
      for (const call of toolCalls) {
        const selectedTool = toolMap[call.name];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = selectedTool ? await (selectedTool as any).invoke(call.args) : "Tool not found.";
        const resultStr = String(result);
        steps.push({
          tool: call.name,
          label: TOOL_LABELS[call.name] ?? call.name,
          args: call.args as Record<string, unknown>,
          result: resultStr,
        });
        toolMessages.push({
          role: "tool" as const,
          tool_call_id: call.id!,
          content: resultStr,
        });
      }

      messages = [...messages, response, ...toolMessages];
    }

    return NextResponse.json({ steps, summary: "Agent completed maximum iterations." });
  } catch (error) {
    console.error("Agent error:", error);
    return NextResponse.json(
      { error: String(error), steps: [], summary: "Agent encountered an error." },
      { status: 500 }
    );
  }
}
