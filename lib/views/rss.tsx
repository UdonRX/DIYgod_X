import type { FC } from 'hono/jsx';

import type { Data } from '@/types';

// 名前空間付きタグを文字列として定義
const AtomLink = 'atom:link' as any;
const ItunesAuthor = 'itunes:author' as any;
const ItunesCategory = 'itunes:category' as any;
const ItunesExplicit = 'itunes:explicit' as any;
const ItunesImage = 'itunes:image' as any;
const ItunesDuration = 'itunes:duration' as any;

const RSS: FC<{ data: Data }> = ({ data }) => {
    const hasItunes = data.itunes_author || data.itunes_category || (data.item && data.item.some((i) => i.itunes_item_image || i.itunes_duration));
    const hasMedia = data.item?.some((i) => i.media);
    const isTelegramLink = data.link?.startsWith('https://t.me/s/');

    return (
        <rss xmlns:atom="http://www.w3.org/2005/Atom" xmlns:itunes={hasItunes ? 'http://www.itunes.com/dtds/podcast-1.0.dtd' : undefined} xmlns:media={hasMedia ? 'http://search.yahoo.com/mrss/' : undefined} version="2.0">
            <channel>
                <title>{data.title || 'RSSHub'}</title>
                <link>{data.link || 'https://docs.rsshub.app'}</link>
                <AtomLink href={data.atomlink} rel="self" type="application/rss+xml" />
                <description>{data.description || data.title} - Powered by RSSHub</description>
                <generator>RSSHub</generator>
                <webMaster>contact@rsshub.app (RSSHub)</webMaster>
                {data.itunes_author && <ItunesAuthor>{data.itunes_author}</ItunesAuthor>}
                {data.itunes_category && <ItunesCategory text={data.itunes_category} />}
                {data.itunes_author && <ItunesExplicit>{data.itunes_explicit || 'false'}</ItunesExplicit>}
                <language>{data.language || 'en'}</language>
                {data.image && (
                    <image>
                        <url>{data.image}</url>
                        <title>{data.title || 'RSSHub'}</title>
                        <link>{data.link}</link>
                        {isTelegramLink && (
                            <>
                                <height>31</height>
                                <width>88</width>
                            </>
                        )}
                    </image>
                )}
                <lastBuildDate>{data.lastBuildDate}</lastBuildDate>
                <ttl>{data.ttl}</ttl>
                {data.item?.map((item) => (
                    <item>
                        <title>{item.title}</title>
                        <description>{item.description}</description>
                        <link>{item.link}</link>
                        <guid isPermaLink="false">{item.guid || item.link || item.title}</guid>
                        {item.pubDate && <pubDate>{item.pubDate}</pubDate>}
                        {item.author && <author>{item.author}</author>}
                        {item.image && <enclosure url={item.image} type="image/jpeg" />}
                        {item.itunes_item_image && <ItunesImage href={item.itunes_item_image} />}
                        {item.enclosure_url && <enclosure url={item.enclosure_url} length={item.enclosure_length} type={item.enclosure_type} />}
                        {item.itunes_duration && <ItunesDuration>{item.itunes_duration}</ItunesDuration>}
                        {typeof item.category === 'string' ? <category>{item.category}</category> : item.category?.map((c) => <category>{c}</category>)}
                        {item.media &&
                            Object.entries(item.media).map(([key, value]) => {
                                const Tag = `media:${key}` as any;
                                return <Tag {...value} />;
                            })}
                    </item>
                ))}
            </channel>
        </rss>
    );
};

export default RSS;
