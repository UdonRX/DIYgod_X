import type { MiddlewareHandler } from 'hono';
import xxhash from 'xxhash-wasm';

import { config } from '@/config';
import RequestInProgressError from '@/errors/types/request-in-progress';
import type { Data } from '@/types';
import cacheModule from '@/utils/cache/index';
import { applyPersistentHistory, markPersistentHistoryRouteHit } from '@/utils/persistent-history';

const bypassList = new Set(['/', '/robots.txt', '/logo.png', '/favicon.ico']);

const { h64ToString } = await xxhash();
// only give cache string, as the `!` condition tricky
// XXH64 is used to shrink key size
// plz, write these tips in comments!
const middleware: MiddlewareHandler = async (ctx, next) => {
    const diagnosticReadOnly = ctx.req.header('x-rsshub-history-debug-readonly') === '1';

    if (diagnosticReadOnly) {
        await next();
        const data: Data = ctx.get('data');
        if (ctx.res.headers.get('Cache-Control') !== 'no-cache' && data) {
            await applyPersistentHistory(ctx, data, { readOnly: true });
            data.lastBuildDate = new Date().toUTCString();
            ctx.set('data', data);
        }
        return;
    }

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

    let isRequesting = false;
    if (!value) {
        isRequesting = !(await cacheModule.globalCache.claim(controlKey, config.cache.requestTimeout));
    }

    if (isRequesting) {
        let retryTimes = process.env.NODE_ENV === 'test' ? 1 : 10;
        let bypass = false;
        while (retryTimes > 0) {
            await new Promise((resolve) => setTimeout(resolve, process.env.NODE_ENV === 'test' ? 3000 : 6000));
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
        markPersistentHistoryRouteHit(ctx, cachedData);
        ctx.set('data', cachedData);
        await next();
        return;
    }

    if (isRequesting) {
        await cacheModule.globalCache.set(controlKey, '1', config.cache.requestTimeout);
    }

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

    await cacheModule.globalCache.set(controlKey, '0', config.cache.requestTimeout);
};

export default middleware;
