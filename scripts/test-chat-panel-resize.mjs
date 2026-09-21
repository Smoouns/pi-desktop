import assert from "node:assert/strict";
import {
	chatPanelWidthFromPointer,
	clampChatPanelWidth,
	resolveChatPanelWidthBounds,
} from "../src/layout/chat-panel-resize.ts";

const options = { minChatWidth: 300, minFileWidth: 300, dividerWidth: 5 };

assert.deepEqual(resolveChatPanelWidthBounds(1200, options), { min: 300, max: 895 });
assert.equal(clampChatPanelWidth(420, 1200, options), 420);
assert.equal(clampChatPanelWidth(100, 1200, options), 300);
assert.equal(clampChatPanelWidth(1100, 1200, options), 895);
assert.equal(clampChatPanelWidth(420, 550, options), 300, "narrow layouts retain a usable chat minimum");
assert.deepEqual(resolveChatPanelWidthBounds(550, options), { min: 300, max: 300 }, "editor contracts first");
assert.deepEqual(resolveChatPanelWidthBounds(280, options), { min: 275, max: 275 }, "chat fits below its preferred minimum");
assert.deepEqual(resolveChatPanelWidthBounds(3, options), { min: 0, max: 0 }, "divider cannot create negative space");
assert.deepEqual(resolveChatPanelWidthBounds(-50, options), { min: 0, max: 0 });
assert.deepEqual(resolveChatPanelWidthBounds(Number.NaN, options), { min: 0, max: 0 });
assert.deepEqual(
	resolveChatPanelWidthBounds(800, { minChatWidth: Number.NaN, minFileWidth: -10, dividerWidth: Number.POSITIVE_INFINITY }),
	{ min: 0, max: 800 },
	"invalid options are normalized without producing NaN",
);
assert.equal(clampChatPanelWidth(420, 280, options), 275);
assert.equal(clampChatPanelWidth(Number.NaN, 1200, options), 300);

assert.equal(chatPanelWidthFromPointer(420, 700, 600), 520, "dragging the left edge left enlarges right chat");
assert.equal(chatPanelWidthFromPointer(420, 700, 760), 360, "dragging the left edge right shrinks right chat");

console.log("chat panel resize: 15 cases passed");
