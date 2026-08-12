import { defineConfig } from 'tsdown';

const namespaceOf = (id: string) => id.match(/[\\/]lib[\\/]routes[\\/]([^\\/]+)[\\/]/)?.[1];

export default defineConfig({
    entry: ['./lib/index.ts'],
    minify: true,
    shims: true,
    clean: true,
    treeshake: true, // 不要なコードを完全に除去
    codeSplitting: true, // コード分割を有効化して巨大ファイルを分散
    copy: ['lib/assets'],
    // 依存関係の扱いを調整（Worker環境で不要な重いライブラリをバンドルから外す）
    deps: {
        onlyBundle: false,
    },
    // Node.js固有の重いモジュールやWorker非対応パッケージを外す場合はここに指定
    external: [
        'jsdom',
        'canvas',
        'puppeteer',
        'patchright',
    ],
    outputOptions: {
        chunkFileNames(chunk) {
            let namespace = chunk.facadeModuleId ? namespaceOf(chunk.facadeModuleId) : undefined;
            if (!namespace) {
                const namespaces = new Set(chunk.moduleIds.map((id) => namespaceOf(id)));
                if (namespaces.size === 1) {
                    namespace = [...namespaces][0];
                }
            }
            return namespace && namespace !== chunk.name ? `${namespace}-[name]-[hash].mjs` : '[name]-[hash].mjs';
        },
    },
});
