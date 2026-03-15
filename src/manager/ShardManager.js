/**
 * ShardManager
 *
 * Spawns and supervises N shard processes via child_process.fork.
 * Each shard is assigned entities deterministically:
 *   entityId % totalShards === shardId
 *
 * Mirrors discord.js ShardingManager, but fully entity-agnostic.
 */

const { fork } = require("node:child_process");
const EventEmitter = require("node:events");

const ShardStatus = {
  IDLE: "IDLE",
  SPAWNING: "SPAWNING",
  READY: "READY",
  RECONNECTING: "RECONNECTING",
  CRASHED: "CRASHED",
};

class ShardManager extends EventEmitter {
  /**
   * @param {string} script - Absolute path to the shard entry file.
   * @param {object} opts
   * @param {number}  opts.totalShards   - Total number of shards to spawn.
   * @param {boolean} [opts.autoRespawn] - Respawn crashed shards. Default: true.
   * @param {number}  [opts.spawnDelay]  - Delay in ms between spawns. Default: 500.
   * @param {object}  [opts.env]         - Extra env vars injected into each shard process.
   */
  constructor(script, opts = {}) {
    super();

    if (typeof script !== "string") {
      throw new TypeError("script must be a string path");
    }

    if (!opts.totalShards || opts.totalShards < 1) {
      throw new RangeError("totalShards must be >= 1");
    }

    this.script = script;
    this.totalShards = opts.totalShards;
    this.autoRespawn = opts.autoRespawn !== false;
    this.spawnDelay = opts.spawnDelay ?? 500;
    this.env = opts.env ?? {};

    /** @type {Map<number, object>} shardId -> internal shard entry */
    this.shards = new Map();
  }

  /**
   * Spawns all shards sequentially with the configured delay.
   * Resolves when every shard has reported READY (or timed out after 10 s).
   *
   * @returns {Promise<void>}
   */
  async spawn() {
    for (let id = 0; id < this.totalShards; id++) {
      await this._spawnShard(id);
      if (id < this.totalShards - 1) {
        await _sleep(this.spawnDelay);
      }
    }
  }

  /**
   * Evaluates a JS expression in every shard's context and collects results.
   * Mirrors client.shard.broadcastEval() from discord.js.
   *
   * @param {string} script - Expression evaluated inside each shard process.
   * @returns {Promise<any[]>}
   */
  broadcastEval(script) {
    const promises = Array.from(this.shards.values()).map((entry) =>
      this._sendEval(entry, script)
    );
    return Promise.all(promises);
  }

  /**
   * Reads a named property from every shard's eval context.
   * Mirrors client.shard.fetchClientValues() from discord.js.
   *
   * @param {string} prop
   * @returns {Promise<any[]>}
   */
  fetchClientValues(prop) {
    return this.broadcastEval(prop);
  }

  /**
   * Determines which shard owns the given entity.
   *
   * @param {string|number} entityId
   * @returns {number} shardId
   */
  resolveShardId(entityId) {
    return resolveShardId(entityId, this.totalShards);
  }

  /**
   * Returns a status snapshot for every shard.
   *
   * @returns {Array<{ id: number, status: string, pid: number|null }>}
   */
  getStatus() {
    return Array.from(this.shards.values()).map((entry) => ({
      id: entry.id,
      status: entry.status,
      pid: entry.process ? entry.process.pid : null,
    }));
  }

  // --- private ---

  async _spawnShard(id) {
    const env = {
      ...process.env,
      ...this.env,
      SHARD_ID: String(id),
      TOTAL_SHARDS: String(this.totalShards),
    };

    const entry = {
      id,
      status: ShardStatus.SPAWNING,
      process: null,
      _pending: new Map(),
      _nonce: 0,
    };

    this.shards.set(id, entry);
    this.emit("shardSpawning", id);

    const child = fork(this.script, [], { env, silent: false });
    entry.process = child;

    child.on("message", (msg) => this._onMessage(entry, msg));
    child.on("exit", (code) => this._onExit(entry, code));

    return new Promise((resolve) => {
      const onReady = (shardId) => {
        if (shardId !== id) return;
        this.removeListener("shardReady", onReady);
        resolve();
      };

      this.on("shardReady", onReady);
      setTimeout(resolve, 10_000);
    });
  }

  _onMessage(entry, msg) {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "READY") {
      entry.status = ShardStatus.READY;
      this.emit("shardReady", entry.id);
      return;
    }

    if (msg.type === "EVAL_RESPONSE") {
      const pending = entry._pending.get(msg.nonce);
      if (!pending) return;

      entry._pending.delete(msg.nonce);

      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    this.emit("message", entry.id, msg);
  }

  _onExit(entry, code) {
    entry.status = ShardStatus.CRASHED;
    entry.process = null;

    this.emit("shardCrash", entry.id, code);

    if (this.autoRespawn) {
      setTimeout(() => {
        this.emit("shardRespawning", entry.id);
        this._spawnShard(entry.id);
      }, 2_000);
    }
  }

  _sendEval(entry, script) {
    return new Promise((resolve, reject) => {
      if (!entry.process) {
        return reject(new Error(`Shard ${entry.id} has no active process`));
      }

      const nonce = entry._nonce++;
      entry._pending.set(nonce, { resolve, reject });
      entry.process.send({ type: "EVAL", nonce, script });

      setTimeout(() => {
        if (entry._pending.has(nonce)) {
          entry._pending.delete(nonce);
          reject(new Error(`Shard ${entry.id} eval timed out`));
        }
      }, 5_000);
    });
  }
}

/**
 * Resolves which shard owns an entity.
 * Uses the same formula as Discord gateway sharding: entityId % totalShards.
 * String IDs are hashed to a stable integer before the modulo.
 *
 * @param {string|number} entityId
 * @param {number} totalShards
 * @returns {number}
 */
function resolveShardId(entityId, totalShards) {
  if (typeof entityId === "string") {
    let hash = 0;
    for (let i = 0; i < entityId.length; i++) {
      hash = (Math.imul(31, hash) + entityId.charCodeAt(i)) | 0;
    }
    entityId = Math.abs(hash);
  }
  return Number(entityId) % totalShards;
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { ShardManager, ShardStatus, resolveShardId };
