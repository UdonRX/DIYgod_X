import { defineConfig } from 'tsdown';

const namespaceOf = (id: string) => id.match(/[\\/]lib[\\/]routes[\\/]([^\\/]+)[\\/]/)?.[1];

export default defineConfig({
    entry: ['./lib/index.ts'],
    minify: true,
    shims: true,
    clean: true,
    treeshake: true,
    codeSplitting: true,
    copy: ['lib/assets'],
    // ネームスペース付きJSX（<itunes:author> 等）の警告・エラーを抑制
    jsx: {
        throwIfNamespace: false,
    },
    deps: {
        onlyBundle: false,
    },
    external: [
        'jsdom',
        'canvas',
        'puppeteer',
        'patchright',
    ],
    outputOptions: {
        // 細かくなりすぎたモジュールをディレクトリ単位や機能単位で結合する
        manualChunks(id) {
            // node_modules の共通依存関係を1つ（または数個）のvendorファイルに集約
            if (id.includes('node_modules')) {
                return 'vendor';
            }
            // ルート配下のモジュールを名前空間（namespace）ごとに1ファイルへまとめる
            const namespace = namespaceOf(id);
            if (namespace) {
                return `route-${namespace}`;
            }
        },
        chunkFileNames: '[name]-[hash].mjs',
    },
});
