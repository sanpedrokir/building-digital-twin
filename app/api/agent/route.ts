process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { NextResponse } from "next/server";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { pool } from "../../lib/db";
import { Resend } from "resend";

export const MANAGER_EMAIL = "sanpedrobeach9@gmail.com";

const resend = new Resend(process.env.RESEND_API_KEY);

// ── Status helpers ────────────────────────────────────────────────────────────

const STATUS_MAP: Record<string, string> = {
  operational: "operational", healthy: "operational", ok: "operational",
  working: "operational", good: "operational", online: "operational",
  faulty: "faulty", broken: "faulty", damaged: "faulty", fault: "faulty",
  failed: "faulty", error: "faulty", offline: "faulty",
  maintenance: "maintenance", warning: "maintenance", repair: "maintenance",
};

// ── Tools ─────────────────────────────────────────────────────────────────────

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
    if (result.rows.length === 0) return "No faulty or maintenance assets. Building fully operational.";
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
    if (result.rows.length === 0) return "No energy usage data available yet.";
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
    // Check for existing open ticket to avoid duplicates
    const existing = await pool.query(
      "SELECT id FROM maintenance_tickets WHERE LOWER(asset_name) = LOWER($1) AND floor_no = $2 AND status = 'open'",
      [asset_name, floor_no]
    );
    if (existing.rows.length > 0) {
      return `Ticket already exists for ${asset_name} on floor ${floor_no} (Ticket #${existing.rows[0].id}) — skipped.`;
    }
    const result = await pool.query(
      `INSERT INTO maintenance_tickets (asset_name, floor_no, issue, priority, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'open', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING *`,
      [asset_name, floor_no, issue, priority]
    );
    return `Ticket #${result.rows[0].id} created — ${asset_name} (Floor ${floor_no}): ${issue} [${priority} priority]`;
  },
  {
    name: "create_maintenance_ticket",
    description: "Create a maintenance ticket for a faulty asset. Automatically skips if an open ticket already exists.",
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
      "SELECT * FROM maintenance_tickets WHERE status = 'open' ORDER BY priority DESC, created_at DESC"
    );
    if (result.rows.length === 0) return "No open maintenance tickets.";
    return JSON.stringify(result.rows);
  },
  {
    name: "get_open_tickets",
    description: "Get all open maintenance tickets ordered by priority",
    schema: z.object({}),
  }
);

const updateAssetStatusTool = tool(
  async ({ asset_name, floor_no, status }) => {
    const normalized = STATUS_MAP[status.toLowerCase()] ?? status.toLowerCase();

    // Validate: asset name must exactly match a real asset in the database
    const check = await pool.query(
      "SELECT asset_name, floor_no FROM building_assets WHERE LOWER(asset_name) = LOWER($1)",
      [asset_name]
    );
    if (check.rows.length === 0) {
      const all = await pool.query("SELECT DISTINCT asset_name FROM building_assets ORDER BY asset_name");
      const valid = (all.rows as { asset_name: string }[]).map((r) => r.asset_name).join(", ");
      return `ERROR: Asset "${asset_name}" does not exist. Valid asset names are: ${valid}. Do NOT update assets that are not in this list.`;
    }

    const result = await pool.query(
      "UPDATE building_assets SET status = $1, last_updated = CURRENT_TIMESTAMP WHERE LOWER(asset_name) = LOWER($2) AND floor_no = $3 RETURNING *",
      [normalized, asset_name, floor_no]
    );
    if (result.rows.length === 0) {
      const floors = (check.rows as { floor_no: number }[]).map((r) => r.floor_no).join(", ");
      return `Asset "${asset_name}" not found on floor ${floor_no}. It exists on floor(s): ${floors}.`;
    }
    return `Updated ${result.rows[0].asset_name} on floor ${floor_no} to ${normalized}`;
  },
  {
    name: "update_asset_status",
    description: "Update the status of a specific asset on a specific floor (operational, faulty, maintenance)",
    schema: z.object({
      asset_name: z.string(),
      floor_no: z.number(),
      status: z.enum(["operational", "faulty", "maintenance"]),
    }),
  }
);

const closeTicketTool = tool(
  async ({ ticket_id, resolution }) => {
    const result = await pool.query(
      "UPDATE maintenance_tickets SET status = 'closed', issue = issue || $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *",
      [` | Resolved: ${resolution}`, ticket_id]
    );
    if (result.rows.length === 0) return `Ticket #${ticket_id} not found.`;
    return `Ticket #${ticket_id} closed — ${result.rows[0].asset_name} (Floor ${result.rows[0].floor_no}). Resolution: ${resolution}`;
  },
  {
    name: "close_ticket",
    description: "Close a maintenance ticket when the issue has been resolved",
    schema: z.object({
      ticket_id: z.number(),
      resolution: z.string().describe("Brief description of how the issue was resolved"),
    }),
  }
);

const getFloorRiskScoresTool = tool(
  async () => {
    const result = await pool.query(`
      SELECT
        floor_no,
        COUNT(*) AS total_assets,
        COUNT(*) FILTER (WHERE status = 'faulty') AS faulty_count,
        COUNT(*) FILTER (WHERE status = 'maintenance') AS maintenance_count,
        ROUND(
          (COUNT(*) FILTER (WHERE status IN ('faulty','maintenance'))::numeric / COUNT(*)) * 100, 1
        ) AS risk_pct
      FROM building_assets
      GROUP BY floor_no
      ORDER BY risk_pct DESC, floor_no
    `);
    const rows = result.rows.map((r) => ({
      ...r,
      risk_level:
        Number(r.risk_pct) >= 50 ? "CRITICAL" :
        Number(r.risk_pct) >= 30 ? "HIGH" :
        Number(r.risk_pct) >= 10 ? "MEDIUM" : "LOW",
    }));
    return JSON.stringify(rows);
  },
  {
    name: "get_floor_risk_scores",
    description: "Calculate risk score and level (LOW/MEDIUM/HIGH/CRITICAL) per floor",
    schema: z.object({}),
  }
);

const getRepeatOffendersTool = tool(
  async () => {
    const result = await pool.query(`
      SELECT asset_name, floor_no, COUNT(*) AS ticket_count,
             MAX(created_at) AS last_ticket_date
      FROM maintenance_tickets
      GROUP BY asset_name, floor_no
      HAVING COUNT(*) > 1
      ORDER BY ticket_count DESC
      LIMIT 10
    `);
    if (result.rows.length === 0) return "No repeat offenders found — no asset has had more than one ticket.";
    return JSON.stringify(result.rows);
  },
  {
    name: "get_repeat_offenders",
    description: "Find assets that have had multiple maintenance tickets — persistent problem assets",
    schema: z.object({}),
  }
);

const sendEmailTool = tool(
  async ({ subject, body }) => {
    const riskColor = body.includes("CRITICAL") ? "#dc2626" :
                      body.includes("HIGH") ? "#ea580c" :
                      body.includes("MEDIUM") ? "#d97706" : "#16a34a";

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:sans-serif;">
  <div style="max-width:640px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1);">
    <div style="background:#1e3a5f;padding:24px 32px;">
      <h1 style="margin:0;color:#ffffff;font-size:20px;">🏢 Building Maintenance Report</h1>
      <p style="margin:4px 0 0;color:#93c5fd;font-size:13px;">${new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" })}</p>
    </div>
    <div style="padding:32px;">
      <div style="background:#f8fafc;border-left:4px solid ${riskColor};padding:16px 20px;border-radius:0 8px 8px 0;margin-bottom:24px;">
        <p style="margin:0;color:${riskColor};font-weight:bold;font-size:15px;">
          ${body.includes("CRITICAL") ? "⛔ CRITICAL RISK" :
            body.includes("HIGH") ? "🔴 HIGH RISK" :
            body.includes("MEDIUM") ? "🟠 MEDIUM RISK" : "🟢 LOW RISK"}
        </p>
      </div>
      <div style="white-space:pre-wrap;font-size:14px;color:#374151;line-height:1.7;background:#f9fafb;padding:20px;border-radius:8px;border:1px solid #e5e7eb;">
${body}
      </div>
    </div>
    <div style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb;">
      <p style="margin:0;font-size:12px;color:#6b7280;">Sent automatically by Building Maintenance Agent · MN Building Digital Twin</p>
    </div>
  </div>
</body>
</html>`;

    const { data, error } = await resend.emails.send({
      from: "Building Agent <onboarding@resend.dev>",
      to: MANAGER_EMAIL,
      subject,
      html,
    });
    if (error) return `Email failed: ${JSON.stringify(error)}`;
    return `Email sent to ${MANAGER_EMAIL} (ID: ${data?.id})`;
  },
  {
    name: "send_email_summary",
    description: "Send a formatted HTML email report to the building manager",
    schema: z.object({
      subject: z.string(),
      body: z.string().describe("Structured plain-text body with sections: Risk Level, Faulty Assets, Floor Risk Scores, Actions Taken, Recommendations"),
    }),
  }
);

const getFloorOccupancyTool = tool(
  async () => {
    const result = await pool.query(
      "SELECT floor_no, occupancy_count, last_updated FROM floor_occupancy ORDER BY floor_no"
    );
    if (result.rows.length === 0) return "No occupancy data available. The floor_occupancy table may not be seeded yet.";
    const total = (result.rows as { floor_no: number; occupancy_count: number }[])
      .reduce((sum, r) => sum + r.occupancy_count, 0);
    return JSON.stringify({ total_occupancy: total, floors: result.rows });
  },
  {
    name: "get_floor_occupancy",
    description: "Get the number of people currently on each floor — critical during fire evacuation to identify who may be trapped or stuck",
    schema: z.object({}),
  }
);

const updateFloorOccupancyTool = tool(
  async ({ floor_no, occupancy_count }) => {
    const result = await pool.query(
      `INSERT INTO floor_occupancy (floor_no, occupancy_count, last_updated)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (floor_no) DO UPDATE
         SET occupancy_count = $2, last_updated = CURRENT_TIMESTAMP
       RETURNING *`,
      [floor_no, occupancy_count]
    );
    return `Floor ${floor_no} occupancy updated to ${result.rows[0].occupancy_count} people.`;
  },
  {
    name: "update_floor_occupancy",
    description: "Update the number of people on a specific floor — use when someone reports people stuck on a floor during evacuation",
    schema: z.object({
      floor_no: z.number(),
      occupancy_count: z.number().describe("Number of people currently on this floor"),
    }),
  }
);

// ── Tool registry ─────────────────────────────────────────────────────────────

export const agentTools = [
  getBuildingStatusTool,
  getFaultyAssetsTool,
  getHighEnergyAssetsTool,
  createMaintenanceTicketTool,
  getOpenTicketsTool,
  updateAssetStatusTool,
  closeTicketTool,
  getFloorRiskScoresTool,
  getRepeatOffendersTool,
  sendEmailTool,
  getFloorOccupancyTool,
  updateFloorOccupancyTool,
];

const toolMap = Object.fromEntries(agentTools.map((t) => [t.name, t]));

export const TOOL_LABELS: Record<string, string> = {
  get_building_status: "Checking building status",
  get_faulty_assets: "Scanning for faulty assets",
  get_high_energy_assets: "Analysing energy usage",
  create_maintenance_ticket: "Creating maintenance ticket",
  get_open_tickets: "Fetching open tickets",
  update_asset_status: "Updating asset status",
  close_ticket: "Closing resolved ticket",
  get_floor_risk_scores: "Calculating floor risk scores",
  get_repeat_offenders: "Scanning repeat offenders",
  send_email_summary: "Sending email report",
  get_floor_occupancy: "Checking floor occupancy",
  update_floor_occupancy: "Updating floor occupancy",
};

export const AGENT_SYSTEM_PROMPT = `
You are an autonomous Building Maintenance Agent for a smart 20-floor building management system.
You have FULL ability to send emails using the send_email_summary tool. NEVER say you cannot send emails.

Given a goal, you IMMEDIATELY start calling tools. NEVER ask for permission. NEVER ask clarifying questions. NEVER say "would you like me to..." — just do it.

Given a goal, you independently decide which tools to call and in what sequence.

Your tools:
- get_building_status: full snapshot of all assets
- get_faulty_assets: only faulty/maintenance assets
- get_high_energy_assets: top energy consumers
- create_maintenance_ticket: log a new issue (auto-skips duplicates)
- get_open_tickets: view existing open tickets
- update_asset_status: change an asset status (e.g. faulty → maintenance when ticketed)
- close_ticket: close a resolved ticket
- get_floor_risk_scores: risk level per floor (LOW/MEDIUM/HIGH/CRITICAL)
- get_repeat_offenders: assets with multiple historical tickets
- send_email_summary: YOU MUST call this tool to send emails — it delivers real emails instantly
- get_floor_occupancy: number of people currently on each floor (use during fire/evacuation emergencies)
- update_floor_occupancy: update the headcount for a floor (use when someone reports people stuck on a floor)

CRITICAL RULES:
- When the user asks to send an email or report: ALWAYS call send_email_summary — never refuse, never say you cannot
- Always gather data first (get_faulty_assets, get_floor_risk_scores), then call send_email_summary with a structured body
- For risk assessments: get_faulty_assets → get_floor_risk_scores → get_repeat_offenders → create tickets → update statuses → send_email_summary
- When creating a ticket for a faulty asset, also update its status to "maintenance"
- Prioritise: assets affecting lifts or fire safety are CRITICAL
- Cascade risk: if both Lift A and Lift B are faulty on the same floor → flag floor isolation risk
- Be efficient — do not repeat tool calls
- NEVER invent or assume asset names. Only use asset names that are confirmed to exist in the database. If update_asset_status returns an ERROR, stop immediately and tell the user which valid asset names exist — do NOT retry with a made-up name.
- For FIRE EMERGENCY goals: always call get_floor_occupancy AND get_faulty_assets AND get_floor_risk_scores. Cross-reference: floors with high occupancy AND high risk are the most critical to evacuate first.

Email body format (use this structure):
RISK LEVEL: [LOW/MEDIUM/HIGH/CRITICAL]
BUILDING HEALTH: [X/100]

FAULTY ASSETS:
- [asset name] — Floor [X] — [status]

FLOOR RISK SCORES:
- Floor [X]: [LEVEL] ([Y]% affected)

ACTIONS TAKEN:
- [what the agent did]

RECOMMENDATIONS:
- [what should be done next]
`;

// ── Route handler ─────────────────────────────────────────────────────────────

export async function runAgent(goal: string, history: { role: string; content: string }[] = []) {
  const model = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 }).bindTools(agentTools);

  const historyMessages = history.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let messages: any[] = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    ...historyMessages,
    { role: "user", content: goal },
  ];

  const steps: { tool: string; label: string; args: Record<string, unknown>; result: string }[] = [];

  for (let i = 0; i < 20; i++) {
    const response = await model.invoke(messages);
    const toolCalls = response.tool_calls || [];

    if (toolCalls.length === 0) {
      return { steps, summary: String(response.content) };
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
      toolMessages.push({ role: "tool" as const, tool_call_id: call.id!, content: resultStr });
    }

    messages = [...messages, response, ...toolMessages];
  }

  return { steps, summary: "Agent completed maximum iterations." };
}

export async function POST(req: Request) {
  try {
    const { goal, history = [] } = await req.json();
    const result = await runAgent(goal, history);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Agent error:", error);
    return NextResponse.json(
      { error: String(error), steps: [], summary: "Agent encountered an error." },
      { status: 500 }
    );
  }
}
