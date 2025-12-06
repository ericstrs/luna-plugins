import { LunaUnload, reduxStore, Tracer } from "@luna/core";
import { getCredentials, ipcRenderer, MediaItem, PlayState, redux, safeInterval } from "@luna/lib";
import { startServer, stopServer, updateFields } from "./index.native";
import { settings } from "./Settings";
import type { ActionData, ActionHandler } from "./types";

declare global {
    interface Window {
        __apiInvokeAction?: (data: ActionData & { action: string }) => Promise<unknown>;
    }
}

const stateUpdateInt = 250;
const portCheckInt = 5000;

export const { trace } = Tracer("[API]");
export const unloads = new Set<LunaUnload>();
export { Settings } from "./Settings";

const updateMediaFields = async (item: MediaItem | undefined) => {
    if (!item) return;

    const [album, artist, coverUrl, isrc] = await Promise.all([
        item.album(),
        item.artist(),
        item.coverUrl(),
        item.isrc()
    ]);

    updateFields({
        album: album?.tidalAlbum,
        artist: artist?.tidalArtist,
        track: item.tidalItem,
        coverUrl,
        isrc,
        duration: item.duration,
        bestQuality: item.bestQuality
    });
};

const updateStateFields = () => {
    const { playing, playTime, repeatMode, lastPlayStart, playQueue, shuffle, currentTime } = PlayState;
    const { playbackControls } = redux.store.getState();

    const state: Record<string, unknown> = { playing, playTime, repeatMode, playQueue, shuffle };

    if (!Number.isNaN(currentTime)) state.currentTime = currentTime;
    if (lastPlayStart && !Number.isNaN(lastPlayStart)) state.lastPlayStart = lastPlayStart;
    if (playbackControls.volume) state.volume = playbackControls.volume;

    updateFields(state);
};

const setVolume = (volume: number) => {
    redux.actions["playbackControls/SET_VOLUME"]({ volume });
};

const handleVolumeChange = (volume: string | number) => {
    if (typeof volume === "string" && /^[-+]\d+$/.test(volume)) {
        const currentVol = reduxStore.getState().playbackControls.volume || 0;
        const newVol = Math.max(0, Math.min(100, currentVol + Number.parseInt(volume, 10)));
        setVolume(newVol);
    } else if (typeof volume === "number" && volume >= 0 && volume <= 100) {
        setVolume(volume);
    }
};

const addToQueue = (itemId: string) => {
    redux.actions["playQueue/ADD_LAST"]({
        context: { type: "UNKNOWN", id: itemId },
        mediaItemIds: [itemId],
    });
};

const tidalApiFetch = async (path: string): Promise<any> => {
    const { clientId, token } = await getCredentials();
    const store = redux.store.getState();
    const countryCode = store.session.countryCode;
    const locale = store.settings.language;
    const sep = path.includes("?") ? "&" : "?";
    const url = `https://desktop.tidal.com/v1${path}${sep}countryCode=${countryCode}&locale=${locale}&deviceType=DESKTOP`;
    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${token}`,
            "x-tidal-token": clientId,
        },
    });
    if (!res.ok) throw new Error(`Tidal API ${path}: ${res.status} ${res.statusText}`);
    return res.json();
};

const tidalCoverUrl = (cover: string | null | undefined): string | null =>
    cover ? `https://resources.tidal.com/images/${cover.replace(/-/g, "/")}/320x320.jpg` : null;

const extractLabel = (copyright: string | null | undefined): string | null => {
    if (!copyright) return null;
    const cleaned = copyright.replace(/^[\u2117\u00a9]\s*/, "").replace(/^\d{4}\s*/, "").trim();
    return cleaned || null;
};

const mapTrack = (track: any, albumOverride?: { title?: string; id?: number; cover?: string | null; releaseDate?: string | null }) => ({
    id: track.id,
    title: track.title,
    duration: track.duration,
    isrc: track.isrc,
    artist: track.artist?.name || track.artists?.[0]?.name,
    artistId: track.artist?.id || track.artists?.[0]?.id,
    album: albumOverride?.title ?? track.album?.title,
    albumId: albumOverride?.id ?? track.album?.id,
    coverUrl: tidalCoverUrl(albumOverride?.cover ?? track.album?.cover),
    trackNumber: track.trackNumber,
    discNumber: track.volumeNumber,
    year: (() => {
        const date = albumOverride?.releaseDate ?? track.album?.releaseDate;
        return date ? parseInt(date.substring(0, 4), 10) : null;
    })(),
    copyright: extractLabel(track.copyright),
});

const playTrackById = async (rawId: string | number) => {
    const numericId = typeof rawId === "string" ? parseInt(rawId, 10) : rawId;
    try {
        const item = await MediaItem.fromId(numericId);
        if (item) {
            item.play();
            return;
        }
    } catch (e) {
        trace.msg.warn(`playTrack MediaItem error: ${e}`);
    }
    PlayState.play(numericId);
};

const rendererActions: Record<string, (data: ActionData) => unknown> = {
    pause: PlayState.pause,
    resume: () => PlayState.play(),
    toggle: () => (PlayState.playing ? PlayState.pause() : PlayState.play()),
    next: PlayState.next,
    previous: PlayState.previous,
    setRepeatMode: (data) => typeof data.mode === "number" && PlayState.setRepeatMode(data.mode),
    setShuffleMode: (data) => {
        if (typeof data.shuffle === "boolean") {
            data.shuffle ? PlayState.setShuffle(true, true) : PlayState.setShuffle(false, true);
        }
    },
    seek: (data) => typeof data.time === "number" && PlayState.seek(data.time),
    volume: (data) => handleVolumeChange(data.volume as string | number),
    playNext: (data) => data.itemId && PlayState.playNext(data.itemId as string),
    addToQueue: (data) => data.itemId && addToQueue(data.itemId as string),
    playTrack: async (data) => {
        if (!data.itemId) return;
        await playTrackById(data.itemId as string | number);
    },
    search: async (data) => {
        const query = data.query as string | undefined;
        if (!query) throw new Error("search: query required");
        const limit = (data.limit as number | undefined) ?? 10;
        const results = await tidalApiFetch(`/search?query=${encodeURIComponent(query)}&limit=${limit}`);
        return { tracks: (results.tracks?.items ?? []).map((t: any) => mapTrack(t)) };
    },
    searchAlbums: async (data) => {
        const query = data.query as string | undefined;
        if (!query) throw new Error("searchAlbums: query required");
        const limit = (data.limit as number | undefined) ?? 10;
        const results = await tidalApiFetch(`/search?query=${encodeURIComponent(query)}&limit=${limit}`);
        const albums = (results.albums?.items ?? []).map((album: any) => ({
            id: album.id,
            title: album.title,
            artist: album.artist?.name || album.artists?.[0]?.name,
            artistId: album.artist?.id || album.artists?.[0]?.id,
            coverUrl: tidalCoverUrl(album.cover),
            releaseDate: album.releaseDate,
            numberOfTracks: album.numberOfTracks,
        }));
        return { albums };
    },
    getAlbumTracks: async (data) => {
        const albumId = data.albumId as number | string | undefined;
        if (albumId === undefined) throw new Error("getAlbumTracks: albumId required");
        const [albumData, tracksData] = await Promise.all([
            tidalApiFetch(`/albums/${albumId}`),
            tidalApiFetch(`/albums/${albumId}/tracks`),
        ]);
        const albumOverride = {
            title: albumData.title,
            id: albumData.id,
            cover: albumData.cover,
            releaseDate: albumData.releaseDate,
        };
        const tracks = (tracksData.items ?? []).map((t: any) => mapTrack(t, albumOverride));
        return {
            album: {
                id: albumData.id,
                title: albumData.title,
                artist: albumData.artist?.name || albumData.artists?.[0]?.name,
                coverUrl: tidalCoverUrl(albumData.cover),
                numberOfTracks: albumData.numberOfTracks,
            },
            tracks,
        };
    },
};

startServer(settings.port);
unloads.add(stopServer.bind(null));

let lastPort = settings.port;
safeInterval(unloads, () => {
    if (settings.port !== lastPort) {
        lastPort = settings.port;
        stopServer().then(() => {
            startServer(settings.port);
            trace.msg.log("Restarted server on port", settings.port);
        });
    }
}, portCheckInt);

MediaItem.fromPlaybackContext().then(updateMediaFields);
MediaItem.onMediaTransition(unloads, updateMediaFields);
PlayState.onState(unloads, updateStateFields);
safeInterval(unloads, updateStateFields, stateUpdateInt);

window.__apiInvokeAction = async (data: ActionData & { action: string }) => {
    const handler = rendererActions[data.action];
    if (handler) {
        const result = await handler(data);
        updateStateFields();
        return result;
    }
    return undefined;
};
unloads.add(() => {
    delete window.__apiInvokeAction;
});

ipcRenderer.on(unloads, "api.playback.control", async (data) => {
    rendererActions[data.action]?.(data);
    updateStateFields();
});




/**
 * Register a new action handler for the API.
 * @param unloadsFn - Your plugin unloads set
 * @param name - The action name (used in HTTP/WebSocket requests)
 * @param handler - The function to execute when the action is triggered
 * @returns A function to unregister the action (same one is added to unloadsFn so do NOT call it manually unless you want to remove it early)
 */
export const registerAction = (
    unloadsFn: Set<LunaUnload>,
    name: string,
    handler: ActionHandler
) => {
    if (rendererActions[name]) {
        trace.msg.warn(`Action "${name}" already exists, overwriting`);
    }
    let registered = true;
    rendererActions[name] = handler;
    const unregister = () => {
        if (registered) {
            registered = false;
            delete rendererActions[name];
        }
    };
    unloadsFn.add(unregister);
    unloads.add(unregister);
    return unregister;
};


export type { ActionData, ActionHandler } from "./types";
export { updateFields as updateAPIFields };

