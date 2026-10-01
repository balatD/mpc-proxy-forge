import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, enqueueCards } from './orderProcessing.js';
import { DefaultOrder, type Order } from '../config/orderConfigManager.js';
import { type CardQueueItem, ProcessingState } from './types.js';
import type { MoxfieldCardPrintingData, MoxfieldDeck } from '../clients/moxfield.js';
import type { ScryfallCard } from '../clients/scryfall.js';

function card(id: string, finish: 'nonFoil' | 'foil'): MoxfieldCardPrintingData {
    return {
        quantity: 1,
        finish,
        card: { id, name: id, set: 'tst', cn: '1', scryfall_id: id, isToken: false, type_line: 'Creature', card_faces: [] }
    };
}

function contextWith(cards: MoxfieldCardPrintingData[]) {
    const ctx = createContext();
    ctx.decks['deck'] = { config: { url: 'deck', data: [] }, moxfield: {} as MoxfieldDeck, cards };
    for (const c of cards) {
        ctx.cards[c.card.id] = {
            scryfallCard: { name: c.card.id, image_uris: { png: `https://img/front/${c.card.id}.png` } } as unknown as ScryfallCard,
            moxfieldCard: c
        };
    }
    return ctx;
}

function queued(ctx: ReturnType<typeof createContext>, state: ProcessingState) {
    return ctx.queues[state].cards.map(x => `${x.id}:${x.group}:${x.face}`);
}

test('split mode enqueues a card once per finish group it appears in', () => {
    const ctx = contextWith([card('A', 'foil'), card('A', 'nonFoil'), card('B', 'nonFoil')]);
    enqueueCards(ctx, { ...DefaultOrder, foilMode: 'split', states: [] });

    assert.deepEqual(queued(ctx, ProcessingState.NotDownloaded).sort(), ['A:foil:front', 'A:nonfoil:front', 'B:nonfoil:front']);
});

test('restoring one group of a card still enqueues its other group', () => {
    const ctx = contextWith([card('A', 'foil'), card('A', 'nonFoil')]);
    const done: CardQueueItem = { id: 'A', face: 'front', group: 'foil', scryfallUrl: '', path: 'A-0-front.jpg', state: ProcessingState.Converted };
    enqueueCards(ctx, { ...DefaultOrder, foilMode: 'split', states: [done] });

    assert.deepEqual(queued(ctx, ProcessingState.Converted), ['A:foil:front']);
    assert.deepEqual(queued(ctx, ProcessingState.NotDownloaded), ['A:nonfoil:front']);
});

test('legacy states without a group restore into the order-level group', () => {
    const ctx = contextWith([card('A', 'foil')]);
    const legacy = { id: 'A', face: 'front', scryfallUrl: '', path: 'A-0-front.jpg', state: ProcessingState.Converted } as CardQueueItem;
    const order: Order = { ...DefaultOrder, foilMode: 'none', states: [legacy] };
    enqueueCards(ctx, order);

    assert.deepEqual(queued(ctx, ProcessingState.Converted), ['A:nonfoil:front']);
    assert.deepEqual(queued(ctx, ProcessingState.NotDownloaded), []);
});

test('restored items that were never downloaded stay queued', () => {
    const ctx = contextWith([card('A', 'nonFoil')]);
    const pending: CardQueueItem = { id: 'A', face: 'front', group: 'nonfoil', scryfallUrl: '', path: 'A-0-front.png', state: ProcessingState.NotDownloaded };
    enqueueCards(ctx, { ...DefaultOrder, foilMode: 'none', states: [pending] });

    assert.deepEqual(queued(ctx, ProcessingState.NotDownloaded), ['A:nonfoil:front']);
});
