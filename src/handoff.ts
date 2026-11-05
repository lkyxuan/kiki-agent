// Handoff tool: when the agent in a conversation notices "this is a new matter", it writes the context
// that matter needs into a handoff brief and starts a new conversation with it. The new conversation
// starts from a clean, focused brief instead of dragging along the whole old chat.
// The judgment and summary are done by the agent in the current conversation (it has all the context),
// so we don't call the model an extra time for every message.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface HandoffRequest {
  fromPath: string | undefined; // the conversation that initiated the handoff
  bao: string;
  duty?: string; // when the bot doesn't exist yet: what the new bot is responsible for
  name: string;
  brief: string;
  mode: "chat" | "background";
}

/** The fixed structure of a handoff brief, written into the tool description so the model follows it. */
export const BRIEF_SECTIONS = ["Goal", "Conclusions and decisions already made", "Relevant facts, files, and links", "Open questions", "Things explicitly not to do"];

export function handoffTool(opts: {
  listBaos: () => string[];
  describe?: (bao: string) => string; // what this bot is responsible for, in one sentence (for the bot directory)
  rules?: () => string; // the user's routing rules, appended to the tool description
  onHandoff: (req: HandoffRequest) => Promise<string>; // the result shown to the model (where the new conversation is)
}): ToolDefinition {
  const params = Type.Object({
    bao: Type.String({ description: "Which bot to hand this to. If none fits, write a new bot name (e.g. Life bot) and fill in duty" }),
    duty: Type.Optional(Type.String({ description: "Required when creating a bot: what this bot is responsible for, in one sentence (by domain, e.g. \"daily life: shopping, household matters, health\")" })),
    name: Type.String({ description: "A short name for the new conversation, 2 to 8 words, summarizing the matter" }),
    brief: Type.String({
      description: `Handoff brief. Write it in these sections, including only what the new matter needs; leave out anything irrelevant from the old topic: ${BRIEF_SECTIONS.map((s) => `[${s}]`).join("")}`,
    }),
    mode: Type.Optional(
      Type.Union([Type.Literal("chat"), Type.Literal("background")], {
        description: "chat: open a new conversation and wait for the user to chat; background: the new conversation starts working right away from the brief and reports back here when done",
      }),
    ),
  });
  return {
    name: "kiki_handoff",
    label: "Hand off to a new conversation",
    description:
      "Hand a new matter off to a new conversation: you write the handoff brief (the context this matter needs), and Kiki opens a new conversation with the brief as its first message." +
      `Existing bots: ${opts.listBaos().join(", ")}; if none fits, create a new one (fill in duty).`,
    promptSnippet: "kiki_handoff: when you notice the current chat is about a new matter, write a handoff brief and route it into a new conversation",
    promptGuidelines: [
      "If you are in this bot's \"main chat\": you are the coordinator for this bot. Answer simple things directly; for concrete matters that belong to this bot, need discussion, research, or action, and will continue later, use kiki_handoff to open a thread for this bot (set bao to this bot), and after handing it off, tell the user with a card.",
      "If you are in a thread: focus on getting this matter done well; if another matter for this bot comes up, use kiki_handoff to open a new thread for this bot.",
      "For matters that don't belong to this bot (whether you're in the main chat or a thread): if a matching bot already exists, answer briefly in place and use kiki_relay to copy it to that bot (set target to the bot name to put it in its main chat), and let that bot follow up and decide whether to open a thread; only if no matching bot exists should you use kiki_handoff to create a new bot. In either case, don't ask the user first.",
      `Write the handoff brief in the sections [${BRIEF_SECTIONS.join("] [")}] so the agent in the new conversation can pick up right after reading it, without looking at the old chat.`,
      "When creating a bot, divide by domain (e.g. Life bot, Work bot); don't create a bot for a single matter, and don't hand things to Kiki (Kiki only routes).",
      "After calling it, tell the user in one sentence where it went, and mention it if you created a bot; if it's misrouted, the user will move it themselves.",
      "When referring to a conversation, write it as [conversation name](kiki:bot/conversation name) (the tool result has a ready-made form; copy it as is), and the web page will show it as a clickable card. If a long matter is split across several conversations, write one of these for each.",
      // Bot directory: each bot's name and one-line responsibility, read fresh when a conversation opens, so every bot knows what the others handle
      `Existing bots:\n${opts
        .listBaos()
        .map((b) => `- ${b}${opts.describe?.(b) ? `: ${opts.describe(b)}` : ""}`)
        .join("\n")}\nTo see which conversations each bot has and where they stand, use kiki_peek.`,
      ...(opts.rules ? [`Routing rules set by the user:\n${opts.rules().trim()}`] : []),
    ],
    parameters: params,
    async execute(_id, p: any, _signal, _onUpdate, ctx) {
      const fromPath = ctx?.sessionManager?.getSessionFile?.();
      try {
        const where = await opts.onHandoff({ fromPath, bao: p.bao, duty: p.duty, name: p.name, brief: p.brief, mode: p.mode ?? "chat" });
        return { content: [{ type: "text", text: where }], details: undefined };
      } catch (e) {
        return { content: [{ type: "text", text: `Handoff failed: ${(e as Error).message}` }], details: undefined, isError: true } as any;
      }
    },
  };
}

/** The first message the new conversation receives. */
export function briefMessage(fromLabel: string | undefined, brief: string, mode: "chat" | "background") {
  const head = fromLabel ? `This is a new matter handed off from "${fromLabel}".` : "This is a new matter handed off to you.";
  const tail = mode === "background" ? "Please start working right away and give your conclusion when done." : "First say in one sentence what you understand the goal to be, then continue the conversation directly or start on the first step; don't stop to wait for the user's confirmation.";
  return `${head}\n\n${brief.trim()}\n\n${tail}`;
}
