/**
 * ClusterManager
 *
 * Groups shards into clusters using node:cluster.
 * Each cluster is a worker process running a contiguous range of shards,
 * allowing full utilisation of multiple CPU cores.
 *
 * Layout example (8 shards, 4 clusters):
 *   Cluster 0 -> Shards 0, 1
 *   Cluster 1 -> Shards 2, 3
 *   Cluster 2 -> Shards 4, 5
 *   Cluster 3 -> Shards 6, 7
 */

const cluster = require("node:cluster");
const os = require("node:os");
const EventEmitter = require("node:events");
const { resolveShardId } = require("../manager/ShardManager");

const ClusterStatus = {
  IDLE: "IDLE",
  SPAWNING: "SPAWNING",
  READY: "READY",
  CRASHED: "CRASHED",
};

class ClusterManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number}  opts.totalShards     - Total number of shards across all clusters.
   * @param {number}  [opts.totalClusters] - Number of cluster workers. Defaults to CPU count.
   * @param {boolean} [opts.autoRespawn]   - Respawn crashed clusters. Default: true.
   * @param {object}  [opts.env]           - Extra env vars for each worker.
   */
  constructor(opts = {}) {
    super();

    if (!opts.totalShards || opts.totalShards < 1) {
      throw new RangeError("totalShards must be >= 1");
    }

    const cpuCount = os.availableParallelism?.() ?? os.cpus().length;

    this.totalShards = opts.totalShards;
    this.totalClusters = opts.totalClusters ?? Math.min(cpuCount, opts.totalShards);
    this.autoRespawn = opts.autoRespawn !== false;
    this.env = opts.env ?? {};

    /** @type {Map<number, object>} clusterId -> internal entry */
    this.clusters = new Map();
  }

  /**
   * Returns the shard range assigned to a cluster.
   * Remainder shards are distributed one at a time to the first clusters.
   *
   * @param {number} clusterId
   * @returns {{ start: number, end: number, shards: number[] }}
   */
  getClusterShards(clusterId) {
    const base = Math.floor(this.totalShards / this.totalClusters);
    const extra = this.totalShards % this.totalClusters;

    const start = clusterId * base + Math.min(clusterId, extra);
    const end = start + base + (clusterId < extra ? 1 : 0) - 1;

    const shards = [];
    for (let s = start; s <= end; s++) {
      shards.push(s);
    }

    return { start, end, shards };
  }

  /**
   * Resolves which cluster and shard own the given entity.
   *
   * @param {string|number} entityId
   * @returns {{ shardId: number, clusterId: number }}
   */
  resolve(entityId) {
    const shardId = resolveShardId(entityId, this.totalShards);
    const clusterId = this._shardToCluster(shardId);
    return { shardId, clusterId };
  }

  /**
   * Spawns all cluster workers. Must be called from the primary process.
   *
   * @returns {Promise<void>}
   */
  async spawn() {
    if (!cluster.isPrimary) {
      throw new Error("ClusterManager.spawn() must be called from the primary process");
    }

    for (let id = 0; id < this.totalClusters; id++) {
      await this._spawnCluster(id);
    }
  }

  /**
   * Returns a status snapshot for every cluster.
   *
   * @returns {Array<{ id: number, status: string, pid: number|null, shards: number[] }>}
   */
  getStatus() {
    return Array.from(this.clusters.values()).map((entry) => ({
      id: entry.id,
      status: entry.status,
      pid: entry.worker ? entry.worker.process.pid : null,
      shards: this.getClusterShards(entry.id).shards,
    }));
  }

  // --- private ---

  async _spawnCluster(id) {
    const { shards } = this.getClusterShards(id);

    const env = {
      ...this.env,
      CLUSTER_ID: String(id),
      TOTAL_CLUSTERS: String(this.totalClusters),
      TOTAL_SHARDS: String(this.totalShards),
      SHARD_LIST: JSON.stringify(shards),
    };

    const entry = {
      id,
      status: ClusterStatus.SPAWNING,
      worker: null,
    };

    this.clusters.set(id, entry);
    this.emit("clusterSpawning", id);

    const worker = cluster.fork(env);
    entry.worker = worker;

    worker.on("message", (msg) => {
      if (msg?.type === "READY") {
        entry.status = ClusterStatus.READY;
        this.emit("clusterReady", id);
      }
      this.emit("message", id, msg);
    });

    worker.on("exit", (code) => {
      entry.status = ClusterStatus.CRASHED;
      entry.worker = null;
      this.emit("clusterCrash", id, code);

      if (this.autoRespawn) {
        setTimeout(() => this._spawnCluster(id), 2_000);
      }
    });

    return new Promise((resolve) => {
      const onReady = (cid) => {
        if (cid !== id) return;
        this.off("clusterReady", onReady);
        resolve();
      };

      this.on("clusterReady", onReady);
      setTimeout(resolve, 10_000);
    });
  }

  _shardToCluster(shardId) {
    for (let cid = 0; cid < this.totalClusters; cid++) {
      const { start, end } = this.getClusterShards(cid);
      if (shardId >= start && shardId <= end) return cid;
    }
    return 0;
  }
}

module.exports = { ClusterManager, ClusterStatus };
