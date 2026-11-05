// A few tools Kiki gives the agent in a conversation: look at other conversations, pass a message to another conversation, and note something in "About me" or a bot's description.
// All of them act directly and return a receipt when done, without asking the user first (see routing-rules.md).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { baoFile } from "./bao.js";

export interface ToolHost {
  /** An overview of all conversations, or the latest n messages of one conversation */
  peek(target: string | undefined, n: number): string;
  /** Pass a message to another conversation; when the other side replies, the reply is reported back to the originating conversation. Returns a receipt immediately. */
  relay(fromPath: string | undefined, target: string, text: string): Promise<string>;
}

const NOTES = "## Notes";

/** Append a note to the "Notes" section at the end of AGENTS.md. When scope is "me", write to ~/Kiki/AGENTS.md; otherwise write to that bot's file. */
export function remember(dataDir: string, baos: string[], scope: string, text: string): string {
  const me = scope === "me" || scope === "about me";
  if (!me && !baos.includes(scope)) throw new Error(`No bot "${scope}". Options: me, ${baos.join(", ")}`);
  const file = me ? join(dataDir, "AGENTS.md") : baoFile(dataDir, scope);
  const line = text.replace(/\s*\n\s*/g, " ").trim();
  if (!line) throw new Error("The content is empty");
  const old = existsSync(file) ? readFileSync(file, "utf8") : "";
  const head = old.includes(NOTES) ? "" : `${old && !old.endsWith("\n") ? "\n" : ""}\n${NOTES}\n\n`;
  appendFileSync(file, `${head}- ${line}\n`);
  return `Noted in ${me ? "\"About me\"" : `the description of bot "${scope}"`}: ${line} (all new conversations will see it)`;
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], details: undefined, ...(isError ? { isError } : {}) }) as any;

export function kikiTools(opts: { host: ToolHost; dataDir: string; listBaos: () => string[] }): ToolDefinition[] {
  const peek: ToolDefinition = {
    name: "kiki_peek",
    label: "Look at other conversations",
    description: "Without target: list all bots and conversations (marking the ones currently running). With target (bot name/conversation name): look at the latest few messages of that conversation.",
    promptSnippet: "kiki_peek: see which conversations exist, or see where another conversation has got to",
    promptGuidelines: ["When the user mentions another conversation or the progress of another project, use kiki_peek to take a look before answering; don't guess."],
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Bot name/conversation name, e.g. dev/router; leave empty to list everything" })),
      n: Type.Optional(Type.Number({ description: "How many recent messages to look at, default 10" })),
    }),
    async execute(_id, p: any) {
      try {
        return text(opts.host.peek(p.target, Math.min(Math.max(p.n ?? 10, 1), 40)));
      } catch (e) {
        return text((e as Error).message, true);
      }
    },
  };

  const relay: ToolDefinition = {
    name: "kiki_relay",
    label: "Pass a message to another conversation",
    description:
      "Hand a matter to another bot or another existing conversation: if target is just a bot name, it goes into that bot's main chat (which decides what to do); if it is \"bot name/conversation name\", it goes into that thread. When the other side replies, the reply is recorded back into this conversation. Returns immediately; no need to wait.",
    promptSnippet: "kiki_relay: hand matters belonging to another bot to that bot; pass conclusions to another conversation",
    promptGuidelines: [
      "When what the user says here includes matters in another bot's domain (check what each bot is responsible for in the bot directory): first answer a sentence or two here, and at the same time use kiki_relay to copy that matter to that bot (target as the bot name goes into its main chat; if it clearly belongs to one of its threads, write \"bot name/conversation name\"), and let that side follow up. Don't ask the user first.",
      "If one sentence involves several bots, split it up: call kiki_relay once per bot, handing over only the part that belongs to it, written as a concrete task that side can act on directly; don't forward the whole original message in one go.",
      "After copying, list at the end of your answer who each matter was handed to, each written as [bot name](kiki:bot name/main chat) or [conversation name](kiki:bot/conversation name); the web page will show them as cards. Matters belonging to this bot and this conversation are answered here as usual; no need to copy them.",
      "Conclusions and decisions reached here that the other side needs to know should also be passed over with kiki_relay.",
      "Messages handed over must carry their own context (the user's original words + necessary background) so the other side can understand without reading this chat.",
      "Small talk unrelated to other bots, and small conclusions this side can wrap up itself, don't need to be passed over.",
    ],
    parameters: Type.Object({
      target: Type.String({ description: "Bot name (goes into its main chat), or bot name/conversation name (goes into that thread)" }),
      text: Type.String({ description: "The message to hand over, carrying its own context" }),
    }),
    async execute(_id, p: any, _signal, _onUpdate, ctx) {
      try {
        return text(await opts.host.relay(ctx?.sessionManager?.getSessionFile?.(), p.target, p.text));
      } catch (e) {
        return text(`Couldn't pass it over: ${(e as Error).message}`, true);
      }
    },
  };

  const note: ToolDefinition = {
    name: "kiki_remember",
    label: "Note it down",
    description: `Write something to remember for later into a description file: scope "me" writes into "About me" (all conversations will see it); a bot name writes into that bot's description. Available bots: ${opts.listBaos().join(", ")}.`,
    promptSnippet: "kiki_remember: note the user's preferences and long-term facts into \"About me\" or a bot's description",
    promptGuidelines: [
      "When the user says something useful long-term (preferences, identity, habits, fixed conventions of a project), use kiki_remember to note it down directly; don't ask first. After noting it, tell the user in one sentence what you noted.",
      "Note only one item at a time, one sentence each; don't note temporary things that only matter for this conversation.",
      "Before noting, check \"About me\" and the bot descriptions (already in your system prompt); if the meaning is already there, don't note it again.",
    ],
    parameters: Type.Object({
      scope: Type.String({ description: "\"me\" or a bot name" }),
      text: Type.String({ description: "The one sentence to note" }),
    }),
    async execute(_id, p: any) {
      try {
        return text(remember(opts.dataDir, opts.listBaos(), p.scope, p.text));
      } catch (e) {
        return text(`Couldn't note it: ${(e as Error).message}`, true);
      }
    },
  };

  return [peek, relay, note];
}
