export enum ProcessingState {
    NotDownloaded = "not-downloaded",
    Downloaded = "downloaded",
    Upscaled = "upscaled",
    PostProcessed = "post-processed",
    Converted = "converted",
}

export type FinishGroup = 'foil' | 'nonfoil';

export interface CardQueueItem {
    id: string,
    face: 'front' | 'back',
    group: FinishGroup,
    scryfallUrl: string,
    path: string,
    state: ProcessingState
}

export interface Queue {
    cards: CardQueueItem[],
    done: boolean
}

export interface Queues {
    [ProcessingState.NotDownloaded]: Queue,
    [ProcessingState.Downloaded]: Queue,
    [ProcessingState.Upscaled]: Queue,
    [ProcessingState.PostProcessed]: Queue,
    [ProcessingState.Converted]: Queue
}
