process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { NextResponse } from "next/server";
import { pool } from "../../lib/db";

export async function GET() {
  try {
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
      ORDER BY floor_no DESC
    `);
    const rows = result.rows.map((r) => ({
      ...r,
      risk_level:
        Number(r.risk_pct) >= 50 ? "CRITICAL" :
        Number(r.risk_pct) >= 30 ? "HIGH" :
        Number(r.risk_pct) >= 10 ? "MEDIUM" : "LOW",
    }));
    return NextResponse.json(rows);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
