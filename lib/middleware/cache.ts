import type { Context, MiddlewareHandler } from 'hono';
import xxhash from 'xxhash-wasm';

import { config } from '@/config';
import RequestInProgressError from '@/errors/types/request-in-progress';
import type { Data, DataItem } from '@/types';
import cacheModule from '@/utils/cache/index';
import logger from '@/utils/logger';

const bypassList = new Set(['/', '/robots.txt', '/logo.png', '/favicon.ico']);

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
    // Redis deployments enable history by default. Other cache backends keep RSSHub's upstream behaviour.
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
    // These only change the rendered response and must not split the persistent article history.
    url.searchParams.delete('format');
    url.searchParams.delete('limit');

    const query = [...url.searchParams.entries()]
        .toSorted(([keyA, valueA], [keyB, valueB]) => keyA.localeCompare(keyB) || valueA.localeCompare(valueB))
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');

    return 'rsshub:history:v1:' + h64ToString(ctx.req.path + (query ? `?${query}` : ''));
};

const getItemIdentity = (item: DataItem) => {
    if (item.guid) {
        return `guid:${item.guid}`;
    }
    if (item.id) {
        return `id:${item.id}`;
    }
    if (item.link) {
        return `link:${item.link}`;
    }
    return `fallback:${h64ToString(`${item.title || ''}\u0000${item.pubDate || ''}\u0000${item.description || ''}`)}`;
};

const getItemTime = (item: DataItem) => {
    const value = item.pubDate || item.updated;
    if (!value) {
        return 0;
    }
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
};

const mergeHistory = (current: DataItem[], previous: DataItem[], maximum: number) => {
    const items = new Map<string, DataItem>();

    // Current results win on duplicates so corrected titles/descriptions replace stale history.
    for (const item of [...current, ...previous]) {
        const identity = getItemIdentity(item);
        if (!items.has(identity)) {
            items.set(identity, item);
        }
    }

    return [...items.values()].toSorted((a, b) => getItemTime(b) - getItemTime(a)).slice(0, maximum);
};

const applyPersistentHistory = async (ctx: Context, data: Data) => {
    if (!isHistoryEnabled() || !data.item) {
        return;
    }

    const { historyMax, outputMax, expire } = getHistoryOptions();
    const redisClient = cacheModule.clients.redisClient;

    // Even when Redis is temporarily unavailable, keep the output cap deterministic.
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
                if (Array.isArray(parsed)) {
                    previous = parsed;
                }
            } catch (error) {
                logger.warn(`Ignoring invalid RSS history cache for ${ctx.req.path}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        const history = mergeHistory(data.item, previous, historyMax);
        await redisClient.set(historyKey, JSON.stringify(history), 'EX', expire);

        data.item = history.slice(0, outputMax);
        ctx.header('RSSHub-History-Status', cached ? 'HIT' : 'MISS');
        ctx.header('RSSHub-History-Items', String(history.length));
        ctx.header('RSSHub-History-Output', String(data.item.length));
    } catch (error) {
        // History is an enhancement: Redis trouble must never take the feed down.
        data.item = data.item.slice(0, outputMax);
        ctx.header('RSSHub-History-Status', 'ERROR');
        ctx.header('RSSHub-History-Output', String(data.item.length));
        logger.warn(`RSS history cache failed for ${ctx.req.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
};

// only give cache string, as the `!` condition tricky
// XXH64 is used to shrink key size
// plz, write these tips in comments!
const middleware: MiddlewareHandler = async (ctx, next) => {
    if (!cacheModule.status.available || bypassList.has(ctx.req.path)) {
        await next();
        return;
    }

    const requestPath = ctx.req.path;
    const format = `:${ctx.req.query('format') || config.format}`;
    const limit = ctx.req.query('limit') ? `:${ctx.req.query('limit')}` : '';
    const key = 'rsshub:koa-redis-cache:' + h64ToString(requestPath + format + limit);
    const controlKey = 'rsshub:path-requested:' + h64ToString(requestPath + format + limit);

    let value = await cacheModule.globalCache.get(key);

    // Doesn't hit the cache? Try to become the fetcher and let others know!
    let isRequesting = false;
    if (!value) {
        isRequesting = !(await cacheModule.globalCache.claim(controlKey, config.cache.requestTimeout));
    }

    if (isRequesting) {
        let retryTimes = process.env.NODE_ENV === 'test' ? 1 : 10;
        let bypass = false;
        while (retryTimes > 0) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, process.env.NODE_ENV === 'test' ? 3000 : 6000));
            // eslint-disable-next-line no-await-in-loop
            if ((await cacheModule.globalCache.get(controlKey)) !== '1') {
                bypass = true;
                break;
            }
            retryTimes--;
        }
        if (!bypass) {
            throw new RequestInProgressError('This path is currently fetching, please come back later!');
        }
        value = await cacheModule.globalCache.get(key);
    }

    if (value) {
        ctx.status(200);
        ctx.header('RSSHub-Cache-Status', 'HIT');
        const cachedData = JSON.parse(value) as Data;
        if (isHistoryEnabled() && cachedData.item) {
            ctx.header('RSSHub-History-Status', 'ROUTE_HIT');
            ctx.header('RSSHub-History-Output', String(cachedData.item.length));
        }
        ctx.set('data', cachedData);
        await next();
        return;
    }

    if (isRequesting) {
        // waited out a stale claim without finding a cache entry, take over the fetch
        await cacheModule.globalCache.set(controlKey, '1', config.cache.requestTimeout);
    }

    // let routers control cache
    ctx.set('cacheKey', key);
    ctx.set('cacheControlKey', controlKey);

    try {
        await next();
    } catch (error) {
        await cacheModule.globalCache.set(controlKey, '0', config.cache.requestTimeout);
        throw error;
    }

    const data: Data = ctx.get('data');
    if (ctx.res.headers.get('Cache-Control') !== 'no-cache' && data) {
        await applyPersistentHistory(ctx, data);
        data.lastBuildDate = new Date().toUTCString();
        ctx.set('data', data);
        const body = JSON.stringify(data);
        await cacheModule.globalCache.set(key, body, config.cache.routeExpire);
    }

    // We need to let it go, even no cache set.
    // Wait to set cache so the next request could be handled correctly
    await cacheModule.globalCache.set(controlKey, '0', config.cache.requestTimeout);
};

export default middleware;
