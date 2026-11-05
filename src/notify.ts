// Notification channels: the inbox is "in", notifications are "out" — the two sides are separate.
// When the Mailroom (and later scheduled tasks and background tasks) needs to tell you something, it just calls notifier.send(...),
// and where it goes (the Kiki UI, and later Telegram, WeChat, phone push) is decided by which channels are registered here.
// Right now there's only one: the Kiki UI (an extra entry in Kiki's chat). Future channels are written as plugins that implement NotifyChannel and get added here.

export interface Notice {
  title: string;
  text: string;
  urgent?: boolean; // needs your personal attention (errors, the other party flagged it as important); future phone push can send only these
  source?: string; // where it came from, e.g. Mailroom · grokbot
}

export interface NotifyChannel {
  id: string; // kiki-ui, telegram, wechat...
  name: string;
  send(n: Notice): Promise<void> | void;
}

export class Notifier {
  private channels = new Map<string, NotifyChannel>();

  add(ch: NotifyChannel) {
    this.channels.set(ch.id, ch);
  }

  list() {
    return [...this.channels.values()].map((c) => ({ id: c.id, name: c.name }));
  }

  /** Send to every channel; an error in one channel doesn't affect the others. */
  async send(n: Notice) {
    await Promise.all(
      [...this.channels.values()].map(async (c) => {
        try {
          await c.send(n);
        } catch (e) {
          console.warn(`[notify] ${c.name} failed to send: ${(e as Error).message}`);
        }
      }),
    );
  }
}
