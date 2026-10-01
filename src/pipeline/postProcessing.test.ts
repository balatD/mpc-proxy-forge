import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp, { type Sharp } from 'sharp';
import { applyPrintCompensation } from './postProcessing.js';

async function png(pixels: number[]) {
    return await sharp(Buffer.from(pixels), { raw: { width: pixels.length / 3, height: 1, channels: 3 } }).png().toBuffer();
}

async function pixelsOf(image: Sharp) {
    return [...await image.raw().toBuffer()];
}

test('neutral settings leave pixels unchanged', async () => {
    const input = [0, 0, 0, 128, 128, 128, 255, 255, 255, 200, 100, 50];
    const output = await pixelsOf(await applyPrintCompensation(await png(input), { gamma: 1, saturation: 1, brightness: 1 }));
    assert.deepEqual(output, input);
});

test('gamma above 1 lifts midtones and keeps black and white', async () => {
    const output = await pixelsOf(await applyPrintCompensation(await png([0, 0, 0, 128, 128, 128, 255, 255, 255]), { gamma: 1.2, saturation: 1, brightness: 1 }));
    assert.deepEqual(output.slice(0, 3), [0, 0, 0]);
    assert.ok(output[3]! > 128, `mid-grey should get brighter, got ${output[3]}`);
    assert.deepEqual(output.slice(6, 9), [255, 255, 255]);
});

test('saturation above 1 increases chroma', async () => {
    const [r, g, b] = await pixelsOf(await applyPrintCompensation(await png([200, 100, 50]), { gamma: 1, saturation: 1.3, brightness: 1 }));
    assert.ok(Math.max(r!, g!, b!) - Math.min(r!, g!, b!) > 150, `chroma should exceed 150, got ${[r, g, b]}`);
});
