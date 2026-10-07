import assert from "node:assert/strict";
import test from "node:test";
import { imageFiles, imageName } from "../src/imagesource.js";

const PAGE = "http://localhost:4321/about";

test("imageName is the file name, without the query or a build hash", () => {
	assert.equal(imageName("http://localhost:4321/images/about/person-circle-outline.webp"), "person-circle-outline.webp");
	assert.equal(
		imageName("http://localhost:4321/@fs/repo/src/assets/people/gray-lewis.png?origWidth=285&origHeight=285&origFormat=png"),
		"gray-lewis.png",
	);
	assert.equal(imageName("https://example.com/_astro/gray-lewis.Bx7a3Kq1.png"), "gray-lewis.png");
	assert.equal(imageName("http://localhost:4321/logo.dark.png"), "logo.dark.png", "a word before the extension isn't a hash");
	assert.equal(imageName("http://localhost:4321/my%20photo.jpg"), "my photo.jpg");
	assert.equal(imageName("data:image/png;base64,AAAA"), null);
});

test("imageName unwraps Astro's dev image endpoint", () => {
	assert.equal(imageName("http://localhost:4321/_image?href=%2F%40fs%2Frepo%2Fsrc%2Fassets%2Fa.png%3ForigWidth%3D10&w=36&f=webp"), "a.png");
});

test("imageFiles: public directory first, then the project root, and Vite's /@fs/ paths as is", () => {
	assert.deepEqual(imageFiles("http://localhost:4321/images/a.png", PAGE, "/repo"), ["/repo/public/images/a.png", "/repo/images/a.png"]);
	assert.deepEqual(imageFiles("/images/a.png", PAGE, "/repo", "static"), ["/repo/static/images/a.png", "/repo/images/a.png"]);
	assert.deepEqual(imageFiles("http://localhost:4321/@fs/repo/src/assets/a.png?origWidth=1", PAGE, "/repo"), ["/repo/src/assets/a.png"]);
	assert.deepEqual(imageFiles("http://localhost:4321/_image?href=%2F%40fs%2Frepo%2Fsrc%2Fa.png&w=36", PAGE, "/repo"), ["/repo/src/a.png"]);
});

test("imageFiles: nothing for other origins, hashed build output or data URLs", () => {
	assert.deepEqual(imageFiles("https://cdn.example.com/a.png", PAGE, "/repo"), []);
	assert.deepEqual(imageFiles("http://localhost:4321/_astro/a.Bx7a3Kq1.png", PAGE, "/repo"), []);
	assert.deepEqual(imageFiles("http://localhost:4321/_next/static/media/a.0f1e2d3c.png", PAGE, "/repo"), []);
	assert.deepEqual(imageFiles("data:image/png;base64,AAAA", PAGE, "/repo"), []);
});
