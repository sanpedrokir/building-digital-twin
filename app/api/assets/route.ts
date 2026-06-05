process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { NextResponse } from "next/server";
import { pool } from "../../lib/db";

export async function GET() {
  try {
    const result = await pool.query(
      "SELECT * FROM building_assets ORDER BY floor_no, asset_name"
    );
    return NextResponse.json(result.rows);
  } catch (error) {
    console.error("Assets fetch error:", error);
    return NextResponse.json([], { status: 500 });
  }
}
