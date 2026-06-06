# Building Digital Twin — Dev Log & Error Fixes

## Project Overview
AI-powered building digital twin built with Next.js 16, LangChain, OpenAI GPT-4o-mini, Neon PostgreSQL, and deployed on AWS Amplify.

---

## 1. Local Dev Setup

### Error: `npm error Missing script: "dev"`
**Cause:** Running `npm run dev` from the parent folder `C:\3Vibe1\digitaltwin` instead of the actual Next.js project folder.

**Fix:** Added a `package.json` in the parent directory to delegate to the correct subfolder:
```json
{
  "scripts": {
    "dev": "npm run dev --prefix building-digital-twin",
    "build": "npm run build --prefix building-digital-twin",
    "start": "npm run start --prefix building-digital-twin"
  }
}
```
Now `npm run dev` works from `C:\3Vibe1\digitaltwin`.

---

## 2. Default Next.js Boilerplate Page

**Problem:** `http://localhost:3000` showed the default Next.js starter page ("To get started, edit the page.tsx file") instead of the app.

**Cause:** `app/page.tsx` had never been customised — it still contained the boilerplate template.

**Fix:** Replaced `app/page.tsx` with the full Building Digital Twin dashboard:
- Left panel: Building Status with floor-by-floor asset cards, health score, colour-coded indicators
- Right panel: AI chat interface with suggested questions and prominent text input
- Clickable asset cards that open a live SVG illustration modal (lift, HVAC, generic)

---

## 3. SSL Certificate Error (Local Windows Dev)

### Error:
```
Error: unable to verify the first certificate
code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
```
**Cause:** Node.js on Windows could not verify the OpenAI API SSL certificate — common on Windows machines where the system CA store is not used by Node by default.

**Fix:** Added at the top of `app/api/chat/route.ts` and `app/api/assets/route.ts`:
```typescript
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
```
> **Note:** This disables SSL verification. For local dev only — on AWS (Amplify) this is not needed but causes no harm.

---

## 4. Building Panel Stuck on "Loading assets..."

**Cause:** `fetchAssets()` in `page.tsx` was calling `/api/chat` with the message `"get building status"` and then trying to `JSON.parse(data.reply)`. The AI model returns natural language text, not raw JSON, so the parse always failed silently.

**Fix:** Created a dedicated `app/api/assets/route.ts` endpoint that queries the database directly and returns raw JSON:
```typescript
export async function GET() {
  const result = await pool.query(
    "SELECT * FROM building_assets ORDER BY floor_no, asset_name"
  );
  return NextResponse.json(result.rows);
}
```
Then updated `fetchAssets()` in `page.tsx` to call `/api/assets` (GET) instead.

---

## 5. Asset Visual Illustrations

Added SVG-based live illustrations for assets that update in real time based on database status:

| Asset Type | Detection | Visual |
|------------|-----------|--------|
| Lift/Elevator | name contains "lift" or "elevator" | Elevator shaft with animated doors, status panel, floor lights |
| HVAC | name contains "hvac", "air", "fan", "cool" | Spinning fan blades with vent slats |
| Others | all other assets | Generic icon with status colour |

**Status visuals:**
- `operational` → Green, closed doors, spinning fan, upward arrows
- `faulty` → Red, stuck-open doors, pulsing alert ring, warning triangle
- `maintenance` → Amber, half-open doors, wrench icon

Click any asset card in the left panel to open the illustration modal.

---

## 6. GitHub Push

```bash
cd building-digital-twin
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/sanpedrokir/building-digital-twin.git
git branch -M main
git push -u origin main
```
> `.gitignore` already excluded `node_modules`, `.next`, and `.env*` — API keys were never committed.

---

## 7. AWS Amplify Deployment

### Setup
1. AWS Console → Amplify → Create new app → GitHub → select `building-digital-twin` repo → branch `main`
2. Add environment variables (from `.env.local`):
   - `OPENAI_API_KEY`
   - `DATABASE_URL`
   - `LANGSMITH_API_KEY`
   - `LANGSMITH_TRACING` = `true`
   - `LANGSMITH_PROJECT` = `building-digital-twin`
   - `LANGSMITH_ENDPOINT` = `https://api.smith.langchain.com`
   - `NODE_TLS_REJECT_UNAUTHORIZED` = `0`

---

## 8. Amplify Build Error 1 — TypeScript Type Error

### Error:
```
Type error: This expression is not callable.
./app/api/chat/route.ts:127:45
Each member of the union type ... has signatures, but none of those signatures are compatible with each other.
```
**Cause:** TypeScript strict mode in production build rejected calling `selectedTool.invoke()` on a union type of three different tool objects.

**Fix:** Cast `selectedTool` to `any` before calling `.invoke()`:
```typescript
// Before
const toolResult = await selectedTool.invoke(call.args as any);

// After
const toolResult = await (selectedTool as any).invoke(call.args);
```

---

## 9. Amplify Runtime Error — Database 500s

### Error (from browser Network tab):
```json
{
  "error": "Error: No database connection string was provided to `neon()`. Perhaps an environment variable has not been set?"
}
```
**Cause:** Amplify stores environment variables in AWS SSM Parameter Store. During the build, the log showed:
```
[WARNING]: !Failed to set up process.env.secrets
```
This means Amplify's SSM injection failed silently, so `DATABASE_URL` and other secrets were not available to the Lambda (SSR) functions at runtime.

**Fix 1 — Switch to Neon serverless driver:**

Replaced `pg` (TCP-based, needs WebSocket config in Lambda) with `@neondatabase/serverless` (HTTP-based, works natively in serverless):
```bash
npm install @neondatabase/serverless
```

**Fix 2 — Correct the `db.ts` wrapper:**

The `neon()` function returns rows directly as an array, not `{ rows: [] }`. Wrapped it to match the existing `pool.query()` interface:
```typescript
// app/lib/db.ts
import { neon } from "@neondatabase/serverless";

export const pool = {
  query: async (text: string, values?: any[]) => {
    const sql = neon(process.env.DATABASE_URL!);
    const rows = await sql.query(text, values);
    return { rows };
  },
};
```
> `neon()` is initialised inside the function (not at module level) so `DATABASE_URL` is read at query time, not at cold-start module load.

**Fix 3 — Write env vars to `.env.production` at build time:**

Updated `amplify.yml` to generate `.env.production` during the preBuild phase using the Amplify console env vars. This bypasses the broken SSM injection and embeds the values into the Next.js Lambda bundle:

```yaml
version: 1
frontend:
  phases:
    preBuild:
      commands:
        - |
          cat > .env.production << EOF
          DATABASE_URL=$DATABASE_URL
          OPENAI_API_KEY=$OPENAI_API_KEY
          LANGSMITH_API_KEY=$LANGSMITH_API_KEY
          LANGSMITH_TRACING=$LANGSMITH_TRACING
          LANGSMITH_PROJECT=$LANGSMITH_PROJECT
          LANGSMITH_ENDPOINT=$LANGSMITH_ENDPOINT
          NODE_TLS_REJECT_UNAUTHORIZED=0
          EOF
        - npm ci
    build:
      commands:
        - npm run build
  artifacts:
    baseDirectory: .next
    files:
      - '**/*'
  cache:
    paths:
      - node_modules/**/*
      - .next/cache/**/*
```

---

## 10. Amplify Build Error 2 — TypeScript on `result.rows`

### Error:
```
Type error: Property 'rows' does not exist on type 'Record<string, any>[]'.
./app/api/assets/route.ts:11:37
```
**Cause:** `sql.query()` from `@neondatabase/serverless` returns `T[]` (a plain array), not `{ rows: T[] }`. The route was accessing `result.rows` which didn't exist.

**Fix:** Wrapped the result in `{ rows }` inside `db.ts` (see Fix 2 above). This keeps all existing `result.rows` references in the route files working without changes.

---

## 11. Final Working State

| Feature | Status |
|---------|--------|
| Local dev (`npm run dev`) | ✅ Working from parent directory |
| Building panel with assets | ✅ Loads from `/api/assets` directly |
| AI chat assistant | ✅ GPT-4o-mini with LangChain tools |
| Asset SVG visualisations | ✅ Click any asset to see live visual |
| GitHub repo | ✅ `github.com/sanpedrokir/building-digital-twin` |
| AWS Amplify deployment | ✅ `https://main.d1yecyqv2nozog.amplifyapp.com` |
| Database (Neon PostgreSQL) | ✅ Connected via `@neondatabase/serverless` |
| Auto-deploy on git push | ✅ Amplify watches `main` branch |

---

## Key Lessons

1. **Run `npm run dev` from the correct subfolder** — or add a delegating `package.json` in the parent.
2. **AI chat returns text, not JSON** — always use a dedicated API endpoint for structured data fetches.
3. **`@neondatabase/serverless` vs `pg`** — use `@neondatabase/serverless` for Lambda/serverless environments; `pg` requires WebSocket config.
4. **Amplify SSM injection can silently fail** — use `amplify.yml` preBuild to write env vars to `.env.production` as a reliable fallback.
5. **`neon()` returns `T[]` not `{ rows: T[] }`** — wrap with `{ rows }` to match the standard `pool.query()` interface.
6. **TypeScript is strict in production builds** — union type `.invoke()` calls must be cast to `any`.
