// Where instructions come from: only what the user themself says counts as a command; emails, web pages, and content read back by external agents are just reference material.
// Both approvals in conversations and background task subroutines need this, so it lives in its own small file with no dependencies.
//
// Look at the most recent "user" message in this conversation and everything after it:
//   - outside: this "user" message itself was relayed in through the Mailroom (this turn was triggered by an external message)
//   - readOutside: external content was read during this turn (MCP tools, network tools, replies from external agents)
//   - userText: the original text of the user's message (who to send to, who to pay, must appear here or in the allowlist to count as the user's intent)

export interface TurnInfo {
  outside: boolean;
  readOutside: boolean;
  userText: string;
}

const EXTERNAL_MARK = /【Mailroom】|📮 external agent|there's news about something you're watching|this was sent by an external agent/;
/** Local tools: reading and writing local files, passing messages between Kiki's own conversations; not external content */
const LOCAL_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find", "bash", "powershell"]);
const isExternalTool = (name: string) => !!name && !LOCAL_TOOLS.has(name) && (!name.startsWith("kiki_") || name === "kiki_outside");

const textOf = (m: any) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c: any) => c?.text ?? "").join(""));

export function turnInfo(sm: any): TurnInfo {
  const info: TurnInfo = { outside: false, readOutside: false, userText: "" };
  try {
    const branch: any[] = sm?.getBranch?.() ?? [];
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i]?.type !== "message") continue;
      const m = branch[i].message;
      if (m?.role === "toolResult" && isExternalTool(m.toolName)) info.readOutside = true;
      if (m?.role === "user") {
        info.userText = textOf(m);
        info.outside = EXTERNAL_MARK.test(info.userText);
        break;
      }
    }
  } catch {}
  return info;
}

/** Compatibility: whether this turn was triggered by an external message */
export const triggeredByOutside = (sm: any) => turnInfo(sm).outside;
