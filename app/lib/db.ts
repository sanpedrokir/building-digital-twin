import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

export const pool = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: async (text: string, values?: any[]) => sql.query(text, values),
};
