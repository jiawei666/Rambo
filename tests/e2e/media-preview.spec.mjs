import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createElectronTest, expect, registerExternalProcessCleanup } from './fixtures/electron-app.mjs';

const test = createElectronTest('playwright-media-preview');
const screenshots = resolve(import.meta.dirname, '../../test-results');

function pdfFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 54 >>\nstream\nBT /F1 18 Tf 32 100 Td (F05 PDF Preview Sample) Tj ET\nendstream'
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}

function wavFixture(dataBytes = 9 * 1024 * 1024) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(dataBytes + 36, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8_000, 24);
  header.writeUInt32LE(16_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

async function injectMedia(page, chatId, mediaType, url, title) {
  return page.evaluate(({ chatId, mediaType, url, title }) => window.rambo.injectAcceptanceEvent({
    type: 'previewMessage',
    message: { chatId, text: '', content: { kind: 'media', mediaType, url, title } }
  }), { chatId, mediaType, url, title });
}

async function injectMarkdown(page, chatId, text) {
  return page.evaluate(({ chatId, text }) => window.rambo.injectAcceptanceEvent({
    type: 'previewMessage',
    message: { chatId, text }
  }), { chatId, text });
}

async function expectGrokAttachmentCard(row) {
  const card = row.locator('[data-attachment-card]');
  await expect(card).toBeVisible();
  const style = await card.evaluate(element => {
    const computed = getComputedStyle(element);
    return { borderRadius: computed.borderRadius, padding: computed.padding, display: computed.display };
  });
  expect(style).toEqual({ borderRadius: '22px', padding: '16px', display: 'grid' });
}

test('F05/F06 Electron displays local files inside and outside the workspace', async ({ electron, acceptanceRun }) => {
  test.setTimeout(90_000);
  const page = electron.page;
  await page.getByLabel('创建 Bot').click();
  await page.getByLabel('Bot 名称').fill('F05 Preview Lab');
  await page.getByRole('dialog', { name: '创建新 Bot' }).getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByPlaceholder('发消息给 F05 Preview Lab')).toBeVisible();

  const { botId, chatId } = await page.evaluate(async name => {
    const snapshot = await window.rambo.snapshot();
    const bot = snapshot.bots.find(item => item.name === name);
    const chat = snapshot.chats.find(item => item.botId === bot?.id && !item.groupChatId && !item.archived);
    if (!bot || !chat) throw new Error('验收 Bot 或私聊未创建');
    return { botId: bot.id, chatId: chat.id };
  }, 'F05 Preview Lab');

  const fixtures = join(acceptanceRun.run, 'fixtures');
  const workspace = join(acceptanceRun.profile, 'bots', botId, 'workspace');
  mkdirSync(fixtures, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const fixtureFiles = [
    ['sample.pdf', pdfFixture()],
    ['sample.txt', Buffer.from('本机文本预览内容：测试成功。', 'utf8')],
    ['large.txt', Buffer.alloc(2 * 1024 * 1024 + 1, 'x')],
    ['sample.md', Buffer.from('# Markdown 预览\n\n**加粗内容** 和一行表格：\n\n|A|B|\n|-|-|\n|1|2|\n', 'utf8')],
    ['sample.csv', Buffer.from('姓名,商品,数量\n小明,"苹果,大果",2\n小红,香蕉,3\n', 'utf8')],
    ['sample.wav', wavFixture()],
    ['sample.docx', Buffer.from('isolated office file fixture', 'utf8')],
    ['sample.xlsx', Buffer.from('isolated office file fixture', 'utf8')],
    ['sample.pptx', Buffer.from('isolated office file fixture', 'utf8')],
    ['sample.rtf', Buffer.from('{\\rtf1\\ansi F05 RTF system-open sample}', 'utf8')],
    ['unsupported.mp4', Buffer.from('not a media container', 'utf8')],
    ['sample.unknown', Buffer.from('isolated unknown file fixture', 'utf8')]
  ];
  for (const [name, bytes] of fixtureFiles) writeFileSync(join(fixtures, name), bytes);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=0.5:r=10',
    '-an', '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-y', join(fixtures, 'sample.mp4')
  ]);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=16x16',
    '-frames:v', '1', '-y', join(fixtures, 'sample.png')
  ]);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green@0.0:s=32x32,format=rgba',
    '-frames:v', '1', '-y', join(fixtures, 'transparent.png')
  ]);
  for (const name of [...fixtureFiles.map(([file]) => file), 'sample.mp4', 'sample.png', 'transparent.png']) {
    copyFileSync(join(fixtures, name), join(workspace, name));
  }
  const outsideFile = join(fixtures, 'outside-workspace.txt');
  const outsideDirectory = join(fixtures, 'outside-directory');
  writeFileSync(outsideFile, '工作区外文件预览内容。', 'utf8');
  mkdirSync(outsideDirectory, { recursive: true });

  const image = await injectMedia(page, chatId, 'image', 'sample.png', '图片样例');
  const imageRow = page.locator(`[data-message-id="${image.id}"]`);
  await expectGrokAttachmentCard(imageRow);
  await expect(imageRow.locator('.transcript-file-icon')).toHaveText('IMAGE');
  const outside = await injectMedia(page, chatId, 'file', outsideFile, '工作区外文件');
  const outsideRow = page.locator(`[data-message-id="${outside.id}"]`);
  await expectGrokAttachmentCard(outsideRow);
  await expect(outsideRow.getByRole('button', { name: '预览' })).toBeVisible();
  await outsideRow.getByRole('button', { name: '预览' }).click();
  const outsideViewer = page.getByRole('dialog', { name: 'outside-workspace.txt预览' });
  await expect(outsideViewer).toContainText('工作区外文件预览内容。');
  const outsideViewerLayout = await outsideViewer.evaluate(dialog => {
    const box = dialog.getBoundingClientRect();
    return { width: box.width, height: box.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
  });
  expect(outsideViewerLayout.width).toBeLessThan(outsideViewerLayout.viewportWidth);
  expect(outsideViewerLayout.height).toBeLessThan(outsideViewerLayout.viewportHeight);
  await outsideViewer.getByRole('button', { name: '关闭文件预览' }).click();
  const outsideChecks = await page.evaluate(({ messageId, file, directory }) => Promise.all([
    window.rambo.resolveMessageAsset(messageId, file),
    window.rambo.resolveMessageAsset(messageId, directory),
    window.rambo.resolveMessageAsset(messageId, 'https://example.com/outside-workspace.txt'),
    window.rambo.resolveMessageAsset(messageId, '/definitely-missing-rambo-asset.txt')
  ]), { messageId: outside.id, file: outsideFile, directory: outsideDirectory });
  expect(outsideChecks[0]).toMatch(/^rambo-asset:\/\/asset\//u);
  expect(outsideChecks.slice(1)).toEqual([null, null, null]);
  const sourceLink = await injectMarkdown(page, chatId, `[outside-workspace.txt](${outsideFile}:12) 是源码依据。`);
  const sourceLinkRow = page.locator(`[data-message-id="${sourceLink.id}"]`);
  await expect(sourceLinkRow.locator('.transcript-attachment-card-copy strong')).toHaveText('outside-workspace.txt');
  await expect(sourceLinkRow.locator('.transcript-media-error')).toHaveCount(0);
  await sourceLinkRow.getByRole('button', { name: '预览' }).click();
  const sourceLinkViewer = page.getByRole('dialog', { name: 'outside-workspace.txt预览' });
  await expect(sourceLinkViewer).toContainText('工作区外文件预览内容。');
  await sourceLinkViewer.getByRole('button', { name: '关闭文件预览' }).click();
  const focusStates = await page.evaluate(async messageId => {
    const row = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!row) throw new Error('源码文件卡片不存在');
    const observed = [];
    const record = () => observed.push({
      error: Boolean(row.querySelector('.transcript-media-error')),
      loading: Boolean(row.querySelector('.transcript-media-loading')),
      card: Boolean(row.querySelector('[data-attachment-card]'))
    });
    const observer = new MutationObserver(record);
    observer.observe(row, { childList: true, characterData: true, subtree: true });
    record();
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    await new Promise(resolve => setTimeout(resolve, 250));
    observer.disconnect();
    record();
    return observed;
  }, sourceLink.id);
  expect(focusStates.every(item => !item.error && !item.loading && item.card)).toBe(true);
  await expect(imageRow.locator('.transcript-attachment-card-copy small')).toHaveCount(0);
  await expect(imageRow.locator('.transcript-image-button img')).toBeVisible();
  await expect.poll(() => imageRow.locator('.transcript-image-button img').evaluate(element => element.naturalWidth)).toBeGreaterThan(0);
  await imageRow.locator('.transcript-image-button').click();
  const imageViewer = page.getByRole('dialog', { name: '图片样例预览' });
  await expect(imageViewer.locator('.transcript-file-viewer__stage-chrome')).toBeVisible();
  await expect(imageViewer.locator('.transcript-file-viewer-image-stage img')).toBeVisible();
  const imageStage = imageViewer.locator('.transcript-file-viewer-image-stage');
  await expect(imageStage).toHaveCSS('background-image', /linear-gradient/u);
  await expect(imageViewer.getByRole('button', { name: '当前缩放 100%，重置' })).toBeVisible();
  const baselineImageBox = await imageViewer.locator('.transcript-file-viewer-image-stage img').boundingBox();
  expect(baselineImageBox?.width).toBe(16);
  expect(baselineImageBox?.height).toBe(16);
  await imageViewer.getByRole('button', { name: '放大图片' }).click();
  await expect(imageViewer.getByRole('button', { name: '当前缩放 125%，重置' })).toBeVisible();
  const enlargedImageBox = await imageViewer.locator('.transcript-file-viewer-image-stage img').boundingBox();
  expect(enlargedImageBox?.width).toBe(20);
  expect(enlargedImageBox?.height).toBe(20);
  await imageViewer.getByRole('button', { name: '缩小图片' }).click();
  await expect(imageViewer.getByRole('button', { name: '当前缩放 100%，重置' })).toBeVisible();
  await imageStage.dblclick();
  await expect(imageViewer.getByRole('button', { name: '当前缩放 200%，重置' })).toBeVisible();
  await imageViewer.getByRole('button', { name: '当前缩放 200%，重置' }).click();
  await expect(imageViewer.getByRole('button', { name: '当前缩放 100%，重置' })).toBeVisible();
  writeFileSync(join(screenshots, 'f05-image-zoom-checkerboard.png'), await page.screenshot());
  await imageViewer.getByRole('button', { name: '关闭文件预览' }).click();

  const transparent = await injectMedia(page, chatId, 'image', 'transparent.png', '透明图片');
  const transparentRow = page.locator(`[data-message-id="${transparent.id}"]`);
  await expect(transparentRow.locator('.transcript-image-button img')).toBeVisible();
  const transparentAlpha = execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', join(workspace, 'transparent.png'),
    '-vf', 'crop=1:1:0:0,format=rgba', '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'
  ])[3];
  expect(transparentAlpha).toBe(0);
  await transparentRow.locator('.transcript-image-button').click();
  const transparentViewer = page.getByRole('dialog', { name: '透明图片预览' });
  await expect(transparentViewer.locator('.transcript-file-viewer-image-stage')).toHaveCSS('background-image', /linear-gradient/u);
  const transparentImage = transparentViewer.locator('.transcript-file-viewer-image-stage img');
  await expect(transparentImage).toHaveAttribute('src', /^rambo-asset:\/\/asset\//u);
  await expect.poll(() => transparentImage.evaluate(image => image.complete && image.naturalWidth === 32 && image.naturalHeight === 32)).toBe(true);
  writeFileSync(join(screenshots, 'f05-transparent-image.png'), await page.screenshot());
  await transparentViewer.getByRole('button', { name: '关闭文件预览' }).click();

  const generated = await page.evaluate(chatId => window.rambo.injectAcceptanceEvent({
    type: 'previewMessage',
    message: {
      chatId,
      text: '生成好了：一张用于检查分享卡片布局的图片。',
      content: {
        kind: 'media',
        mediaType: 'image',
        url: 'sample.png',
        title: '生成图片',
        alt: '生成图片',
        generated: true
      }
    }
  }), chatId);
  const generatedRow = page.locator(`[data-message-id="${generated.id}"]`);
  const generatedCard = generatedRow.locator('[data-attachment-card]');
  await expect(generatedCard.locator('.transcript-image-button img')).toBeVisible();
  await expect.poll(() => generatedCard.locator('.transcript-image-button img').evaluate(element => element.naturalWidth)).toBeGreaterThan(0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(generatedCard.locator('.transcript-file-menu')).toHaveCount(0);
  await expect(generatedCard.locator('.transcript-image-figure figcaption')).toHaveCount(0);
  await expect(generatedCard.locator('.transcript-file-icon')).toHaveText('IMAGE');
  await expect(generatedCard.locator('.transcript-attachment-card-copy small')).toHaveCount(0);
  const generatedLayout = await generatedCard.evaluate(card => {
    const cardBox = card.getBoundingClientRect();
    const imageBox = card.querySelector('.transcript-image-figure')?.getBoundingClientRect();
    if (!imageBox) throw new Error('生成图片卡片缺少图片');
    return {
      bottomSpace: Math.round(cardBox.bottom - imageBox.bottom),
      height: Math.round(cardBox.height)
    };
  });
  expect(generatedLayout.bottomSpace).toBeLessThanOrEqual(20);
  await generatedCard.click({ button: 'right' });
  const generatedMenu = page.getByRole('menu', { name: 'sample.png 文件操作' });
  await expect(generatedMenu).toBeVisible();
  await expect(generatedMenu.getByRole('menuitem')).toHaveCount(3);
  await expect(generatedMenu).toHaveCSS('position', 'fixed');
  await expect(generatedCard).toHaveCSS('display', 'grid');
  expect(await generatedCard.locator('.transcript-attachment-card-header').evaluate(header => header.children.length)).toBe(2);
  await expect(generatedMenu.getByRole('menuitem', { name: '保存' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(generatedMenu.getByRole('menuitem', { name: '用本机应用打开' })).toBeFocused();
  writeFileSync(join(screenshots, 'f05-attachment-context-menu.png'), await page.screenshot());
  expect(Math.abs(Math.round((await generatedCard.boundingBox())?.height ?? 0) - generatedLayout.height)).toBeLessThanOrEqual(1);
  await page.keyboard.press('Escape');
  await expect(generatedMenu).toHaveCount(0);

  await generatedCard.locator('.transcript-image-button').click();
  const generatedViewer = page.getByRole('dialog', { name: '生成图片预览' });
  await expect(generatedViewer.locator('.transcript-file-viewer-image-stage img')).toBeVisible();
  const viewerLayout = await page.evaluate(() => {
    const backdrop = document.querySelector('.transcript-file-viewer-backdrop');
    const chrome = document.querySelector('.transcript-file-viewer__stage-chrome');
    const heading = document.querySelector('.transcript-file-viewer-heading');
    if (!backdrop || !chrome || !heading) throw new Error('文件查看器布局节点缺失');
    const backdropBox = backdrop.getBoundingClientRect();
    const headingBox = heading.getBoundingClientRect();
    return {
      mountedToBody: backdrop.parentElement === document.body,
      backdrop: {
        x: Math.round(backdropBox.x),
        y: Math.round(backdropBox.y),
        width: Math.round(backdropBox.width),
        height: Math.round(backdropBox.height)
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      headingLeft: Math.round(headingBox.left),
      chromePaddingLeft: Number.parseFloat(getComputedStyle(chrome).paddingLeft)
    };
  });
  expect(viewerLayout.mountedToBody).toBe(true);
  expect(viewerLayout.backdrop).toEqual({ x: 0, y: 0, ...viewerLayout.viewport });
  expect(viewerLayout.chromePaddingLeft).toBe(18);
  expect(viewerLayout.headingLeft).toBeGreaterThan(viewerLayout.backdrop.x);
  expect(viewerLayout.headingLeft).toBeLessThan(viewerLayout.viewport.width);
  const generatedScreenshot = await page.screenshot();
  writeFileSync(join(screenshots, 'f05-generated-viewer.png'), generatedScreenshot);
  await test.info().attach('F05-生成图片卡片与查看器', { body: generatedScreenshot, contentType: 'image/png' });
  await generatedViewer.getByRole('button', { name: '关闭文件预览' }).click();

  const pdf = await injectMedia(page, chatId, 'file', 'sample.pdf', 'PDF 样例');
  const pdfRow = page.locator(`[data-message-id="${pdf.id}"]`);
  await expectGrokAttachmentCard(pdfRow);
  await pdfRow.getByRole('button', { name: '预览' }).click();
  const pdfViewer = page.getByRole('dialog', { name: 'sample.pdf预览' });
  await expect(pdfViewer.locator('.transcript-file-viewer__stage-chrome')).toBeVisible();
  const pdfFrame = pdfViewer.locator('iframe[title="sample.pdf PDF 预览"]');
  await expect(pdfFrame).toBeVisible();
  const sharedViewerScreenshot = await page.screenshot();
  writeFileSync(join(screenshots, 'f05-shared-viewer.png'), sharedViewerScreenshot);
  await test.info().attach('F05-共享文件查看器', { body: sharedViewerScreenshot, contentType: 'image/png' });
  const pdfUrl = await pdfFrame.getAttribute('src');
  expect(pdfUrl).toMatch(/^rambo-asset:\/\/asset\//u);
  const pdfResult = await page.evaluate(async url => {
    const response = await fetch(url);
    return { status: response.status, type: response.headers.get('content-type'), bytes: (await response.arrayBuffer()).byteLength };
  }, pdfUrl);
  expect(pdfResult).toEqual({ status: 200, type: 'application/pdf', bytes: statSync(join(workspace, 'sample.pdf')).size });
  await pdfViewer.getByRole('button', { name: '关闭文件预览' }).click();

  const textMessage = await injectMedia(page, chatId, 'file', 'sample.txt', '文本样例');
  const textRow = page.locator(`[data-message-id="${textMessage.id}"]`);
  await expectGrokAttachmentCard(textRow);
  await textRow.getByRole('button', { name: '预览' }).click();
  const textViewer = page.getByRole('dialog', { name: 'sample.txt预览' });
  await expect(textViewer.locator('.transcript-plain-text')).toContainText('本机文本预览内容：测试成功。');
  await textViewer.getByRole('button', { name: '关闭文件预览' }).click();

  const largeText = await injectMedia(page, chatId, 'file', 'large.txt', '超过内嵌上限的文本');
  const largeTextRow = page.locator(`[data-message-id="${largeText.id}"]`);
  await expect(largeTextRow.getByRole('status')).toHaveText('文件超过 2 MiB，无法在聊天内预览');

  const markdown = await injectMedia(page, chatId, 'file', 'sample.md', 'Markdown 样例');
  const markdownRow = page.locator(`[data-message-id="${markdown.id}"]`);
  await markdownRow.getByRole('button', { name: '预览' }).click();
  const markdownViewer = page.getByRole('dialog', { name: 'sample.md预览' });
  await expect(markdownViewer.locator('.transcript-markdown h1')).toHaveText('Markdown 预览');
  await expect(markdownViewer.locator('.transcript-markdown strong')).toHaveText('加粗内容');
  await markdownViewer.getByRole('button', { name: '关闭文件预览' }).click();

  const csv = await injectMedia(page, chatId, 'file', 'sample.csv', 'CSV 样例');
  const csvRow = page.locator(`[data-message-id="${csv.id}"]`);
  await csvRow.getByRole('button', { name: '预览' }).click();
  const csvViewer = page.getByRole('dialog', { name: 'sample.csv预览' });
  await expect(csvViewer.getByRole('region', { name: 'CSV 表格预览' })).toBeVisible();
  await expect(csvViewer.locator('table')).toContainText('苹果,大果');
  await expect(csvViewer.locator('table')).toContainText('小红');
  await csvViewer.getByRole('button', { name: '关闭文件预览' }).click();

  const audio = await injectMedia(page, chatId, 'audio', 'sample.wav', '大于 8 MiB 音频');
  const audioRow = page.locator(`[data-message-id="${audio.id}"]`);
  await expectGrokAttachmentCard(audioRow);
  await expect(audioRow.locator('.transcript-attachment-card-copy small')).toHaveText('大于 8 MiB 音频');
  const audioPlayer = audioRow.locator('audio.transcript-audio');
  await expect(audioPlayer).toBeVisible();
  await expect.poll(() => audioPlayer.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(1);
  await audioPlayer.evaluate(async element => {
    element.muted = true;
    await element.play();
  });
  await expect.poll(() => audioPlayer.evaluate(element => element.currentTime)).toBeGreaterThan(0);
  const audioUrl = await audioPlayer.getAttribute('src');
  const rangeResult = await page.evaluate(async url => {
    const response = await fetch(url, { headers: { Range: 'bytes=0-15' } });
    return { status: response.status, range: response.headers.get('content-range'), size: (await response.arrayBuffer()).byteLength };
  }, audioUrl);
  expect(rangeResult).toEqual({ status: 206, range: `bytes 0-15/${statSync(join(workspace, 'sample.wav')).size}`, size: 16 });

  const video = await injectMedia(page, chatId, 'video', 'sample.mp4', 'H.264 视频样例');
  const videoRow = page.locator(`[data-message-id="${video.id}"]`);
  await expectGrokAttachmentCard(videoRow);
  await expect(videoRow.locator('.transcript-attachment-card-copy small')).toHaveText('H.264 视频样例');
  const videoPlayer = videoRow.locator('video.transcript-video');
  await expect(videoPlayer).toBeVisible();
  await expect.poll(() => videoPlayer.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(1);
  expect(await videoPlayer.evaluate(element => element.error?.code ?? 0)).toBe(0);
  await videoPlayer.evaluate(async element => {
    element.muted = true;
    await element.play();
  });
  await expect.poll(() => videoPlayer.evaluate(element => element.currentTime)).toBeGreaterThan(0);
  await test.info().attach('F05-媒体预览', {
    body: await page.screenshot(),
    contentType: 'image/png'
  });

  const unsupported = await injectMedia(page, chatId, 'video', 'unsupported.mp4', '不支持的编码样例');
  const unsupportedRow = page.locator(`[data-message-id="${unsupported.id}"]`);
  await expect(unsupportedRow.getByRole('status')).toHaveText('此音视频编码无法在应用内播放，可用本机应用打开文件。');
  await unsupportedRow.locator('[data-attachment-card]').click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'unsupported.mp4 文件操作' })).toBeVisible();
  await page.keyboard.press('Escape');

  const officeRows = [];
  for (const [name, title] of [['sample.docx', 'Word 样例'], ['sample.xlsx', 'Excel 样例'], ['sample.pptx', 'PowerPoint 样例'], ['sample.rtf', 'RTF 本机打开样例'], ['sample.unknown', '其他格式样例']]) {
    const message = await injectMedia(page, chatId, 'file', name, title);
    const row = page.locator(`[data-message-id="${message.id}"]`);
    await expectGrokAttachmentCard(row);
    await expect(row.locator('.transcript-attachment-card-copy strong')).toHaveText(name);
    await expect(row.locator('.transcript-attachment-card-copy small')).toHaveText(title);
    await expect(row.getByRole('button', { name: '预览' })).toHaveCount(0);
    await row.locator('[data-attachment-card]').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: `${name} 文件操作` });
    await expect(menu.getByRole('menuitem', { name: '保存' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: '用本机应用打开' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: '在 Finder 中显示' })).toBeVisible();
    await page.keyboard.press('Escape');
    officeRows.push({ message, name, row });
  }

  await pdfRow.locator('[data-attachment-card]').click({ button: 'right' });
  await page.getByRole('menu', { name: 'sample.pdf 文件操作' }).getByRole('menuitem', { name: '保存' }).click();
  await expect(pdfRow.getByRole('status')).toHaveText('已保存到 sample.pdf');
  const downloadPath = join(acceptanceRun.run, 'downloads', 'sample.pdf');
  expect(existsSync(downloadPath)).toBe(true);
  expect(readFileSync(downloadPath)).toEqual(readFileSync(join(workspace, 'sample.pdf')));

  // Verify IPC authorization for each Office-style file format.
  const pathChecks = await Promise.all(officeRows.map(({ message, name }) => page.evaluate(
    ({ messageId, source }) => window.rambo.resolveMessageAsset(messageId, source),
    { messageId: message.id, source: name }
  )));
  expect(pathChecks.every(Boolean)).toBe(true);

  const rtfRow = officeRows.find(item => item.name === 'sample.rtf').row;
  await rtfRow.locator('[data-attachment-card]').click({ button: 'right' });
  await page.getByRole('menu', { name: 'sample.rtf 文件操作' }).getByRole('menuitem', { name: '用本机应用打开' }).click();
  await expect(rtfRow.getByRole('status')).toHaveText('已交给本机应用打开');
  await registerExternalProcessCleanup(acceptanceRun);
  await rtfRow.locator('[data-attachment-card]').click({ button: 'right' });
  await page.getByRole('menu', { name: 'sample.rtf 文件操作' }).getByRole('menuitem', { name: '在 Finder 中显示' }).click();
  await expect(rtfRow.getByRole('status')).toHaveText('已在 Finder 中显示');
  await registerExternalProcessCleanup(acceptanceRun);
  await test.info().attach('F05-文件操作', {
    body: await page.screenshot(),
    contentType: 'image/png'
  });
});
