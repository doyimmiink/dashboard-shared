/**
 * IPCBroker
 *
 * In-process message broker that simulates inter-shard communication
 * without spawning real child processes. Useful for:
 *   - Unit testing shard logic in a single process
 *   - Lightweight multi-tenant apps that want logical sharding without forking
 *
 * For real multi-process IPC, ShardManager handles it natively via
 * child_process message passing.
 */

const { resolveShardId } = require("../manager/ShardManager");

class IPCBroker {
  constructor() {
    /** @type {Map<number, object>} shardId -> { id, context, handlers } */
    this._shards = new Map();
    this._totalShards = 0;
  }

  /**
   * Registers a virtual shard with the broker.
   *
   * @param {number} shardId
   * @param {number} totalShards
   */
  registerShard(shardId, totalShards) {
    if (this._shards.has(shardId)) return;
    this._totalShards = totalShards;
    this._shards.set(shardId, {
      id: shardId,
      context: {},
      handlers: new Map(),
    });
  }

  /**
   * Sets a named value in a shard's context.
   *
   * @param {number} shardId
   * @param {string} key
   * @param {*} value
   */
  setContext(shardId, key, value) {
    this._get(shardId).context[key] = value;
  }

  /**
   * Reads a named value from a shard's context.
   *
   * @param {number} shardId
   * @param {string} key
   * @returns {*}
   */
  getContext(shardId, key) {
    return this._get(shardId).context[key];
  }

  /**
   * Registers a message handler for a specific shard and message type.
   *
   * @param {number} shardId
   * @param {string} type
   * @param {Function} handler - (payload) => result
   */
  onMessage(shardId, type, handler) {
    this._get(shardId).handlers.set(type, handler);
  }

  /**
   * Routes a message to the shard that owns the given entity.
   *
   * @param {string|number} entityId
   * @param {string} type
   * @param {object} [payload]
   * @returns {{ shardId: number, result: * }}
   */
  route(entityId, type, payload = {}) {
    const shardId = resolveShardId(entityId, this._totalShards);
    const shard = this._shards.get(shardId);

    if (!shard) {
      throw new Error(
        `No shard registered for entityId ${entityId} (resolved to ${shardId})`
      );
    }

    const handler = shard.handlers.get(type);
    if (!handler) {
      throw new Error(`No handler for type "${type}" on shard ${shardId}`);
    }

    const result = handler({ ...payload, entityId, shardId });
    return { shardId, result };
  }

  /**
   * Fans a message out to all registered shards and collects results.
   *
   * @param {string} type
   * @param {object} [payload]
   * @returns {Array<{ shardId: number, result: * }>}
   */
  broadcast(type, payload = {}) {
    const results = [];
    for (const [id, shard] of this._shards) {
      const handler = shard.handlers.get(type);
      if (handler) {
        results.push({ shardId: id, result: handler({ ...payload, shardId: id }) });
      }
    }
    return results;
  }

  /**
   * Evaluates a JS expression against every shard's context.
   *
   * @param {string} script - Receives `ctx` as the shard context object.
   * @returns {Array<{ shardId: number, result: *, error?: string }>}
   */
  broadcastEval(script) {
    const fn = Function("ctx", `"use strict"; return (${script})`);
    const results = [];

    for (const [id, shard] of this._shards) {
      try {
        results.push({ shardId: id, result: fn(shard.context) });
      } catch (err) {
        results.push({ shardId: id, result: null, error: err.message });
      }
    }

    return results;
  }

  /**
   * Returns metadata about all registered shards.
   *
   * @returns {Array<{ id: number, contextKeys: string[] }>}
   */
  inspect() {
    return Array.from(this._shards.values()).map((s) => ({
      id: s.id,
      contextKeys: Object.keys(s.context),
    }));
  }

  // --- private ---

  _get(shardId) {
    const shard = this._shards.get(shardId);
    if (!shard) {
      throw new Error(`Shard ${shardId} is not registered in this broker`);
    }
    return shard;
  }
}

module.exports = { IPCBroker };
