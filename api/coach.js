// AI Coach endpoint. The browser sends the open case as text plus the chat so far;
// the Anthropic key stays here on the server (Vercel env var ANTHROPIC_API_KEY).
import Anthropic from "@anthropic-ai/sdk";

// Public Firebase web key (the same one index.html ships). Used only to check that
// the caller is a signed-in user of this app, so strangers can't spend the API key.
const FIREBASE_WEB_KEY = "AIzaSyAT7nz8ykMO-P08fhb7lWsoh93vjcH8BsU";

const SYSTEM = `You are the coach inside Problem Solving Lab, an app that guides people through an 8-step method for messy, real-world problems:
1 Problem (problem statement, SMART), 2 Approach (Cynefin domain), 3 System (iceberg model and causal loop diagram),
4 Causes (fishbone, 5 whys), 5 Leverage (Meadows' 12 places to intervene), 6 Experiments (hypothesis, prediction, PDIA/PDCA iterations),
7 Tasks, 8 Report. PDIA (Problem-Driven Iterative Adaptation) is one of the methods, alongside systems thinking and the scientific method.

The user's current case is below. Coach them on this case: refer to their own data, point out gaps or weak spots, and suggest the next concrete step and which step of the app to do it in.
Many users are government officers and district teams, so keep the language plain and practical. Use short paragraphs or short bullet lists, and keep answers under about 250 words unless the user asks for more.`;

const client = new Anthropic();

async function signedIn(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: token }),
  });
  if (!r.ok) return false;
  const data = await r.json();
  return Array.isArray(data.users) && data.users.length > 0;
}

// Keep the last few turns, alternating user/assistant and starting with the user.
function cleanMessages(list) {
  const out = [];
  for (const m of Array.isArray(list) ? list.slice(-12) : []) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") continue;
    const content = m.content.slice(0, 4000).trim();
    if (!content) continue;
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += "\n\n" + content;
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out.length && out[out.length - 1].role === "user" ? out : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: "not_configured" });
  if (!(await signedIn(req))) return res.status(401).json({ error: "sign_in_required" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const messages = cleanMessages(body.messages);
  if (!messages) return res.status(400).json({ error: "bad_request" });
  const caseText = typeof body.context === "string" ? body.context.slice(0, 20000) : "";

  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: `${SYSTEM}\n\n<case>\n${caseText || "The user has not filled in anything yet."}\n</case>`,
      messages,
    });
    if (response.stop_reason === "refusal") {
      return res.status(200).json({ text: "Sorry, I can't help with that one. Try asking about your problem, causes, or next experiment." });
    }
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    return res.status(200).json({ text: text || "Sorry, I couldn't come up with an answer. Please try again." });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "busy" });
    if (err instanceof Anthropic.AuthenticationError) return res.status(503).json({ error: "bad_key" });
    console.error("coach error", err);
    return res.status(502).json({ error: "upstream" });
  }
}
