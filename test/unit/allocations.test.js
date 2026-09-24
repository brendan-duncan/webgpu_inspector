// Unit tests for live-object grouping (src/devtools/allocations.js).
//
// Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";

import { baselineId, creationSite, groupLeaks, groupLiveObjects } from "../../src/devtools/allocations.js";

class Buffer {
    constructor(id, size, stacktrace = "", label = "") {
        this.id = id;
        this.size = size;
        this.label = label;
        this.stacktrace = stacktrace;
        this.isDeleted = false;
    }
}
Buffer.className = "Buffer";

class BindGroup {
    constructor(id, stacktrace = "") {
        this.id = id;
        this.label = "";
        this.stacktrace = stacktrace;
        this.isDeleted = false;
    }
}
BindGroup.className = "BindGroup";

const SITE_A = "updateUniforms (app.js:40:12)\ndrawFrame (app.js:90:3)";
const SITE_B = "loadMesh (mesh.js:12:5)";

test("allocations: the creation site is the first stack frame, else the label", () => {
    assert.deepEqual(creationSite({ stacktrace: SITE_A }), { key: "stack:updateUniforms (app.js:40:12)", text: "updateUniforms (app.js:40:12)", fromStack: true });
    assert.equal(creationSite({ stacktrace: "", label: "gbuffer" }).text, "\"gbuffer\"");
    assert.equal(creationSite({}).text, "(unlabeled, no stack trace)");
});

test("allocations: live objects group by type and site, largest first", () => {
    const objects = [
        new Buffer(1, 256, SITE_A), new Buffer(2, 256, SITE_A), new Buffer(3, 4096, SITE_B),
        new BindGroup(4, SITE_A), new BindGroup(5, SITE_A),
        Object.assign(new Buffer(6, 1 << 20, SITE_A), { isDeleted: true }),
    ];
    const { groups, count, bytes, withStack } = groupLiveObjects(objects);
    assert.equal(count, 5);
    assert.equal(bytes, 256 + 256 + 4096);
    assert.equal(withStack, 5);
    assert.deepEqual(groups.map((g) => [g.type, g.site, g.count, g.bytes]), [
        ["Buffer", "loadMesh (mesh.js:12:5)", 1, 4096],
        ["Buffer", "updateUniforms (app.js:40:12)", 2, 512],
        ["BindGroup", "updateUniforms (app.js:40:12)", 2, 0],
    ]);
    assert.equal(groupLiveObjects(objects, { type: "BindGroup" }).count, 2);
});

test("allocations: a baseline keeps only objects created after it", () => {
    const before = [new Buffer(1, 64, SITE_A), new Buffer(2, 64, SITE_B)];
    const mark = baselineId(before);
    const after = [...before, new Buffer(3, 64, SITE_A), new Buffer(4, 64, SITE_A)];
    const { groups, count } = groupLiveObjects(after, { sinceId: mark });
    assert.equal(count, 2);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].site, "updateUniforms (app.js:40:12)");
});

test("allocations: leak records group by site with totals", () => {
    const records = [
        { type: "Buffer", label: "", stacktrace: SITE_A, bytes: 256, time: 10 },
        { type: "Buffer", label: "", stacktrace: SITE_A, bytes: 256, time: 30 },
        { type: "Texture", label: "shadow", stacktrace: "", bytes: 4096, time: 20 },
    ];
    const groups = groupLeaks(records);
    assert.deepEqual(groups.map((g) => [g.type, g.site, g.count, g.bytes, g.lastTime]), [
        ["Texture", "\"shadow\"", 1, 4096, 20],
        ["Buffer", "updateUniforms (app.js:40:12)", 2, 512, 30],
    ]);
});
