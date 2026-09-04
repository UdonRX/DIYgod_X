# Persistent RSS history for this fork

This fork keeps a persistent article history when RSSHub is deployed with Redis.

## Behaviour

- Current route results are merged with the previously stored Redis history.
- Duplicates are removed in this order: `guid`, `id`, `link`, then a fallback hash.
- The newest **100** items are stored in Redis by default.
- At most **60** items are returned by the route cache by default.
- A normal `?limit=N` parameter can still reduce the final RSS output below 60.
- `format` and `limit` do not split the persistent history key.
- If Redis fails, RSSHub continues serving the current feed instead of failing the request.
- Routes that explicitly use `Cache-Control: no-cache` are not persisted by this history layer.

## Render environment variables

```text
CACHE_TYPE=redis
REDIS_URL=rediss://default:YOUR_PASSWORD@YOUR_HOST:6379
HISTORY_CACHE_ENABLED=true
HISTORY_CACHE_MAX=100
FEED_OUTPUT_MAX=60
HISTORY_CACHE_EXPIRE=31536000
```

`HISTORY_CACHE_ENABLED` is automatically enabled when `CACHE_TYPE=redis`, but setting it explicitly is recommended.

`HISTORY_CACHE_EXPIRE` is in seconds. The default is 31,536,000 seconds (365 days), and the TTL is refreshed whenever that route successfully refreshes its history.

## Diagnostic response headers

- `RSSHub-History-Status: MISS` — first persistent history write for the route.
- `RSSHub-History-Status: HIT` — an existing Redis history was merged.
- `RSSHub-History-Status: ROUTE_HIT` — RSSHub's short route cache answered the request; the already-merged result was returned.
- `RSSHub-History-Status: NO_REDIS` — history was requested but Redis was unavailable.
- `RSSHub-History-Status: ERROR` — Redis/history processing failed; the feed was still returned.
- `RSSHub-History-Items` — number of items retained in the persistent history, up to `HISTORY_CACHE_MAX`.
- `RSSHub-History-Output` — number of items passed onward from the history layer, up to `FEED_OUTPUT_MAX`.

## Notes

The persistent store contains only articles that RSSHub has actually seen. If an origin site exposes only its latest 20 items and publishes more than 20 new items between RSSHub refreshes, items that never appeared in any RSSHub fetch cannot be recovered later.
