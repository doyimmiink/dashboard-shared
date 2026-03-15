/**
 * @dashboard-shared/core
 *
 * Sharding and clustering orchestration for dashboard applications.
 * Entity-agnostic - works with any tenant, user, guild, or session identifier.
 *
 * Primary process:
 *   ShardManager   - spawns and supervises shard child processes
 *   ClusterManager - groups shards into CPU-pinned cluster workers
 *   ShardRouter    - resolves routing decisions without spawning anything
 *
 * Shard process:
 *   ShardClient    - identity and IPC helper running inside each shard
 *
 * Testing / single-process:
 *   IPCBroker      - in-process message bus that simulates multi-shard IPC
 *
 * Utilities:
 *   resolveShardId - entityId % totalShards (stable hash for string IDs)
 *   ShardStatus    - enum of manager shard statuses
 *   ClusterStatus  - enum of cluster statuses
 */

const { ShardManager, ShardStatus, resolveShardId } = require("./manager/ShardManager");
const { ClusterManager, ClusterStatus } = require("./cluster/ClusterManager");
const { ShardClient } = require("./shard/ShardClient");
const { IPCBroker } = require("./ipc/IPCBroker");
const { ShardRouter } = require("./utils/ShardRouter");

module.exports = {
  ShardManager,
  ClusterManager,
  ShardClient,
  IPCBroker,
  ShardRouter,
  ShardStatus,
  ClusterStatus,
  resolveShardId,
};
