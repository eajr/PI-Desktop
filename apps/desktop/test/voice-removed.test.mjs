import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  allowsDefaultSessionPermission,
  installDefaultSessionPermissionHandlers,
} from "../electron/main/default-session-permissions.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("the renderer mounts no voice entry points (D662)", async () => {
  const [composer, toolbar, appShell, main] = await Promise.all([
    read("../src/components/Composer.tsx"),
    read("../src/features/chat/composer/ComposerToolbar.tsx"),
    read("../src/features/app/AppShell.tsx"),
    read("../src/main.tsx"),
  ]);
  assert.doesNotMatch(composer, /useVoiceInput|VoiceOverlay|voiceEnabled/);
  assert.doesNotMatch(toolbar, /LiveVoice|VoiceMicButton|voicePhase/);
  assert.doesNotMatch(appShell, /LiveVoice/);
  assert.doesNotMatch(main, /live-voice-widget|LiveVoiceWidget/);
});

test("the default session refuses media and keeps other permissions", () => {
  assert.equal(allowsDefaultSessionPermission("media"), false);
  assert.equal(allowsDefaultSessionPermission("clipboard-sanitized-write"), true);

  let requestHandler;
  let checkHandler;
  installDefaultSessionPermissionHandlers({
    setPermissionRequestHandler: (handler) => { requestHandler = handler; },
    setPermissionCheckHandler: (handler) => { checkHandler = handler; },
  });
  const decisions = [];
  requestHandler(null, "media", (allowed) => decisions.push(allowed), { mediaTypes: ["audio"] });
  requestHandler(null, "clipboard-sanitized-write", (allowed) => decisions.push(allowed), {});
  assert.deepEqual(decisions, [false, true]);
  assert.equal(checkHandler(null, "media", "file://", { mediaType: "audio" }), false);
  assert.equal(checkHandler(null, "notifications", "file://", {}), true);
});
