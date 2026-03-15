/**
 * ShardClient
 *
 * Runs inside each shard (child) process.
 * Reads SHARD_ID / TOTAL_SHARDS from env, handles incoming EVAL requests
 * from the manager, and signals READY once the app is initialised.
 *
 * Usage inside your shard entry file:
 *
 *   const { ShardClient } = require("@dashboard-shared/core");
 *   const shard = new ShardClient();
 *   shard.on("ready", () => console.log(`Shard ${shard.id} online`));
 *   shard.init();
 */

const EventEmitter = require("node:events");
const { resolveShardId } = require("../manager/ShardManager");

class ShardClient extends EventEmitter {
  constructor() {
    super();

    this.id = Number(process.env.SHARD_ID ?? 0);
    this.totalShards = Number(process.env.TOTAL_SHARDS ?? 1);
    this.clusterId = process.env.CLUSTER_ID != null
      ? Number(process.env.CLUSTER_ID)
      : null;

    this._evalContext = {};
  }

  /**
   * Registers the IPC listener and signals the manager this shard is ready.
   * Call this once your server / app is fully initialised.
   */
  init() {
    process.on("message", (msg) => this._onMessage(msg));
    process.send?.({ type: "READY", shardId: this.id });
    this.emit("ready");
  }

  /**
   * Returns true if this shard owns the given entity.
   *
   * @param {string|number} entityId
   * @returns {boolean}
   */
  owns(entityId) {
    return resolveShardId(entityId, this.totalShards) === this.id;
  }

  /**
   * Exposes a value in this shard's eval context so the manager can read
   * it via fetchClientValues().
   *
   * @param {string} key
   * @param {*} value
   */
  setContext(key, value) {
    this._evalContext[key] = value;
  }

  /**
   * Sends a custom message to the manager process.
   *
   * @param {object} payload
   */
  send(payload) {
    process.send?.({ ...payload, shardId: this.id });
  }

  // --- private ---

  _onMessage(msg) {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "EVAL") {
      let result;
      let error;

      try {
        const ctx = this._evalContext;
        result = Function("ctx", `"use strict"; return (${msg.script})`)(ctx);
      } catch (err) {
        error = err.message;
      }

      process.send?.({ type: "EVAL_RESPONSE", nonce: msg.nonce, result, error });
      return;
    }

    this.emit("message", msg);
  }
}

module.exports = { ShardClient };
