// Unit tests for the plot ring buffer (src/devtools/widget/plot.js).
//
// Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";

import { PlotData } from "../../src/devtools/widget/plot.js";

const values = (data) => Array.from({ length: data.count }, (_, i) => data.get(i));

test("plot data: shrinking to zero (a hidden tab) doesn't wedge the buffer", () => {
    const data = new PlotData("frame", 4);
    data.add(1);
    data.add(2);
    data.size = 0;          // the plot's tab was hidden
    data.add(3);
    data.size = 4;          // shown again
    data.add(4);
    data.add(5);
    assert.ok(Number.isInteger(data.index), `index is ${data.index}`);
    assert.deepEqual(values(data), [3, 4, 5]);
    assert.equal(data.min, 3);
    assert.equal(data.max, 5);
});

test("plot data: a series created at width 0 still records", () => {
    const data = new PlotData("frame", 0);
    data.add(7);
    data.size = 3;
    data.add(8);
    data.add(9);
    assert.deepEqual(values(data), [7, 8, 9]);
});

test("plot data: resizing a wrapped buffer keeps the most recent samples in order", () => {
    const data = new PlotData("frame", 4);
    for (const v of [1, 2, 3, 4, 5, 6]) {
        data.add(v);
    }
    assert.deepEqual(values(data), [3, 4, 5, 6]);
    data.size = 3;
    assert.deepEqual(values(data), [4, 5, 6]);
    data.size = 5;
    data.add(7);
    assert.deepEqual(values(data), [4, 5, 6, 7]);
});
