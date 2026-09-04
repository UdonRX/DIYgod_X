import type { Context } from 'hono';
import xxhash from 'xxhash-wasm';

import { config } from '@/config';
import type { Data, DataItem } from '@/types';
import cacheModule from '@/utils/cache/index';
import logger from '@/utils/logger';

const { h64ToString } = await xxhash();

const getPositiveInt = (value: string | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER) => {
    const parsed = Number.parseInt(value || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
};

const isHistoryEnabled = () => {
    const value = process.env.HISTORY_CACHE_ENABLED?.toLowerCase();
    if (value === 'false' || value === '0' || value === 'off') {
        return false;
    }
    if (value === 'true' || value === '1' || value === 'on') {
        return true;
    }
    return config.cache.type === 'redis';
};

const getHistoryOptions = () => {
    const historyMax = getPositiveInt(process.env.HISTORY_CACHE_MAX, 100, 1000);
    const outputMax = Math.min(getPositiveInt(process.env.FEED_OUTPUT_MAX, 60, 1000), historyMax);
    const expire = getPositiveInt(process.env.HISTORY_CACHE_EXPIRE, 365 * 24 * 60 * 60);
    return { historyMax, outputMax, expire };
};

const getHistoryKey = (ctx: Context) => {
    const url = new URL(ctx.req.url);
    url.searchParams.delete('format');
    url.searchParams.delete('limit');

    const query = [...url.searchParams.entries()]
        .toSorted(([keyA, valueA], [keyB, valueB]) => keyA.localeCompare(keyB) || valueA.localeCompare(valueB))
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');

    return 'rsshub:history:v1:' + h64ToString(ctx.req.path + (query ? `?${query}` : ''));
};

const getItemIdentity = (item: DataItem) => {
    if (item.guid) return `guid:${item.guid}`;
    if (item.id) return `id:${item.id}`;
    if (item.link) return `link:${item.link}`;
    return `fallback:${h64ToString(`${item.title || ''}\u0000${item.pubDate || ''}\u0000${item.description || ''}`)}`;
};

const getItemTime = (item: DataItem) => {
    const value = item.pubDate || item.updated;
    if (!value) return 0;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
};

const mergeHistory = (current: DataItem[], previous: DataItem[], maximum: number) => {
    const items = new Map<string, DataItem>();
    for (const item of [...current, ...previous]) {
        const identity = getItemIdentity(item);
        if (!items.has(identity)) items.set(identity, item);
    }
    return [...items.values()].toSorted((a, b) => getItemTime(b) - getItemTime(a)).slice(0, maximum);
};

export const markPersistentHistoryRouteHit = (ctx: Context, data: Data) => {
    if (!isHistoryEnabled() || !data.item) return;
    ctx.header('RSSHub-History-Status', 'ROUTE_HIT');
    ctx.header('RSSHub-History-Output', String(data.item.length));
};

export const applyPersistentHistory = async (ctx: Context, data: Data, options: { readOnly?: boolean } = {}) => {
    if (!isHistoryEnabled() || !data.item) return;

    const { historyMax, outputMax, expire } = getHistoryOptions();
    const redisClient = cacheModule.clients.redisClient;

    if (!redisClient || !cacheModule.status.available) {
        data.item = data.item.slice(0, outputMax);
        ctx.header('RSSHub-History-Status', 'NO_REDIS');
        ctx.header('RSSHub-History-Output', String(data.item.length));
        return;
    }

    const historyKey = getHistoryKey(ctx);

    try {
        const cached = await redisClient.get(historyKey);
        let previous: DataItem[] = [];
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (Array.isArray(parsed)) previous = parsed;
            } catch (error) {
                logger.warn(`Ignoring invalid RSS history cache for ${ctx.req.path}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        const history = mergeHistory(data.item, previous, historyMax);
        if (!options.readOnly) {
            await redisClient.set(historyKey, JSON.stringify(history), 'EX', expire);
        }

        data.item = history.slice(0, outputMax);
        ctx.header('RSSHub-History-Status', options.readOnly ? (cached ? 'READ_ONLY_HIT' : 'READ_ONLY_MISS') : cached ? 'HIT' : 'MISS');
        ctx.header('RSSHub-History-Items', String(history.length));
        ctx.header('RSSHub-History-Output', String(data.item.length));
    } catch (error) {
        data.item = data.item.slice(0, outputMax);
        ctx.header('RSSHub-History-Status', 'ERROR');
        ctx.header('RSSHub-History-Output', String(data.item.length));
        logger.warn(`RSS history cache failed for ${ctx.req.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
};
