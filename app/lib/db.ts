import { neon } from "@neondatabase/serverless";

export const pool = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: async (text: string, values?: any[]) => {
    const sql = neon(process.env.DATABASE_URL!);
    const rows = await sql.query(text, values);
    return { rows };
  },
};
