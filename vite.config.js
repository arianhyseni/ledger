import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const BUILD_ID_TOKEN = "'__TILLROLL_BUILD_ID__'";
const PRECACHE_TOKEN = '/* __TILLROLL_PRECACHE_ASSETS__ */ []';

async function outputFiles(directory, root = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return outputFiles(path, root);
    return relative(root, path).split(sep).join('/');
  }));
  return files.flat();
}

function serviceWorkerPrecache() {
  let outputDirectory;
  let writesOutput = true;

  return {
    name: 'tillroll-service-worker-precache',
    apply: 'build',
    configResolved(config) {
      outputDirectory = resolve(config.root, config.build.outDir);
      writesOutput = config.build.write;
    },
    closeBundle: {
      order: 'post',
      async handler() {
        if (!writesOutput) return;

        const files = (await outputFiles(outputDirectory))
          .filter(file => file !== 'sw.js')
          .sort();
        const hash = createHash('sha256');

        for (const file of files) {
          hash.update(file);
          hash.update(await readFile(join(outputDirectory, file)));
        }

        const buildId = hash.digest('hex').slice(0, 16);
        const serviceWorkerPath = join(outputDirectory, 'sw.js');
        const serviceWorker = await readFile(serviceWorkerPath, 'utf8');

        if (!serviceWorker.includes(BUILD_ID_TOKEN) || !serviceWorker.includes(PRECACHE_TOKEN)) {
          throw new Error('Service worker precache placeholders are missing.');
        }

        const precacheAssets = files.map(file => `./${file}`);
        const generatedServiceWorker = serviceWorker
          .replace(BUILD_ID_TOKEN, JSON.stringify(buildId))
          .replace(PRECACHE_TOKEN, JSON.stringify(precacheAssets, null, 2));

        await writeFile(serviceWorkerPath, generatedServiceWorker);
      },
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), serviceWorkerPrecache()],
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
