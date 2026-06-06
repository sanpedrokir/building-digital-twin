process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { NextResponse } from "next/server";
import { pool } from "../../lib/db";

export async function GET() {
  try {
    // Get all distinct floors
    const floorsResult = await pool.query(
      "SELECT DISTINCT floor_no FROM building_assets ORDER BY floor_no"
    );
    const floors: number[] = floorsResult.rows.map((r) => r.floor_no);

    const inserted: string[] = [];
    const skipped: string[] = [];

    for (const floor of floors) {
      for (const lift of ["Lift A", "Lift B"]) {
        const existing = await pool.query(
          "SELECT id FROM building_assets WHERE floor_no = $1 AND LOWER(asset_name) = LOWER($2)",
          [floor, lift]
        );
        if (existing.rows.length === 0) {
          await pool.query(
            "INSERT INTO building_assets (asset_name, floor_no, status, last_updated) VALUES ($1, $2, 'operational', CURRENT_TIMESTAMP)",
            [lift, floor]
          );
          inserted.push(`Floor ${floor} — ${lift}`);
        } else {
          skipped.push(`Floor ${floor} — ${lift}`);
        }
      }
    }

    return NextResponse.json({
      floors,
      inserted,
      skipped,
      message: `Done. ${inserted.length} lifts added, ${skipped.length} already existed.`,
    });
  } catch (error) {
    console.error("Seed lifts error:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
