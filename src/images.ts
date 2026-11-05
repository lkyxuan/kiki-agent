// Images in chat: the web page uploads images first and stores them in <data folder>/uploads/; the message body only carries a marker
//   ![image](/api/image/<name>)
// This way images travel the whole path alongside the text (Kiki routing, splitting, handoff, and background tasks all pass text only),
// and only at the moment of actually sending to the model (agents.send) is the marker swapped for the image itself. The web page renders the marker as a thumbnail.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ImagePart {
  type: "image";
  data: string; // base64
  mimeType: string;
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Image file name: content hash + extension, so the same image is stored only once. */
export const validImageName = (n: string) => /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(n);
export const imageMime = (n: string) => MIME[n.split(".").pop() ?? ""] ?? "application/octet-stream";
export const uploadsDir = (dataDir: string) => join(dataDir, "uploads");

const MARK = /!\[image\]\(\/api\/image\/([a-f0-9]{32}\.(?:png|jpg|gif|webp))\)/g;

/** Store an image (data: URL) and return the marker to put in the message. */
export function saveImage(dataDir: string, dataUrl: string): string {
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new Error("Only PNG, JPG, GIF, and WebP images are supported");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > MAX_IMAGE_BYTES) throw new Error("Image is too large; 10MB max");
  const name = `${createHash("sha256").update(buf).digest("hex").slice(0, 32)}.${EXT[m[1]]}`;
  const dir = uploadsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, name);
  if (!existsSync(f)) writeFileSync(f, buf);
  return `![image](/api/image/${name})`;
}

/** File names of the images in a message (in order of appearance, deduplicated). */
export const imageNames = (text: string) => [...new Set([...text.matchAll(MARK)].map((m) => m[1]))];

/** Read a stored image; returns undefined if the file doesn't exist. */
export function readImage(dataDir: string, name: string): ImagePart | undefined {
  const f = join(uploadsDir(dataDir), name);
  if (!validImageName(name) || !existsSync(f)) return undefined;
  return { type: "image", data: readFileSync(f).toString("base64"), mimeType: imageMime(name) };
}

/**
 * When the current model can't see images (e.g. DeepSeek), first have a vision model read the image into text and append it to the message (borrowed from Hermes).
 * Wrapped in <kiki-image-note>: the model can see it, and the web page collapses it when displaying.
 */
export function imageNote(items: { name: string; text: string }[], by: string): string {
  const body = items
    .map((i) => `[The user attached an image (${i.name}); what ${by} saw:\n${i.text}]`)
    .join("\n");
  return `\n\n<kiki-image-note>\n${body}\n[You can't see the image yourself; the above is text read out by another model. To look at details, use the kiki_look tool, put the file name in image and what you want to see in question.]\n</kiki-image-note>`;
}

/** Whether the message contains any image markers. */
export const hasImages = (text: string) => new RegExp(MARK.source).test(text);

/** Read the image markers in a message into images (skip files that can't be found). The text is kept as-is, so the model can see "there's an image here". */
export function loadImages(dataDir: string, text: string): ImagePart[] {
  const out: ImagePart[] = [];
  for (const [, name] of text.matchAll(MARK)) {
    const f = join(uploadsDir(dataDir), name);
    if (!existsSync(f)) continue;
    out.push({ type: "image", data: readFileSync(f).toString("base64"), mimeType: imageMime(name) });
  }
  return out;
}
