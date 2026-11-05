import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hasImages, imageNames, imageNote, loadImages, saveImage, validImageName } from "./images.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("saves an image and reads it back from a message", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiki-img-"));
  const mark = saveImage(dir, `data:image/png;base64,${PNG}`);
  assert.match(mark, /^!\[image\]\(\/api\/image\/[a-f0-9]{32}\.png\)$/);
  assert.equal(saveImage(dir, `data:image/png;base64,${PNG}`), mark); // the same image is stored only once
  assert.ok(validImageName(mark.slice(mark.lastIndexOf("/") + 1, -1)));
  const text = `${mark}\n\nWhat is this?`;
  assert.ok(hasImages(text));
  const imgs = loadImages(dir, text);
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].mimeType, "image/png");
  assert.equal(imgs[0].data, PNG);
  assert.equal(loadImages(dir, "no images").length, 0);
  assert.equal(loadImages(dir, "![image](/api/image/" + "0".repeat(32) + ".png)").length, 0); // skip if the file isn't there
});

test("rejects everything else", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiki-img-"));
  assert.throws(() => saveImage(dir, "data:text/html;base64,PGI+"));
  assert.throws(() => saveImage(dir, "../../etc/passwd"));
  assert.ok(!validImageName("../x.png"));
});

test("the text note attached when images can't be viewed", () => {
  const note = imageNote([{ name: "a".repeat(32) + ".png", text: "a cat" }], "GPT-6 Luna");
  assert.match(note, /^\n\n<kiki-image-note>\n/);
  assert.match(note, /what GPT-6 Luna saw:\na cat/);
  assert.match(note, /kiki_look/);
  assert.deepEqual(imageNames("x ![image](/api/image/" + "b".repeat(32) + ".jpg) ![image](/api/image/" + "b".repeat(32) + ".jpg)"), ["b".repeat(32) + ".jpg"]);
});
