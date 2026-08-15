import type { FastifyInstance } from 'fastify';
import { requireSession } from '../lib/authGuard.js';
import { notFound } from '../lib/errors.js';
import type { NotificationStore } from '../repos/notifications.js';

export async function registerNotificationRoutes(app: FastifyInstance, deps: { notifications: NotificationStore; jwtSecret: string }) {
  app.get('/notifications', async (request) => { const { sub } = requireSession(request, deps.jwtSecret); return { notifications: await deps.notifications.list(sub, 50) }; });
  app.get('/notifications/unread-count', async (request) => { const { sub } = requireSession(request, deps.jwtSecret); return { unreadCount: await deps.notifications.unreadCount(sub) }; });
  app.patch('/notifications/:id/read', async (request) => { const { sub } = requireSession(request, deps.jwtSecret); const { id } = request.params as { id: string }; if (!await deps.notifications.markRead(sub, id)) throw notFound('NOTIFICATION_NOT_FOUND', 'Notification not found'); return { read: true }; });
  app.post('/notifications/read-all', async (request) => { const { sub } = requireSession(request, deps.jwtSecret); return { markedRead: await deps.notifications.markAllRead(sub) }; });
}
