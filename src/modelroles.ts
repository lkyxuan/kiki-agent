// Models configured by purpose: in Kiki, every place that uses a model and isn't the chat itself is a "purpose", and each can pick its own model.
// If unset, it follows the default model (except "quick ack": if unset, no ack is sent, and it relies only on the emoji and the main model's first sentence).
// The chosen model is stored in the data folder's .env (same as MODEL and VISION_MODEL); changes take effect immediately, no restart needed.
export const ROLES = [
  { id: "route", env: "ROUTE_MODEL", name: "Routing", desc: "Decides which bot and which conversation a message goes to. A cheap, fast small model is enough", unset: "Follow the default model" },
  { id: "summary", env: "SUMMARY_MODEL", name: "Conversation summary", desc: "Writes a one-line summary after each conversation reply; routing and the bot's main chat rely on it to recognize conversations", unset: "Follow the default model" },
  { id: "work", env: "WORK_MODEL", name: "Work categorization", desc: "After each conversation reply, files the to-dos into the bot's \"Work\" (the right column shows them by work item)", unset: "Follow the conversation summary model" },
  { id: "ack", env: "ACK_MODEL", name: "Quick ack", desc: "As soon as a message arrives, a small model says \"Got it, I'll look at X first\" while the main model starts working at the same time", unset: "No ack (emoji only)" },
  { id: "vision", env: "VISION_MODEL", name: "Image reading", desc: "When the current model can't see images, have it read the image into text first", unset: "Automatically pick one that can see images" },
] as const;

export type RoleId = (typeof ROLES)[number]["id"];

export const roleOf = (id: string) => ROLES.find((r) => r.id === id);

/** The model chosen for this purpose; returns undefined if none is chosen (the caller decides whether to follow the default model or skip). */
export function roleModel(id: RoleId, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[roleOf(id)!.env]?.trim() || undefined;
}

/** Whether a model name looks right (provider/model); an empty string means "none chosen". */
export const validSpec = (spec: string) => spec === "" || /^[\w.-]+\/[\w.:/-]+$/.test(spec);

/** The "quick ack" prompt. who is who's replying (Kiki / some bot); returning SKIP means this message doesn't need a quick ack. */
export function ackPrompt(who: string): string {
  return `You are ${who}. The user just sent a message, and the real answer will be given by another model right away.
Your only job is to acknowledge the user in one sentence first: make clear what you understand needs to be done and where you'll start, no more than 25 words, conversational, no quotes or emoji.
Don't answer the question itself, don't promise outcomes, don't make up facts.
If the message is small talk, a simple question that can be answered in one sentence, or a command (starting with /), output only SKIP.`;
}

/** Clean up the "quick ack" written by the model: strip quotes and extra lines; return empty if it should be skipped. */
export function cleanAck(raw: string): string {
  const line = raw.trim().split("\n").find((l) => l.trim())?.trim() ?? "";
  if (!line || /^SKIP\b/i.test(line)) return "";
  const s = line.replace(/^["“「『']+|["”」』']+$/g, "").trim();
  return s.length > 60 ? s.slice(0, 59) + "…" : s;
}
