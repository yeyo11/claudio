import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { isServerActor, parseServerLinkHub, serverActor, serverLinksNeedAuth, type Core, type ServerLinkHub } from '@claudio/core';
import type { ServerLink, ServerLinkCode, ServerLinkGrant, ServerMeta } from '@claudio/shared';
import { isOwnerActor, type Guard } from '../security.ts';
import { revokeTerminalAccess } from '../terminal-socket.ts';

/**
 * The remote side of Servers (docs/plans/claudio-servers.md, §4.1): who this server is, and how a
 * hub pairs with it and lets go of it. Every Claudio serves these, since each can be a remote. A
 * refusal is a status with its `code`; under auth mode `none` pairing is a `409`, as the LAN
 * listener answers for the same reason.
 */
export const serverLinkRoutes: FastifyPluginAsync<{ core: Core; guard: Guard }> = async (app, { core, guard }) => {
  // Open: a hub probes it on every address before it trusts one (D3, D5)
  app.get('/meta', (): ServerMeta => core.identity.meta);

  const refuse = (reply: FastifyReply, status: number, code: string, error: string): FastifyReply => reply.status(status).send({ error, code });

  /**
   * Codes and tokens are the owner's to hand out. Not a hub's, though a hub is an owner otherwise:
   * a hub that minted further links would chain hops (D7), and its links would outlive the revoke
   * of its own token.
   */
  const ownerRefusal = (req: FastifyRequest, reply: FastifyReply): FastifyReply | null => {
    if (isOwnerActor(req.actor) && !isServerActor(req.actor)) return null;
    return refuse(reply, 403, 'server-links.not-owner', "only the owner's token or OIDC identity can let another Claudio in");
  };

  const grantFor = async (hub: ServerLinkHub): Promise<ServerLinkGrant> => {
    const { token, tokenId } = await core.security.mintServerToken(hub);
    return { token, tokenId, instanceId: core.identity.instanceId, tlsFingerprint: core.identity.tlsFingerprint() };
  };

  const hubOf = (body: unknown): ServerLinkHub => {
    const hub = parseServerLinkHub(body);
    // One hop, and never to itself: a server paired with itself would gateway into its own API
    if (hub.hubInstanceId === core.identity.instanceId) throw Object.assign(new Error('a Claudio cannot pair with itself'), { statusCode: 400, reason: 'server-links.self' });
    return hub;
  };

  app.post('/server-links/code', async (req, reply): Promise<ServerLinkCode | FastifyReply> => {
    if (core.security.mode === 'none') throw serverLinksNeedAuth();
    return ownerRefusal(req, reply) ?? core.security.serverLinkCodes.issue();
  });

  /**
   * Open, because the code is the credential: the hub holds nothing else yet. A wrong code counts in
   * the sign-in back-off of the peer that sent it, and the code itself survives only a few wrong
   * guesses from anyone (`SERVER_LINK_CODE_MAX_WRONG`).
   */
  app.post<{ Body: unknown }>('/server-links/redeem', async (req, reply): Promise<ServerLinkGrant | FastifyReply> => {
    // Nobody yet: a refusal goes to the ring of anonymous ones, and a success names the new token
    req.actor = 'anonymous';
    if (core.security.mode === 'none') throw serverLinksNeedAuth();
    // The guard lets an open route through read-only; minting a credential is a change all the same
    if (core.security.readOnly) return refuse(reply, 405, 'read-only', 'read-only mode is on: this wrapper accepts no changes');
    const client = guard.backoffKey(req);
    const wait = guard.backoff.retryAfter(client);
    if (wait > 0) {
      void reply.header('Retry-After', String(wait));
      return refuse(reply, 429, 'server-links.too-many', 'too many wrong pairing codes from this address');
    }
    const code = (req.body as { code?: unknown } | null | undefined)?.code;
    if (typeof code !== 'string' || !code.trim()) return refuse(reply, 400, 'server-links.code-missing', 'code is required');
    const hub = hubOf(req.body);
    if (!core.security.serverLinkCodes.redeem(code)) {
      guard.backoff.fail(client);
      return refuse(reply, 403, 'server-links.code-invalid', 'the pairing code is wrong, expired or already used');
    }
    const grant = await grantFor(hub);
    req.actor = serverActor(grant.tokenId);
    return grant;
  });

  // The pasted URL + token way: the owner's credential mints the hub's own, which the hub keeps instead
  app.post<{ Body: unknown }>('/server-links', async (req, reply): Promise<ServerLinkGrant | FastifyReply> => {
    if (core.security.mode === 'none') throw serverLinksNeedAuth();
    const refused = ownerRefusal(req, reply);
    if (refused) return refused;
    return grantFor(hubOf(req.body));
  });

  // The hubs this server lets in, for its owner to see and cut (D14); never a secret, only what each hub said it is
  app.get('/server-links', async (req, reply): Promise<ServerLink[] | FastifyReply> => {
    const refused = ownerRefusal(req, reply);
    if (refused) return refused;
    return core.security.serverTokens.map((each) => ({ tokenId: each.id, hubName: each.name, hubInstanceId: each.hubInstanceId, createdAt: each.createdAt, lastUsedAt: each.lastUsedAt }));
  });

  /**
   * The owner revokes a hub without that hub's help (D14): a hub that was lost, or that its owner
   * never removed. Not another hub's to call, as with minting: one hub must not cut another out.
   */
  app.delete<{ Params: { tokenId: string } }>('/server-links/:tokenId', async (req, reply) => {
    const refused = ownerRefusal(req, reply);
    if (refused) return refused;
    if (!(await core.security.revokeServerToken(req.params.tokenId))) return refuse(reply, 404, 'server-links.not-found', 'no paired server holds a token with that id');
    revokeTerminalAccess(core);
    return reply.status(204).send();
  });

  // A hub whose owner removed this server gives its token back (R8)
  app.delete('/server-links/self', async (req, reply) => {
    if (!isServerActor(req.actor)) return refuse(reply, 403, 'server-links.not-server', "only a paired server's own token can revoke itself");
    const [scheme, ...rest] = (req.headers.authorization ?? '').split(' ');
    const credential = scheme?.toLowerCase() === 'bearer' ? rest.join(' ').trim() : '';
    // By the credential, not the actor's name: an OIDC subject could read `server:<id>` too
    if (!credential || (await core.security.revokeServerCredential(credential)) === null) {
      return refuse(reply, 403, 'server-links.not-server', "only a paired server's own token can revoke itself");
    }
    // A terminal socket that token opened goes with it, as with the owner's token rotated
    revokeTerminalAccess(core);
    return reply.status(204).send();
  });
};
