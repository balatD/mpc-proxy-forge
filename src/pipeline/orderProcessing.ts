import { type DeckConfig, DeckData, type FoilMode, type Order, saveOrder } from "../config/orderConfigManager.js";
import { type CardQueueItem, type FinishGroup, ProcessingState, type Queue, type Queues } from "./types.js";
import { delay, Listr, type ListrTask } from "listr2";
import {
    getMoxfieldDetails,
    type MoxfieldBoard,
    type MoxfieldCardPrintingData,
    type MoxfieldDeck
} from "../clients/moxfield.js";
import { DefaultProfile, type ProcessingProfile } from "../config/processingProfileManager.js";
import { ui } from "../ui/theme.js";
import chalk from "chalk";
import { downloadScryfallImage, findScryfallCard, type ScryfallCard } from "../clients/scryfall.js";
import path from "node:path";
import { upscaleImage } from "./upscayl.js";
import { exists } from "../utils/fs.js";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { applyPrintCompensation, postProcessImage } from "./postProcessing.js";
import { createMpcAutofillOrder, finishGroup } from "../output/mpcAutofill.js";
import { confirmDialog } from "../utils/dialog.js";
import { spawn } from "node:child_process";

interface Context {
    decks: {
        [url: string]: {
            config: DeckConfig,
            moxfield: MoxfieldDeck,
            cards: MoxfieldCardPrintingData[]
        }
    },
    cards: {
        [moxfieldId: string]: {
            scryfallCard: ScryfallCard,
            moxfieldCard: MoxfieldCardPrintingData
        }
    },
    queues: Queues,
    stats: {
        total: number,
        downloaded: number,
        upscaled: number,
        postProcessed: number,
        converted: number
    },
    missingCards: Record<string, string>,
    mpcOrders: { group: FinishGroup, dir: string, quantity: number }[],
    aborted: boolean
}

export async function processOrder(order: Order) {
    console.clear();
    console.log(ui.title(`Processing Order: ${order.name}`));
    console.log('Downloading and post-processing your card images before upscaling and creating the final XML file for MPC Autofill.\n');

    const processingProfile = order.profile;

    const mainDir = path.join(processingProfile.outputDirectory, order.name);
    const cardsDirFor = (group: FinishGroup) => path.join(groupDir(mainDir, group, order.foilMode), 'cards');

    const context = createContext();

    try {
        const initialTasks = new Listr([
            loadDeckDetails(order, processingProfile),
            collectCardDetails(),
        ]);

        await initialTasks.run(context);

        if (Object.keys(context.missingCards).length > 0) {
            console.log(ui.attention(`The following cards were not found on Scryfall and will be skipped:`));
            Object.values(context.missingCards).forEach(name => console.log(`- ${name}`));

            console.log(ui.information('You can still process the order, but some images will be missing.'));
            const choice = await confirmDialog('Do you want to process the order anyway?', true);
            if (!choice) {
                context.aborted = true;
                throw new Error('Order processing cancelled by user');
            }
        }

        const lowResCards = Object.values(context.cards).filter(x => x.scryfallCard.image_status === 'lowres');
        if (lowResCards.length > 0) {
            console.log(ui.attention(`The following cards are reported by Scryfall as low-resolution:`));
            lowResCards.forEach(card => console.log(`- ${card.scryfallCard.name} (${card.scryfallCard.set.toUpperCase()} ${card.scryfallCard.collector_number})`));

            console.log(ui.information('You can still process the order, but the proxy quality of these images may be lower than expected.'));
            const choice = await confirmDialog('Do you want to process the order anyway?', true);
            if (!choice) {
                context.aborted = true;
                throw new Error('Order processing cancelled by user');
            }
        }

        const processingTasks = new Listr([
            runImagePipeline(order, cardsDirFor, processingProfile),
            writeMpcXml(order, mainDir)
        ]);

        await processingTasks.run(context);
        console.log('\n' + ui.success(`Order processing complete. You can find your files at ${mainDir}`));
        console.log(ui.information('To complete your order, move these files to the MPC Autofill directory or copy the autofill binary to the this directory and run it.'));
    } catch (err) {
        console.error('\n' + ui.error('An error occurred:'), err);
    }

    order.states = [];
    Object.values(context.queues).map((x: Queue) => x.cards).reduce((acc, val) => [...acc, ...val], []).forEach(item => {
        order.states.push(item);
    });

    await saveOrder(order);
    await offerMpcAutofill(processingProfile, context.mpcOrders);

    if (await confirmDialog('\nDo you want to exit the application?', true)) {
        process.exit(0);
    }
}

export function createContext(): Context {
    return {
        decks: {},
        cards: {},
        queues: {
            [ProcessingState.NotDownloaded]: { cards: [], done: false },
            [ProcessingState.Downloaded]: { cards: [], done: false },
            [ProcessingState.Upscaled]: { cards: [], done: false },
            [ProcessingState.PostProcessed]: { cards: [], done: false },
            [ProcessingState.Converted]: { cards: [], done: false },
        },
        stats: {
            total: 0,
            downloaded: 0,
            upscaled: 0,
            postProcessed: 0,
            converted: 0
        },
        missingCards: {},
        mpcOrders: [],
        aborted: false
    };
}

function loadDeckDetails(order: Order, profile: ProcessingProfile): ListrTask {
    return {
        title: `Loading Moxfield deck details`,
        task: async (ctx: Context, task) => {
            const subTasks = order.decks.map((deck) => {
                return {
                    title: `Loading details for ${chalk.green(deck.url)}`,
                    task: async () => {
                        const details = await getMoxfieldDetails(deck, profile.playwrightChannel);
                        ctx.decks[deck.url] = {
                            config: deck,
                            moxfield: details,
                            cards: []
                        };
                    }
                }
            });

            return task.newListr(subTasks, { concurrent: true });
        }
    };
}

function collectCardDetails(): ListrTask {
    return {
        title: 'Collecting card details',
        task: async (ctx: Context, task) => {
            const subTasks = Object.values(ctx.decks).map(deck => {
                return {
                    title: `Collecting ${chalk.green(deck.moxfield.name)} card details`,
                    task: async (_, subtask) => {
                        const boardsToInclude = ['commanders', 'companions', ...deck.config.data, 'signatureSpells'];

                        const cards = boardsToInclude
                            .map(board => (deck.moxfield.boards as any)[board])
                            .flatMap((board: MoxfieldBoard) => Object.values(board.cards))
                            .flatMap(card => card.printingData || [card]);

                        if (deck.config.data.includes(DeckData.Tokens)) {
                            deck.moxfield.tokens.filter(token => token.isToken).forEach(token => {
                                cards.push({
                                    quantity: 1,
                                    card: token
                                });
                            });
                        }

                        deck.cards = cards;

                        subtask.title = `Collecting ${chalk.green(deck.moxfield.name)} card details (0/${cards.length})`;

                        for (let i = 0; i < cards.length; i++) {
                            subtask.title = `Collecting ${chalk.green(deck.moxfield.name)} card details (${i + 1}/${cards.length})`;

                            const card = cards[i]!;
                            if (Object.keys(ctx.cards).includes(card.card.id)) continue;

                            const scryfallCard = await findScryfallCard(card.card);
                            if (!scryfallCard) {
                                ctx.missingCards[card.card.id] = `${card.card.name} (${card.card.set.toUpperCase()} ${card.card.cn})`;
                                continue;
                            }

                            ctx.cards[card.card.id] = {
                                scryfallCard: scryfallCard,
                                moxfieldCard: card
                            };
                        }
                    }
                } as ListrTask
            })

            return task.newListr(subTasks, { concurrent: false });
        }
    };
}


function runImagePipeline(order: Order, cardsDirFor: (group: FinishGroup) => string, profile: ProcessingProfile): ListrTask {
    return {
        title: 'Processing order images',
        task: async (ctx: Context, task) => {
            if (ctx.aborted) return;
            enqueueCards(ctx, order);

            const groups = new Set(Object.values(ctx.queues).flatMap((x: Queue) => x.cards).map(x => x.group));
            for (const group of groups) {
                await mkdir(cardsDirFor(group), { recursive: true });
            }

            return task.newListr(createPipelineTasks(cardsDirFor, profile), { concurrent: true });
        }
    };
}

export function enqueueCards(ctx: Context, order: Order) {
    const groupsByCard = new Map<string, Set<FinishGroup>>();
    for (const card of Object.values(ctx.decks).flatMap(deck => deck.cards)) {
        const groups = groupsByCard.get(card.card.id) ?? new Set<FinishGroup>();
        groups.add(finishGroup(card, order.foilMode));
        groupsByCard.set(card.card.id, groups);
    }

    for (const [index, key] of Object.keys(ctx.cards).entries()) {
        const card = ctx.cards[key]!;

        const frontImage = card.scryfallCard.image_uris?.png || card.scryfallCard.card_faces?.at(0)?.image_uris?.png;
        if (!frontImage) {
            console.log(chalk.red(`Front image URL not found: ${card.scryfallCard.name}`));
            return;
        }

        const backImage = card.scryfallCard.card_faces?.find(face => !!face.image_uris && face.image_uris.png.includes('/back/'))?.image_uris?.png;

        for (const group of groupsByCard.get(key) ?? []) {
            ctx.queues[ProcessingState.NotDownloaded].cards.push({
                id: key,
                face: 'front',
                group,
                scryfallUrl: frontImage,
                path: `${key}-${index}-front.png`,
                state: ProcessingState.NotDownloaded
            });

            if (backImage) {
                ctx.queues[ProcessingState.NotDownloaded].cards.push({
                    id: key,
                    face: 'back',
                    group,
                    scryfallUrl: backImage,
                    path: `${key}-${index}-back.png`,
                    state: ProcessingState.NotDownloaded
                });
            }
        }
    }

    // States saved before the foil split have no group; they belong to the order's single output.
    const legacyGroup: FinishGroup = order.foilMode === 'all' ? 'foil' : 'nonfoil';
    const restored = order.states
        .filter(item => item.state !== ProcessingState.NotDownloaded)
        .map(item => ({ ...item, group: item.group ?? legacyGroup }));

    restored.forEach(item => ctx.queues[item.state].cards.push(item));

    ctx.queues[ProcessingState.NotDownloaded].cards = ctx.queues[ProcessingState.NotDownloaded].cards
        .filter(x => !restored.some(it => it.id === x.id && it.group === x.group && it.face === x.face));

    ctx.stats = {
        total: Object.values(ctx.queues).map(x => x.cards.length).reduce((acc, val) => acc + val, 0),
        downloaded: ctx.queues[ProcessingState.Downloaded].cards.length,
        upscaled: ctx.queues[ProcessingState.Upscaled].cards.length,
        postProcessed: ctx.queues[ProcessingState.PostProcessed].cards.length,
        converted: ctx.queues[ProcessingState.Converted].cards.length,
    };
}

function createPipelineTasks(cardsDirFor: (group: FinishGroup) => string, profile: ProcessingProfile): ListrTask[] {
    return [
        pipelineStage({
            title: 'Downloading card images',
            queueState: ProcessingState.NotDownloaded,
            nextState: ProcessingState.Downloaded,
            statKey: 'downloaded',
            handler: async (_ctx, item) => {
                await downloadScryfallImage(item.scryfallUrl, path.join(cardsDirFor(item.group), item.path));
            }
        }),
        pipelineStage({
            title: 'Post-processing card images',
            previousState: ProcessingState.NotDownloaded,
            queueState: ProcessingState.Downloaded,
            nextState: ProcessingState.PostProcessed,
            statKey: 'postProcessed',
            handler: async (ctx, item) => {
                const card = ctx.cards[item.id]!;
                await postProcessImage(path.join(cardsDirFor(item.group), item.path), card, item.face, profile.postProcessing);
            }
        }),
        pipelineStage({
            title: 'Upscaling card images',
            previousState: ProcessingState.Downloaded,
            queueState: ProcessingState.PostProcessed,
            nextState: ProcessingState.Upscaled,
            statKey: 'upscaled',
            skip: !profile.upscaling.enabled,
            handler: async (_ctx, item) => {
                await upscaleImage(path.join(cardsDirFor(item.group), item.path), profile.postProcessing, profile.upscaling);
            }
        }),
        pipelineStage({
            title: 'Converting card images to JPEG',
            previousState: ProcessingState.PostProcessed,
            queueState: ProcessingState.Upscaled,
            nextState: ProcessingState.Converted,
            statKey: 'converted',
            handler: async (_ctx, item) => {
                const jpegFileName = toJpegName(item.path);
                const pngPath = path.join(cardsDirFor(item.group), item.path);
                const jpegPath = path.join(cardsDirFor(item.group), jpegFileName);

                const colorCorrection = profile.postProcessing.colorCorrection ?? DefaultProfile.postProcessing.colorCorrection;
                const image = await applyPrintCompensation(pngPath, colorCorrection[item.group]);
                await image.jpeg({ quality: 100 }).toFile(jpegPath);
                await unlink(pngPath);
                item.path = jpegFileName;
            }
        })
    ];
}

interface PipelineStageOptions {
    title: string,
    previousState?: ProcessingState,
    queueState: ProcessingState,
    nextState: ProcessingState,
    statKey: 'downloaded' | 'upscaled' | 'postProcessed' | 'converted',
    handler: (ctx: Context, item: CardQueueItem) => Promise<void>,
    skip?: boolean
}

function pipelineStage(options: PipelineStageOptions): ListrTask {
    return {
        title: options.title,
        task: async (ctx: Context, subtask) => {
            if (options.skip) {
                subtask.title = `${options.title} (skipped)`;
            }

            const previousQueue = options.previousState ? ctx.queues[options.previousState] : undefined;
            const queue = ctx.queues[options.queueState];
            const nextQueue = ctx.queues[options.nextState];

            while (!ctx.aborted && ((previousQueue ? !previousQueue.done : false) || queue.cards.length > 0)) {
                while (!ctx.aborted && queue.cards.length === 0) {
                    await delay(100);
                }

                if (ctx.aborted || queue.cards.length === 0) break;

                if (!options.skip) {
                    subtask.title = `${options.title} (${ctx.stats[options.statKey] + 1}/${ctx.stats.total})`;
                }

                const item = queue.cards.shift()!;
                try {
                    if (!options.skip) {
                        await options.handler(ctx, item);
                    }
                } catch (err) {
                    // Keep the in-flight item in its queue so it is not lost on resume
                    // and signal all other concurrent stages to stop mutating files/state.
                    queue.cards.unshift(item);
                    ctx.aborted = true;
                    throw err;
                }

                ctx.stats[options.statKey]++;
                item.state = options.nextState;
                nextQueue.cards.push(item);
            }

            queue.done = true;
        }
    };
}

function toJpegName(fileName: string) {
    return fileName.replace(/\.png$/i, '.jpg');
}

function writeMpcXml(order: Order, mainDir: string): ListrTask {
    return {
        title: 'Creating MPC Autofill XML',
        task: async (ctx: Context) => {
            if (ctx.aborted) return;

            const cardsToOrder = Object.values(ctx.decks).map(x => x.cards).reduce((acc, val) => [...acc, ...val], []);
            const processedItems = Object.values(ctx.queues).map(x => x.cards).reduce((acc, val) => [...acc, ...val], []);

            for (const group of ['foil', 'nonfoil'] as const) {
                const cards = cardsToOrder.filter(card => finishGroup(card, order.foilMode) === group);
                if (cards.length === 0) continue;

                const dir = groupDir(mainDir, group, order.foilMode);
                const xml = createMpcAutofillOrder(order, processedItems.filter((item: CardQueueItem) => item.group === group), cards, group === 'foil');
                await writeFile(path.join(dir, 'cards.xml'), xml);

                ctx.mpcOrders.push({ group, dir, quantity: cards.reduce((acc, card) => acc + card.quantity, 0) });
            }
        }
    };
}

function groupDir(mainDir: string, group: FinishGroup, foilMode: FoilMode) {
    return foilMode === 'split' ? path.join(mainDir, group) : mainDir;
}

async function offerMpcAutofill(profile: ProcessingProfile, orders: Context['mpcOrders']) {
    if (orders.length === 0) return;

    const binary = path.resolve(profile.autofillBinary ?? DefaultProfile.autofillBinary);
    if (!await exists(binary)) {
        console.log(ui.information(`MPC Autofill was not found at ${binary}. Set its path in the processing profile to start it from here.`));
        return;
    }

    for (const { group, dir, quantity } of orders) {
        const label = group === 'foil' ? 'foil' : 'non-foil';
        if (!await confirmDialog(`\nStart MPC Autofill for the ${label} order (${quantity} cards)?`, true)) continue;

        await new Promise<void>((resolve, reject) => {
            spawn(binary, ['--directory', path.resolve(dir)], { cwd: dir, stdio: 'inherit' })
                .on('error', reject)
                .on('exit', () => resolve());
        });
    }
}
