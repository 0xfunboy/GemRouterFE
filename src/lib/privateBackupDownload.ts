import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

interface PrivateBackupDownloadOptions {
  directory: string;
  ensureAdmin: (request: FastifyRequest, reply: FastifyReply) => boolean;
  audit?: (event: {
    type: string;
    route: string;
    details: { filename: string; size: number };
  }) => void;
}

const route = '/v1/admin/backup/private-download/:filename';
const backupName = /^gemrouter-private-\d{8}T\d{6}Z(?:-[a-f0-9]{1,64})?\.tar\.gz$/;

/** Serve existing private archives only through the normal admin authentication. */
export function registerPrivateBackupDownload(app: FastifyInstance, options: PrivateBackupDownloadOptions): void {
  const directory = path.resolve(options.directory);
  app.get<{ Params: { filename: string } }>(route, async (request, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    if (!options.ensureAdmin(request, reply)) return reply;
    const filename = request.params.filename;
    if (!backupName.test(filename)) return reply.code(404).send({ error: 'backup_not_found' });
    let file: FileHandle | undefined;
    try {
      // Nonblocking open also allows us to reject FIFOs without waiting for a writer.
      file = await open(path.join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || typeof process.getuid !== 'function' || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
        await file.close(); file = undefined;
        return reply.code(404).send({ error: 'backup_not_found' });
      }
      options.audit?.({ type: 'backup_private_download', route, details: { filename, size: stat.size } });
      const stream = file.createReadStream({ autoClose: true });
      file = undefined; // The stream owns the verified descriptor, never reopen the path.
      return reply
        .type('application/gzip')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .header('content-length', stat.size)
        .send(stream);
    } catch {
      await file?.close().catch(() => undefined);
      return reply.code(404).send({ error: 'backup_not_found' });
    }
  });
}
