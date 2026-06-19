process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { NextResponse } from "next/server";
import { pool } from "../../lib/db";

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS floor_occupancy (
      floor_no       INTEGER PRIMARY KEY,
      occupancy_count INTEGER NOT NULL DEFAULT 0,
      last_updated   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const count = await pool.query("SELECT COUNT(*) FROM floor_occupancy");
  if (parseInt(count.rows[0].count) === 0) {
    const floors = await pool.query(
      "SELECT DISTINCT floor_no FROM building_assets ORDER BY floor_no"
    );
    for (const row of floors.rows as { floor_no: number }[]) {
      // Deterministic seed: ground floors busier, upper floors quieter
      const occupancy = Math.max(5, 28 - row.floor_no);
      await pool.query(
        "INSERT INTO floor_occupancy (floor_no, occupancy_count) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [row.floor_no, occupancy]
      );
    }
  }
}

export async function GET() {
  try {
    await ensureTable();
    const result = await pool.query(
      "SELECT floor_no, occupancy_count, last_updated FROM floor_occupancy ORDER BY floor_no"
    );
    return NextResponse.json(result.rows);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    await ensureTable();
    const { floor_no, occupancy_count } = await req.json();
    const result = await pool.query(
      `INSERT INTO floor_occupancy (floor_no, occupancy_count, last_updated)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (floor_no) DO UPDATE
         SET occupancy_count = $2, last_updated = CURRENT_TIMESTAMP
       RETURNING *`,
      [floor_no, occupancy_count]
    );
    return NextResponse.json(result.rows[0]);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
