// Configure credentials for the model providers pi supports: enter an API key, or sign in with a subscription (ChatGPT, Claude Pro/Max, GitHub Copilot…).
// Everything goes through pi's own login flow (ModelRuntime.login); credentials are stored in <data folder>/engine/auth.json, and pi renews subscription logins automatically.
//
// During the login flow pi will: give you a URL to open in the browser (auth_url), give you a device code (device_code),
// or ask you for something (an API key, the URL after redirect, an option). The web page displays these, and what you enter is passed back to pi via answer().
// When a subscription login is started on the Mac mini itself, the browser redirects back to the local machine and pi catches it; when started on another computer, just paste back the URL that won't open after the redirect.
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readPrefs } from "./modelprefs.js";

export type LoginType = "api_key" | "oauth";

export interface LoginPrompt {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}

export interface LoginState {
  status: "idle" | "waiting" | "done" | "error";
  provider?: string;
  type?: LoginType;
  url?: string; // the login URL to open in the browser
  instructions?: string;
  deviceCode?: { userCode: string; verificationUri: string };
  prompt?: LoginPrompt; // what it's waiting for you to enter
  progress?: string;
  error?: string;
}

/** A provider: whether it accepts an API key, whether it supports subscription login, and whether it's configured now */
export interface ProviderInfo {
  id: string;
  name: string;
  apiKey?: string; // what the API key is called, e.g. "Anthropic API key"; absent if API keys aren't supported
  oauth?: string; // what the subscription login is called, e.g. "Anthropic (Claude Pro/Max)"
  configured: boolean;
  source?: string; // where the credentials come from: auth.json / environment variable / …
  oauthActive: boolean; // currently using subscription login
  on: boolean; // the toggle in settings (configured and not turned off)
  models: number;
}

/** Providers not listed in the menu: legacy entries superseded by openai's ChatGPT login, and classification-only ones */
const HIDDEN = new Set(["openai-codex", "typesafe"]);

export class Logins {
  state: LoginState = { status: "idle" };
  private abort?: AbortController;
  private pending?: { resolve: (v: string) => void; reject: (e: Error) => void };

  constructor(
    private runtime: () => Promise<ModelRuntime>,
    private dataDir: string,
    private engineDir: string,
  ) {}

  async providers(): Promise<ProviderInfo[]> {
    const rt = await this.runtime();
    const off = new Set(readPrefs(this.dataDir).off);
    return (rt.getProviders() as any[])
      .filter((p) => !HIDDEN.has(p.id))
      .map((p) => {
        const st: any = rt.getProviderAuthStatus(p.id) ?? {};
        return {
          id: p.id,
          name: p.name ?? p.id,
          apiKey: p.auth?.apiKey?.login ? p.auth.apiKey.name : undefined,
          oauth: p.auth?.oauth ? p.auth.oauth.name : undefined,
          configured: !!st.configured,
          source: st.label ?? st.source,
          oauthActive: rt.isUsingOAuth(p.id),
          on: !!st.configured && !off.has(p.id),
          models: rt.getModels(p.id).length,
        };
      })
      .sort((a, b) => Number(b.on) - Number(a.on) || Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
  }

  async loggedIn(provider: string): Promise<boolean> {
    return (await this.runtime()).isUsingOAuth(provider);
  }

  /** Start logging in; returns once the first step needs you (open a URL / enter something) or once it's finished. */
  async start(provider: string, type: LoginType): Promise<LoginState> {
    this.cancel();
    const rt = await this.runtime();
    if (!rt.getProvider(provider)) throw new Error(`No provider ${provider}`);
    const abort = (this.abort = new AbortController());
    this.state = { status: "waiting", provider, type };
    let step!: () => void;
    let stepped = new Promise<void>((r) => (step = r));
    const mine = () => this.abort === abort;
    const deviceId = SettingsManager.create(this.dataDir, this.engineDir).getOrCreateDeviceId();
    rt.login(
      provider,
      type,
      {
        signal: abort.signal,
        notify: (ev: any) => {
          if (!mine()) return;
          if (ev.type === "auth_url") this.state = { ...this.state, url: ev.url, instructions: ev.instructions };
          else if (ev.type === "device_code") this.state = { ...this.state, deviceCode: { userCode: ev.userCode, verificationUri: ev.verificationUri } };
          else if (ev.type === "progress" || ev.type === "info") this.state = { ...this.state, progress: ev.message };
          step();
        },
        prompt: (p: any) =>
          new Promise<string>((resolve, reject) => {
            if (!mine()) return reject(new Error("aborted"));
            this.state = { ...this.state, prompt: { type: p.type, message: p.message, placeholder: p.placeholder, options: p.options } };
            this.pending = { resolve, reject };
            p.signal?.addEventListener("abort", () => {
              if (this.pending?.resolve === resolve) {
                this.pending = undefined;
                if (mine()) this.state = { ...this.state, prompt: undefined };
              }
              reject(new Error("aborted"));
            });
            step();
          }),
      },
      { getDeviceId: () => deviceId, agentName: "Kiki" },
    )
      .then(() => {
        if (mine()) this.state = { status: "done", provider, type };
      })
      .catch((e: Error) => {
        if (mine() && !abort.signal.aborted) this.state = { status: "error", provider, type, error: e.message };
      })
      .finally(() => {
        if (mine()) this.pending = undefined;
        step();
      });
    await Promise.race([stepped, new Promise((r) => setTimeout(r, 10_000))]);
    return this.state;
  }

  /** Hand what you entered (API key, URL after redirect, option id) to the step that's waiting for it. */
  async answer(value: string): Promise<LoginState> {
    const p = this.pending;
    if (!p) throw new Error("Nothing is waiting for your input right now");
    this.pending = undefined;
    this.state = { ...this.state, prompt: undefined, progress: "Processing…" };
    p.resolve(value.trim());
    // Wait a moment: it may finish right away, or there may be another step to fill in
    for (let i = 0; i < 30 && this.state.status === "waiting" && !this.state.prompt; i++) await new Promise((r) => setTimeout(r, 200));
    return this.state;
  }

  cancel() {
    this.abort?.abort();
    this.pending?.reject(new Error("aborted"));
    this.abort = undefined;
    this.pending = undefined;
    if (this.state.status === "waiting") this.state = { status: "idle" };
  }

  async logout(provider: string) {
    if (this.state.provider === provider) this.cancel();
    await (await this.runtime()).logout(provider);
    if (this.state.provider === provider) this.state = { status: "idle" };
  }
}
