import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMpcAutofillOrder, finishGroup } from './mpcAutofill.js';
import { DefaultOrder } from '../config/orderConfigManager.js';
import { type CardQueueItem, ProcessingState } from '../pipeline/types.js';
import type { MoxfieldCardPrintingData } from '../clients/moxfield.js';

function card(id: string, quantity: number, finish?: 'nonFoil' | 'foil' | 'etched'): MoxfieldCardPrintingData {
    return {
        quantity,
        card: { id, name: id, set: 'tst', cn: '1', scryfall_id: id, isToken: false, type_line: 'Creature', card_faces: [] },
        ...(finish ? { finish } : {})
    };
}

function front(id: string, group: 'foil' | 'nonfoil'): CardQueueItem {
    return { id, face: 'front', group, scryfallUrl: '', path: `${id}-front.jpg`, state: ProcessingState.Converted };
}

test('split mode puts only foil finishes into the foil group', () => {
    assert.equal(finishGroup(card('a', 1, 'foil'), 'split'), 'foil');
    assert.equal(finishGroup(card('a', 1, 'etched'), 'split'), 'nonfoil');
    assert.equal(finishGroup(card('a', 1, 'nonFoil'), 'split'), 'nonfoil');
    assert.equal(finishGroup(card('a', 1), 'split'), 'nonfoil');
});

test('all and none modes ignore the Moxfield finish', () => {
    assert.equal(finishGroup(card('a', 1, 'nonFoil'), 'all'), 'foil');
    assert.equal(finishGroup(card('a', 1, 'foil'), 'none'), 'nonfoil');
});

test('order XML carries the foil flag and counts only the passed cards', () => {
    const xml = createMpcAutofillOrder(DefaultOrder, [front('a', 'foil'), front('b', 'foil')], [card('a', 2), card('b', 1)], true);

    assert.match(xml, /<foil>true<\/foil>/);
    assert.match(xml, /<quantity>3<\/quantity>/);
    assert.match(xml, /<bracket>18<\/bracket>/);
    assert.match(xml, /<id>cards\/a-front\.jpg<\/id><name>a-front\.jpg<\/name><query\/><slots>0,1<\/slots>/);
    assert.match(xml, /<id>cards\/b-front\.jpg<\/id><name>b-front\.jpg<\/name><query\/><slots>2<\/slots>/);
});

test('non-foil order XML is marked as non-foil', () => {
    const xml = createMpcAutofillOrder(DefaultOrder, [front('a', 'nonfoil')], [card('a', 1)], false);
    assert.match(xml, /<foil>false<\/foil>/);
});
