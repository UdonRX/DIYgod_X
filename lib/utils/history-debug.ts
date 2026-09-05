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
    const outputMax = Math.min(getPositiveInt(process.env.FEED_OUTPUT_MAX, 100, 1000), historyMax);
    return { historyMax, outputMax };
};

const parseStoredItems = (value: string | null) => {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed.length;
        const data = parsed as Data;
        return Array.isArray(data.item) ? data.item.length : null;
    } catch { return null; }
};

const countRenderedItems = (body: string, contentType: string) => {
    if (contentType.includes('json')) {
        try {
            const parsed = JSON.parse(body);
            if (Array.isArray(parsed?.items)) return { format: 'json', items: parsed.items.length };
            if (Array.isArray(parsed?.item)) return { format: 'json', items: parsed.item.length };
        } catch {}
    }
    const rssItems = body.match(/<item(?:\s|>)/g)?.length ?? 0;
    if (rssItems > 0 || body.includes('<rss')) return { format: 'rss', items: rssItems };
    const atomEntries = body.match(/<entry(?:\s|>)/g)?.length ?? 0;
    if (atomEntries > 0 || body.includes('<feed')) return { format: 'atom', items: atomEntries };
    return { format: 'unknown', items: null };
};

const handler = async (ctx: Context) => {
    ctx.header('Cache-Control', 'no-store');
    const target = ctx.req.query('path');
    if (!target || !target.startsWith('/') || target.startsWith('//') || target.includes('://') || target.startsWith('/debug/')) {
        return ctx.json({ ok: false, error: 'Specify an RSSHub path, for example: /debug/history?path=/twitter/list/2087706843519111304' }, 400);
    }

    const redisClient = cacheModule.clients.redisClient;
    if (!redisClient || !cacheModule.status.available) return ctx.json({ ok: false, redis: 'disconnected', error: 'Redis is not connected.' }, 503);

    const targetUrl = new URL(target, 'https://rsshub.local');
    const requestPath = targetUrl.pathname;
    const historyParams = new URLSearchParams(targetUrl.searchParams);
    historyParams.delete('format'); historyParams.delete('limit');
    const normalizedHistoryQuery = [...historyParams.entries()]
        .toSorted(([keyA, valueA], [keyB, valueB]) => keyA.localeCompare(keyB) || valueA.localeCompare(valueB))
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
    const historyKey = 'rsshub:history:v1:' + h64ToString(requestPath + (normalizedHistoryQuery ? `?${normalizedHistoryQuery}` : ''));

    const format = `:${targetUrl.searchParams.get('format') || config.format}`;
    const requestedLimit = targetUrl.searchParams.get('limit');
    const limitKey = requestedLimit ? `:${requestedLimit}` : '';
    const routeCacheKey = 'rsshub:koa-redis-cache:' + h64ToString(requestPath + format + limitKey);

    let [historyValue, routeCacheValue, historyTtl] = await Promise.all([redisClient.get(historyKey), redisClient.get(routeCacheKey), redisClient.ttl(historyKey)]);
    const { historyMax, outputMax } = getHistoryOptions();
    const historyItems = parseStoredItems(historyValue) ?? 0;
    const parsedLimit = requestedLimit ? Number.parseInt(requestedLimit, 10) : null;
    const finalOutputMax = parsedLimit && parsedLimit > 0 ? Math.min(outputMax, parsedLimit) : outputMax;
    const expectedOutputItems = Math.min(historyItems, finalOutputMax);

    let cachedOutputItems = parseStoredItems(routeCacheValue);
    let routeCacheRefreshed = false;
    const refreshRouteCache = ctx.req.query('refreshRouteCache') === '1';
    if (refreshRouteCache && routeCacheValue !== null && cachedOutputItems !== null && cachedOutputItems < expectedOutputItems) {
        await redisClient.del(routeCacheKey);
        routeCacheValue = null;
        cachedOutputItems = null;
        routeCacheRefreshed = true;
    }

    let liveCheck: Record<string, unknown>;
    let liveWithinMax = false;
    try {
        const origin = new URL(ctx.req.url).origin;
        const liveUrl = new URL(targetUrl.pathname + targetUrl.search, origin);
        const response = await fetch(liveUrl, { headers: { 'x-rsshub-history-debug-readonly': '1' }, signal: AbortSignal.timeout(30_000) });
        const body = await response.text();
        const contentType = response.headers.get('content-type') || '';
        const rendered = countRenderedItems(body, contentType);
        liveWithinMax = response.ok && rendered.items !== null && rendered.items <= finalOutputMax;
        liveCheck = {
            httpStatus: response.status,
            contentType,
            format: rendered.format,
            actualOutputItems: rendered.items,
            maxAllowedForThisRequest: finalOutputMax,
            withinMax: liveWithinMax,
            matchesExpected: rendered.items === null ? null : rendered.items === expectedOutputItems,
            historyMode: response.headers.get('RSSHub-History-Status'),
            routeCacheMode: response.headers.get('RSSHub-Cache-Status'),
        };
    } catch (error) {
        liveCheck = { error: error instanceof Error ? error.message : String(error), withinMax: false };
    }

    const historyWithinMax = historyItems <= historyMax;
    const cachedRssWithinMax = cachedOutputItems === null ? null : cachedOutputItems <= outputMax;
    const status = historyWithinMax && cachedRssWithinMax !== false && liveWithinMax ? 'OK' : 'NG';

    return ctx.json({
        ok: status === 'OK', status, target: targetUrl.pathname + targetUrl.search, redis: 'connected',
        history: { key: historyKey, items: historyItems, max: historyMax, remainingUntilMax: Math.max(historyMax - historyItems, 0), ttlSeconds: historyTtl },
        rss: {
            configuredMax: outputMax,
            requestedLimit: parsedLimit && parsedLimit > 0 ? parsedLimit : null,
            expectedOutputItems,
            routeCachePresent: routeCacheValue !== null,
            cachedItemsBeforeParameterLimit: cachedOutputItems,
            routeCacheRefreshed,
            live: liveCheck,
        },
        checks: { historyWithinMax, cachedRssWithinMax, liveRssWithinMax: liveWithinMax },
        note: refreshRouteCache
            ? 'refreshRouteCache=1 deletes only a stale target route cache when it contains fewer items than the persistent history expects. The rsshub:history:v1 history key is never deleted.'
            : 'The live RSS check runs the target route in read-only history/cache mode. It does not write Redis history or the normal route cache.',
    });
};

export default handler;
