# @dashboard-shared/core

Sharding and clustering orchestration for dashboard applications.\
Entity-agnostic — works with any identifier: user IDs, tenant slugs, session tokens, guild IDs.

No external dependencies. Node.js 16+.


## Installation

```bash
npm install @dashboard-shared/core
```


## Concepts

The library mirrors the architecture of discord.js sharding but applied to generic web dashboards.

**Sharding** splits your entity space across N processes. Each entity is owned by exactly one shard, determined by `entityId % totalShards`. A string ID is first hashed to a stable integer, then the same modulo is applied.

**Clustering** groups shards into workers pinned to CPU cores. A cluster manager spawns M worker processes via `node:cluster`, each responsible for a contiguous range of shards.

**IPCBroker** simulates the full multi-shard setup inside a single process. Useful for testing and for lightweight apps that want logical sharding without the overhead of forking.


## API reference

### `resolveShardId(entityId, totalShards)`

Determines which shard owns an entity.

```js
const { resolveShardId } = require("@dashboard-shared/core");

resolveShardId(5, 4);          // 1  (5 % 4)
resolveShardId("user-abc", 4); // stable integer, same every call
```


### `ShardManager`

Spawns and supervises N shard child processes via `child_process.fork`.

```js
const { ShardManager } = require("@dashboard-shared/core");

const manager = new ShardManager("./shard.js", {
  totalShards: 4,
  autoRespawn: true,
  spawnDelay: 500,
  env: { MY_VAR: "hello" },
});

manager.on("shardReady", (id) => console.log(`Shard ${id} ready`));
manager.on("shardCrash", (id, code) => console.warn(`Shard ${id} exited with code ${code}`));

await manager.spawn();

// Collect a value from every shard
const counts = await manager.fetchClientValues("ctx.entityCount");

// Run an expression in every shard's context
const results = await manager.broadcastEval("ctx.entityCount * 2");
```

**Constructor options**

| Option | Type | Default | Description |
|---|---|---|---|
| `totalShards` | number | required | Number of shard processes to spawn |
| `autoRespawn` | boolean | `true` | Restart a shard automatically after a crash |
| `spawnDelay` | number | `500` | Milliseconds between spawning each shard |
| `env` | object | `{}` | Extra environment variables for each shard process |

**Methods**

| Method | Returns | Description |
|---|---|---|
| `spawn()` | `Promise<void>` | Spawns all shards sequentially |
| `broadcastEval(script)` | `Promise<any[]>` | Evaluates a JS expression in every shard |
| `fetchClientValues(prop)` | `Promise<any[]>` | Reads a named context property from every shard |
| `resolveShardId(entityId)` | `number` | Which shard owns an entity |
| `getStatus()` | `object[]` | Snapshot of every shard's status and PID |

**Events**

| Event | Arguments | Description |
|---|---|---|
| `shardSpawning` | `id` | Shard process is being forked |
| `shardReady` | `id` | Shard sent the READY signal |
| `shardCrash` | `id, code` | Shard process exited |
| `shardRespawning` | `id` | Auto-respawn is about to start |
| `message` | `id, msg` | Shard sent a custom message |


### `ShardClient`

Runs inside each shard process. Handles IPC and signals READY.

```js
// shard.js
const { ShardClient } = require("@dashboard-shared/core");

const shard = new ShardClient();

shard.on("ready", () => {
  console.log(`Shard ${shard.id} of ${shard.totalShards} online`);
});

// Expose values readable by the manager via fetchClientValues / broadcastEval
shard.setContext("entityCount", 0);
shard.setContext("uptime", process.uptime());

// Tell the manager this shard is ready
shard.init();

// Check ownership before processing a request
function handleRequest(entityId) {
  if (!shard.owns(entityId)) return; // not our entity
  // process it
}
```

**Properties**

| Property | Type | Description |
|---|---|---|
| `id` | number | This shard's index (from `SHARD_ID` env) |
| `totalShards` | number | Total shard count (from `TOTAL_SHARDS` env) |
| `clusterId` | number\|null | Cluster index if running under ClusterManager |

**Methods**

| Method | Description |
|---|---|
| `init()` | Starts IPC listener and sends READY to manager |
| `owns(entityId)` | Returns true if this shard owns the entity |
| `setContext(key, value)` | Exposes a value to the manager's eval calls |
| `send(payload)` | Sends a custom message to the manager |


### `ClusterManager`

Groups shards into CPU worker processes via `node:cluster`.

```js
const { ClusterManager } = require("@dashboard-shared/core");

const manager = new ClusterManager({
  totalShards: 8,
  totalClusters: 4,
  autoRespawn: true,
});

manager.on("clusterReady", (id) => console.log(`Cluster ${id} ready`));

if (require("node:cluster").isPrimary) {
  await manager.spawn();
} else {
  // worker process — boot your shard here
}

// See which cluster owns an entity
const { shardId, clusterId } = manager.resolve("user-abc");

// See the full distribution
const status = manager.getStatus();
```

**Constructor options**

| Option | Type | Default | Description |
|---|---|---|---|
| `totalShards` | number | required | Total shards across all clusters |
| `totalClusters` | number | CPU count | Number of cluster workers |
| `autoRespawn` | boolean | `true` | Restart crashed clusters |
| `env` | object | `{}` | Extra env vars for each worker |

**Methods**

| Method | Returns | Description |
|---|---|---|
| `spawn()` | `Promise<void>` | Spawns all cluster workers (primary only) |
| `getClusterShards(clusterId)` | `{ start, end, shards }` | Shard range owned by a cluster |
| `resolve(entityId)` | `{ shardId, clusterId }` | Which cluster and shard own an entity |
| `getStatus()` | `object[]` | Snapshot of every cluster |


### `IPCBroker`

In-process message broker for testing and single-process logical sharding.

```js
const { IPCBroker } = require("@dashboard-shared/core");

const broker = new IPCBroker();

// Register 4 virtual shards
for (let i = 0; i < 4; i++) {
  broker.registerShard(i, 4);
  broker.setContext(i, "users", (i + 1) * 100);
  broker.onMessage(i, "GET_USERS", ({ shardId }) => broker.getContext(shardId, "users"));
}

// Route to the shard that owns "user-abc"
const { shardId, result } = broker.route("user-abc", "GET_USERS");

// Fan out to all shards
const totals = broker.broadcastEval("ctx.users");

// Inspect what is registered
broker.inspect();
```

**Methods**

| Method | Description |
|---|---|
| `registerShard(id, total)` | Registers a virtual shard |
| `setContext(shardId, key, value)` | Sets a value in a shard's context |
| `getContext(shardId, key)` | Reads a value from a shard's context |
| `onMessage(shardId, type, handler)` | Registers a handler for a message type |
| `route(entityId, type, payload?)` | Routes a message to the owning shard |
| `broadcast(type, payload?)` | Fans a message to all shards |
| `broadcastEval(script)` | Evaluates an expression against every shard's context |
| `inspect()` | Returns metadata for all registered shards |


### `ShardRouter`

Pure routing utility. No processes spawned, no side effects.

```js
const { ShardRouter } = require("@dashboard-shared/core");

const router = new ShardRouter({
  totalShards: 8,
  totalClusters: 4,
  shardUrls: [
    "http://shard0.internal:3001",
    "http://shard1.internal:3002",
    // ...
  ],
});

// In an Express middleware
app.use((req, res, next) => {
  const info = router.resolve(req.user.id);

  if (!info.isLocal(Number(process.env.SHARD_ID))) {
    return res.redirect(307, info.redirectUrl + req.originalUrl);
  }

  req.shardInfo = info;
  next();
});

// See the full distribution
router.distribution();
// [
//   { clusterId: 0, shards: [0, 1] },
//   { clusterId: 1, shards: [2, 3] },
//   ...
// ]
```

**Constructor options**

| Option | Type | Default | Description |
|---|---|---|---|
| `totalShards` | number | required | Total shard count |
| `totalClusters` | number | `null` | Total cluster count (optional) |
| `shardUrls` | string[] | `null` | Base URL per shard index for redirect support |

**Methods**

| Method | Returns | Description |
|---|---|---|
| `resolve(entityId)` | `{ entityId, shardId, clusterId, redirectUrl, isLocal }` | Full routing metadata |
| `distribution()` | `{ clusterId, shards }[]` | Shard-to-cluster mapping table |


## Environment variables

When using `ShardManager` or `ClusterManager`, these variables are injected automatically into each child process:

| Variable | Set by | Description |
|---|---|---|
| `SHARD_ID` | ShardManager | Index of this shard |
| `TOTAL_SHARDS` | ShardManager / ClusterManager | Total shard count |
| `CLUSTER_ID` | ClusterManager | Index of this cluster |
| `TOTAL_CLUSTERS` | ClusterManager | Total cluster count |
| `SHARD_LIST` | ClusterManager | JSON array of shards assigned to this cluster |

`ShardClient` reads `SHARD_ID`, `TOTAL_SHARDS`, and `CLUSTER_ID` automatically in its constructor.


## License

MIT
# dashboard-shared