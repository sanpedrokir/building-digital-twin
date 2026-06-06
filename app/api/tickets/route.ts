process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { NextResponse } from "next/server";
import { pool } from "../../lib/db";

export async function GET() {
  try {
    const result = await pool.query(
      "SELECT * FROM maintenance_tickets ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, created_at ASC"
    );
    return NextResponse.json(result.rows);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const { id, status, resolution } = await req.json();
    const result = await pool.query(
      "UPDATE maintenance_tickets SET status = $1, issue = issue || $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *",
      [status, resolution ? ` | Resolved: ${resolution}` : "", id]
    );
    const ticket = result.rows[0];
    if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

    // When closing a ticket, restore the asset to operational
    if (status === "closed") {
      await pool.query(
        "UPDATE building_assets SET status = 'operational', last_updated = CURRENT_TIMESTAMP WHERE LOWER(asset_name) = LOWER($1) AND floor_no = $2",
        [ticket.asset_name, ticket.floor_no]
      );
    }

    return NextResponse.json(ticket);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
