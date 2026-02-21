import { Hono } from "hono";
import { routeAgentRequest } from "agents";
import type { Env } from "./config";

const app = new Hono<{ Bindings: Env }>();

// --- Session API ---

app.get("/api/sessions", async (c) => {
  // List sessions - could be expanded with a registry DO
  return c.json({ sessions: [] });
});

// --- Agent WebSocket Routing ---
app.all("/agents/*", async (c) => {
  const response = await routeAgentRequest(c.req.raw, c.env);
  return response ?? new Response("Not found", { status: 404 });
});

export default app;
export { SessionAgent } from "./agents/session-agent";
