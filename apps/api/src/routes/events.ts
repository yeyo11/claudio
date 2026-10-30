import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@claudio/core';
import type { ClaudioEvent, StreamHelloEvent, StreamResyncEvent } from '@claudio/shared';
import { isOwnerActor } from '../security.ts';
import { openStream } from '../sse.ts';

/**
 * Whether a stream may carry a sign-in's URL and code. A device code approves a `gh` or `glab`
 * sign-in for whoever enters it first, and Tailscale's URL is the sign-in itself, so they reach the
 * owner's credential (or an open install, where every caller is the person's) and nobody else: a
 * chat's token, the desktop app's tray, anything the guard did not name the owner (report §8.4).
 */
const seesSignIns = (actor: string | null): boolean => actor === 'local' || isOwnerActor(actor);

/** The event as a stream that is not the owner's gets it: the sign-in's state without its secrets */
function forStream(event: ClaudioEvent, owner: boolean): ClaudioEvent {
  if (owner || event.type !== 'login.updated') return event;
  return { ...event, login: { ...event.login, url: null, code: null } };
}

export const eventRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  // One stream for the whole app, so a UI never has to poll. Like /runs/:id/stream, a client that
  // reconnects with Last-Event-ID is sent what it missed before the live events.
  app.get<{ Querystring: { since?: string } }>('/events', (req, reply) => {
    const lastEventId = Number(req.headers['last-event-id'] ?? req.query.since ?? 0) || 0;

    const stream = openStream(req, reply);
    // Decided once: the stream's credential does not change while it is open, replay included
    const owner = seesSignIns(req.actor);
    const write = (event: ClaudioEvent) => stream.send(forStream(event, owner), { event: event.type, id: event.id });

    // Nothing awaits between subscribing and replaying, so no event can slip in between them
    stream.onClose(core.events.subscribe(write));

    const hello: StreamHelloEvent = {
      type: 'stream.hello',
      lastEventId: core.events.lastEventId,
      bootId: core.events.bootId,
      serverTime: new Date().toISOString(),
      version: core.version,
    };
    stream.send(hello, { event: hello.type });
    // A first connection has nothing to catch up on; a reconnection asks to continue from an id
    if (lastEventId > 0) {
      const replay = core.events.since(lastEventId);
      if ('resync' in replay) {
        const resync: StreamResyncEvent = { type: 'stream.resync', lastEventId: core.events.lastEventId, reason: replay.resync };
        stream.send(resync, { event: resync.type });
      } else {
        for (const event of replay.events) write(event);
      }
    }
  });
};
