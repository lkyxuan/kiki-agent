// kiki_look: when the current model can't see images (e.g. DeepSeek), have a vision model take a closer look at an image (inspired by Hermes's vision_analyze).
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validImageName } from "./images.js";

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], details: undefined, ...(isError ? { isError } : {}) }) as any;

export function lookTool(look: (name: string, question: string) => Promise<string>): ToolDefinition {
  return {
    name: "kiki_look",
    label: "Look at image",
    description: "Have a model that can see images look at an image the user sent and answer a specific question. image is the image file name (written in the message as <kiki-image-note>), and question says what to look at.",
    promptSnippet: "kiki_look: look at details in an image the user sent",
    promptGuidelines: ["When the message only has a text description of an image but you need details from the image itself (small text, numbers, tables), use kiki_look to take another look instead of guessing."],
    parameters: Type.Object({
      image: Type.String({ description: "Image file name, e.g. 0123abcd….png" }),
      question: Type.String({ description: "What to look at, e.g.: copy down all the numbers in the third column of the table" }),
    }),
    async execute(_id, p: any) {
      const name = String(p.image ?? "").split("/").pop() ?? "";
      if (!validImageName(name)) return text(`Invalid image file name: ${p.image}`, true);
      try {
        return text(await look(name, String(p.question ?? "Write down everything in the image in full")));
      } catch (e) {
        return text((e as Error).message, true);
      }
    },
  };
}
