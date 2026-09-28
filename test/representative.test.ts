import assert from "node:assert/strict";
import { test } from "node:test";
import { pickRepresentative } from "../src/representative.js";

const id = (n: number) => n;

test("empty input has no representative", () => {
	assert.equal(pickRepresentative([], id), undefined);
});

test("fewer than four effects picks the largest", () => {
	assert.equal(pickRepresentative([5, 900, 20], id), 900);
});

test("skips an outlier above the Tukey fence", () => {
	// Q1 = 11.25, Q3 = 13.75, fence = 17.5.
	assert.equal(pickRepresentative([10, 12, 11, 13, 14, 5000], id), 14);
});

test("keeps the largest when nothing is an outlier", () => {
	assert.equal(pickRepresentative([100, 110, 120, 130], id), 130);
});

test("identical sizes all sit on the fence", () => {
	const effects = [{ n: 7 }, { n: 7 }, { n: 7 }, { n: 7 }];
	assert.equal(pickRepresentative(effects, (e) => e.n), effects[0]);
});

test("works on arbitrary effects through the size function", () => {
	const effects = [{ id: "a", px: 40 }, { id: "b", px: 50 }, { id: "c", px: 45 }, { id: "d", px: 60 }, { id: "page", px: 1e6 }];
	assert.equal(pickRepresentative(effects, (e) => e.px)?.id, "d");
});
