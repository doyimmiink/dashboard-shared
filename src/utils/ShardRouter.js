/**
 * ShardRouter
 *
 * Pure routing utility. Computes shard and cluster routing decisions
 * for a given entityId without spawning any processes.
 *
 * Compose with any HTTP framework by reading the result of resolve()
 * and applying your own redirect or proxy logic.
 *
 * Example with Express:
 *
 *   const router = new ShardRouter({ totalShards: 4, totalClusters: 2 });
 *
 *   app.use((req, res, next) => {
 *     const info = router.resolve(req.user.id);
 *     req.shardInfo = info;
 *     next();
 *   });
 */

const { resolveShardId } = require("../manager/ShardManager");

class ShardRouter {
  /**
   * @param {object} opts
   * @param {number}        opts.totalShards     - Total shard count.
   * @param {number}        [opts.totalClusters] - Total cluster count (optional).
   * @param {string[]|null} [opts.shardUrls]     - Base URL per shard index.
   */
  constructor(opts = {}) {
    if (!opts.totalShards || opts.totalShards < 1) {
      throw new RangeError("totalShards must be >= 1");
    }

    this.totalShards = opts.totalShards;
    this.totalClusters = opts.totalClusters ?? null;
    this.shardUrls = opts.shardUrls ?? null;
  }

  /**
   * Resolves full routing metadata for a given entity.
   *
   * @param {string|number} entityId
   * @returns {{
   *   entityId: string|number,
   *   shardId: number,
   *   clusterId: number|null,
   *   redirectUrl: string|null,
   *   isLocal: (currentShardId: number) => boolean
   * }}
   */
  resolve(entityId) {
    const shardId = resolveShardId(entityId, this.totalShards);
    const clusterId = this.totalClusters ? this._shardToCluster(shardId) : null;
    const redirectUrl = this.shardUrls?.[shardId] ?? null;

    return {
      entityId,
      shardId,
      clusterId,
      redirectUrl,
      isLocal: (currentShardId) => currentShardId === shardId,
    };
  }

  /**
   * Returns the full shard -> cluster distribution table.
   * Returns an empty array when totalClusters is not set.
   *
   * @returns {Array<{ clusterId: number, shards: number[] }>}
   */
  distribution() {
    if (!this.totalClusters) return [];

    const map = new Map();
    for (let s = 0; s < this.totalShards; s++) {
      const cid = this._shardToCluster(s);
      if (!map.has(cid)) map.set(cid, []);
      map.get(cid).push(s);
    }

    return Array.from(map.entries()).map(([clusterId, shards]) => ({
      clusterId,
      shards,
    }));
  }

  // --- private ---

  _shardToCluster(shardId) {
    if (!this.totalClusters) return null;

    const base = Math.floor(this.totalShards / this.totalClusters);
    const extra = this.totalShards % this.totalClusters;

    let cursor = 0;
    for (let cid = 0; cid < this.totalClusters; cid++) {
      const size = base + (cid < extra ? 1 : 0);
      if (shardId >= cursor && shardId < cursor + size) return cid;
      cursor += size;
    }

    return 0;
  }
}

module.exports = { ShardRouter };
