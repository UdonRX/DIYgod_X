import type { Context } from 'hono';
import xxhash from 'xxhash-wasm';

import { config } from '@/config';
import type { Data } from '@/types';
import cacheModule from '@/utils/cache/index';

const { h64ToString } = await xxhash();

const getPositiveInt = (value: string | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER) => {
    const parsed = Number.parseInt(value || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
};

const getHistoryOptions = () => {
    const historyMax = getPositiveInt(process.env.HISTORY_CACHE_MAX, 100, 1000);
    const outputMax = Math.min(getPositiveInt(process.env.FEED_OUTPUT_MAX, 60, 1000), historyMax);
    return { historyMax, outputMax };
};

const parseStoredItems = (value: string | null) => {
    if (!value) {
        return null;
    }
    try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
            return parsed.length;
        }
        const data = parsed as Data;
        return Array.isArray(data.item) ? data.item.length : null;
    } catch {
        return null;
    }
};

const handler = async (ctx: Context) => {
    ctx.header('Cache-Control', 'no-store');

    const target = ctx.req.query('path');
    if (!target || !target.startsWith('/') || target.startsWith('//') || target.includes('://')) {
        return ctx.json(
            {
                ok: false,
                error: 'Specify an RSSHub path, for example: /debug/history?path=/twitter/list/2087706843519111304',
            },
            400
        );
    }

    const redisClient = cacheModule.clients.redisClient;
    if (!redisClient || !cacheModule.status.available) {
        return ctx.json(
            {
                ok: false,
                redis: 'disconnected',
                error: 'Redis is not connected.',
            },
            503
        );
    }

    const targetUrl = new URL(target, 'https://rsshub.local');
    const requestPath = targetUrl.pathname;

    const historyParams = new URLSearchParams(targetUrl.searchParams);
    historyParams.delete('format');
    historyParams.delete('limit');
    const normalizedHistoryQuery = [...historyParams.entries()]
        .toSorted(([keyA, valueA], [keyB, valueB]) => keyA.localeCompare(keyB) || valueA.localeCompare(valueB))
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
    const historyKey = 'rsshub:history:v1:' + h64ToString(requestPath + (normalizedHistoryQuery ? `?${normalizedHistoryQuery}` : ''));

    const format = `:${targetUrl.searchParams.get('format') || config.format}`;
    const requestedLimit = targetUrl.searchParams.get('limit');
    const limitKey = requestedLimit ? `:${requestedLimit}` : '';
    const routeCacheKey = 'rsshub:koa-redis-cache:' + h64ToString(requestPath + format + limitKey);

    const [historyValue, routeCacheValue, historyTtl] = await Promise.all([redisClient.get(historyKey), redisClient.get(routeCacheKey), redisClient.ttl(historyKey)]);

    const historyItems = parseStoredItems(historyValue) ?? 0;
    const cachedOutputItems = parseStoredItems(routeCacheValue);
    const { historyMax, outputMax } = getHistoryOptions();
    const parsedLimit = requestedLimit ? Number.parseInt(requestedLimit, 10) : null;
    const finalOutputMax = parsedLimit && parsedLimit > 0 ? Math.min(outputMax, parsedLimit) : outputMax;
    const expectedOutputItems = Math.min(historyItems, finalOutputMax);

    const status = historyItems > historyMax || (cachedOutputItems !== null && cachedOutputItems > outputMax) ? 'NG' : 'OK';

    return ctx.json({
        ok: status === 'OK',
        status,
        target: targetUrl.pathname + targetUrl.search,
        redis: 'connected',
        history: {
            key: historyKey,
            items: historyItems,
            max: historyMax,
            remainingUntilMax: Math.max(historyMax - historyItems, 0),
            ttlSeconds: historyTtl,
        },
        rss: {
            configuredMax: outputMax,
            requestedLimit: parsedLimit && parsedLimit > 0 ? parsedLimit : null,
            expectedOutputItems,
            routeCachePresent: routeCacheValue !== null,
            cachedItemsBeforeParameterLimit: cachedOutputItems,
        },
        checks: {
            historyWithinMax: historyItems <= historyMax,
            cachedRssWithinMax: cachedOutputItems === null ? null : cachedOutputItems <= outputMax,
        },
        note: 'This endpoint only reads Redis metadata. It does not fetch or modify the target RSS feed.',
    });
};

export default handler;
