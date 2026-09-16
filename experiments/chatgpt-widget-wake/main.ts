// Feature-off does not even import the server or touch credentials/files/ports.
if (process.env.WIDGET_WAKE_ENABLED !== '1') {
  console.log('Wake probe disabled; no listeners or files created.');
} else {
  const { randomBytes } = await import('node:crypto');
  const { readFile, unlink } = await import('node:fs/promises');
  const { createProbe } = await import('./server.js');
  const { accessFile, checkDir, createPrivate } = await import('./private-files.js');
  const origin = process.env.WIDGET_WAKE_PUBLIC_ORIGIN ?? 'https://gemrouter.example.com';
  const widgetOrigin = process.env.WIDGET_WAKE_IFRAME_ORIGIN ?? 'https://web-sandbox.oaiusercontent.com';
  for (const value of [origin, widgetOrigin]) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value) throw new Error('exact_https_origin_required');
  }
  const manifest = JSON.parse(await readFile(new URL('./build/manifest.json', import.meta.url), 'utf8'));
  if (manifest.publicOrigin !== origin) throw new Error('rebuild_for_configured_origin');
  const html = await readFile(new URL('./build/card.html', import.meta.url), 'utf8');
  const adminToken = randomBytes(32).toString('base64url');
  const probe = createProbe({ publicOrigin: origin, widgetOrigin, html, adminToken });
  await checkDir(true);
  let accessCreated = false;
  try {
    // Exclusive file prevents silently starting a second probe or replacing the
    // currently authorized operator capability. No production DB is involved.
    await createPrivate(accessFile, JSON.stringify({ adminUrl: 'http://127.0.0.1:8808', token: adminToken }));
    accessCreated = true;
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= (async () => {
      await probe.close(); await unlink(accessFile); console.log('Probe stopped; operator capability removed.');
    })();
    probe.admin.post('/shutdown', async (_req, reply) => {
      reply.raw.once('finish', () => { void stop(); }); return { stopping: true };
    });
    await probe.http.listen({ host: '127.0.0.1', port: 8807 });
    await probe.admin.listen({ host: '127.0.0.1', port: 8808 });
    process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
    console.log(`Local-only wake probe ready: 127.0.0.1:8807/widget-wake-probe/mcp; operator access: ${accessFile}. No production routes changed.`);
  } catch (error) {
    await probe.close(); if (accessCreated) await unlink(accessFile);
    throw error;
  }
}
