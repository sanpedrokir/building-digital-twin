process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { NextResponse } from "next/server";
import { pool } from "../../lib/db";

export async function GET() {
  try {
    const result = await pool.query(
      "SELECT * FROM maintenance_tickets ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, created_at DESC"
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
    return NextResponse.json(result.rows[0]);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
