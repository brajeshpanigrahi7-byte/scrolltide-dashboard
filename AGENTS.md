<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

## Project rules
- Parking logic lives in `src/lib/parking/engine.ts` as pure functions mirroring the ESP32 firmware; DEMO MODE runs it, live mode only reads Firebase `/parking` (set `VITE_FIREBASE_DB_URL`). Why: one source of truth for firmware rules, testable in `src/test/parking-engine.test.ts`.
- Dashboard shell (sidebar/topbar/provider) wraps all routes in `src/routes/__root.tsx`. Why: every page shares live state.
- Payment device APIs are TanStack server routes under `/api/public`; authenticate the device or Razorpay signature before privileged access. Why: external callers need stable secure URLs.
- `parking_sessions` payment status is server-owned; operator RLS permits read-only access and realtime refresh. Consume paid authorization with a row-locked database function. Why: duplicate callbacks or concurrent device polls must never authorize entry twice.
- Keep payment records separate from Firebase telemetry and the opt-in simulator. Why: payment authorization is not evidence that a physical gate opened.
