import { promises as fs } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const distClientDir = path.join(projectRoot, 'dist', 'client');
const assetsDir = path.join(distClientDir, 'assets');

async function main() {
  const assetEntries = await fs.readdir(assetsDir, { withFileTypes: true });
  const assetFiles = assetEntries.filter((entry) => entry.isFile()).map((entry) => entry.name);

  let entryScript;
  for (const file of assetFiles) {
    if (!file.endsWith('.js') || !file.startsWith('index-')) continue;
    const filePath = path.join(assetsDir, file);
    const contents = await fs.readFile(filePath, 'utf8');
    if (!contents.includes('hydrateRoot(document,')) continue;

    entryScript = file;
    const patchedContents = contents.replace(
      'hydrateRoot(document,',
      'createRoot(document).render(',
    );

    if (patchedContents === contents) {
      throw new Error(`Unable to patch client entry ${file}`);
    }

    await fs.writeFile(filePath, patchedContents);
    break;
  }

  if (!entryScript) {
    throw new Error('Could not find the client entry script that hydrates the document.');
  }

  const stylesheet = assetFiles.find((file) => file.endsWith('.css') && file.startsWith('styles-'));
  if (!stylesheet) {
    throw new Error('Could not find the client stylesheet.');
  }

  const faviconPath = path.join(distClientDir, 'favicon.ico');
  let faviconLink = '';
  try {
    await fs.access(faviconPath);
    faviconLink = '    <link rel="icon" href="/favicon.ico" />\n';
  } catch {
    faviconLink = '';
  }

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Ritual Community Map</title>
    <meta
      name="description"
      content="Pin yourself to the Ritual lattice. Sign one transaction on Ritual testnet to add yourself to the live community map."
    />
${faviconLink}    <link rel="stylesheet" href="/assets/${stylesheet}" />
  </head>
  <body>
    <script type="module" src="/assets/${entryScript}"></script>
  </body>
</html>
`;

  await fs.writeFile(path.join(distClientDir, 'index.html'), html);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
