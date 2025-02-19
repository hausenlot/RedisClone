# **A Redis like App**
This is for AGS Platforms Final assessment that last for 120 Hours Spanning in 12 Business days

## **Introduction**
The objective is Quoting them:  

*"The goal is to create a key-value store that supports various data structures and core features similar to Redis"*

## **Full Specification of the Task**
**PS:** *Quoted specification are the things I did not finish*

1. **Core Keyvalue Store**
    - Design a clas for data storing using hash table or dictionary
    - Implement core Operations: **SET**, **GET**, **DEL** and **EXISTS**
2. **Comprehensive Data Types**
    - **Strings**
      - Implement basic Operations: **GET**, **SET**, **APPEND** and **STRLEN**
      - Add Incremental Operations: **INCR**, **DECR**, **INCRBY**, **DECRBY**
      - Implement substring Operations: **GETRANGE**, **SETRANGE**

    - **JSON (Similar to RedisJSON)**
      - Design Structure to store and Manipulate JSON Documents
      - Implement operations: **JSON.SET**, **JSON.GET**, **JSON.DEL**, > **JSON.ARRAPEND**
      - Add Support for JSONPath like Queries

    - **Lists**
      - Implement as dynamic arrays or linked lists
      - Add operations: **LPUSH**, **RPUSH**, **LPOP**, **RPOP**, **LRANGE**, **LINDEX**, **LSET**

    - **SETS**
      - Implement using hash tables for O(1) lookups
      - Add operations: **SADD**, **SREM**, **SISMEMBERS**, **SMEMBERS**, **SINTER**, **SUNION**, **SDIFF**
    
    - **HASHES**
      - Use nested hash tables for efficient field-value pair storage
      - Implement: **HSET**, **HGET**, **HMSET**, **HGETALL**, **HDEL**, **HEXISTS**

    - **SORTED SETS**
      - Implement using a balanced tree or skip list
      - Add operataions: **ZADD**, **ZRANGE**, **ZRANK**, **ZREM**, **ZRANGEBYSCORE**

    - **STREAMS**
      - Design append-only loglike data structure
      - Implement: **XADD**, **XREAD**, **XRANGE**, **XLEN**
      - Add consumer group support: **XGROUP CREATE**, **XREAPGROUP**, **XACK**
    
>    - **GEOSPATIAL**
>      - Implement geospatial indexing (consider using Geohash System)
>      - Add Commands: **GEOADD**, **GEOSEARCH**, **GEODIST**
      
>    - **BITMAPS**
>      - Implement bit-level operations on string
>      - Add Commands: **SETBIT**, **GETBIT**, **BITCOUNT**, **BITOP**

>    - **BITFIELDS**
>      - Allow efficient storage and manipulation of multiple counters in a single string
>      - Implement: **BITFIELD GET**, **BITFIELD SET**, **BITFIELD INCRBY**

>    - **Probablistic Data Structure**
>      - Implement HyperLogLog(?) for cardinality estimation
>      - Add Commands, **PFAD**, **PFCOUNT**, **PFMERGE**
>      - Consider Implementing Bloom Filters or Cuckoo filters
    
>    - **Time Series (similar to RedisTimeSeries Module)**
>      - Design structure for time series Data Storage
>      - Implement: **TS CREATE**, **TS ADD**, **TS RANGE**, **TS GET**
>      - Add support for downsampling and aggregation
3. **Key Expiration**
    - Associate expiration time with key-value pairs
    - Create background task to remove expired keys
    - Modify **GET** to check for expiration before returning value
4. **Server Functionality**
    - Build Server that listens for client connections
    - Degine protocol for client-server communication (Similar to RESP)
    - Parse incomming commands and route to appropriate functions
    - Send Responses back to clients
5. **Transactions**
    - Implement **MULTI** to begin a transaction
    - Queue commands received after **MULTI**
    - Execute queued commands atomically with **EXEC**
    - Provide **DISCARD** to clear command queue
6. **Publish/Subscribe (Pub/Sub) Mechanism**
    - Manage Pub/Sub channels and Subcribers
    - Implement **PUBLISH** to send messages to channel subsribers
    - Support **SUBSCRIBE** for clients to listen to channel messages
    - Build Message distribution system
7. **Persistence**
    - AppendOnly File (AOF): Log write operations. Implement replay on restart
    - PointinTime Snapshots: Periodically serialize dataset load on setup
8. **Replication**
    - Create Master and slave modes
    - Transfer data from master to slave on initial connection
    - Forward write operations from master to slave in real-time

9. **Client Development**
    - Develop Client class to connect to server
>    - Implement methods for all Supported server operations
>    - Include error handling and automatic reconnection logc

>10. **Vectore Database Functionality**
>    - Design data Structure for efficient vector storage
>    - Implement vectore indexing(e.g. HNSW or LSH) for fast similarity search
>    - Add similarity operations (K-nearest Neighbors)
>    - Support different distance metrics (Euclidean, Cosine similarity)
>    - Implement basic vector operations (Addition, Substraction, dot product)
>    - Design interface for integration with machine learning libraries

>11. **Document Database Capabilities**
>    - Design flexible schema for JSON-like document storage
>    - Implement indexing mechanisms for efficient document retrieval
>    - Create simpleq query language for document operations
>    - Add Support for partial updates, array operations and nested field access
>    - Implement a basic aggregation framework (count, sum, average)

>12. **Performance Optimization**
>    - Implement client-side caching with server assisted invalidation
>    - Add support for pipelining to reducee network round trips
>    - Optimize vector operations for high-dimensional data
>    - Implement efficient serialization/deserialization for document storage

13. **Security**
    - Add Support for Access Control Lists (ACL)
>    - Implement basic authentication mechanisms

14. **Advanced Features**
    - Add support for lua scripting for complex operations 
>    - Implement basic cluster mode using hash slots for data distribution
>    - Add support for geospatial indexing and querying
>    - Implement time series data structure with retention policies and aggregations

>15. **Monitoring and Mangement**
>    - Implement **INFO** command for server statistics
>    - Add **SLOWLOG** for identifiying and logging slow queuries
>    - Create simple monitoring interface for real-time server metrics

>16. **Testing and Benchmarking**
>    - Develop a comprehensive test suite for all components
>    - Implement benchmarking tools to measure performance
>    - Compare implementation with Redis for similar operations

17. **Keyspace Functionality**
     - Add support for key expiration and TTL commands (EXPIRE, TTL, ~~PERSIST~~)
>    - Design logical database structure using Redis keyspaces
>    - Implement commands for keyspace management (SELECT, FLUSHDB, RANDOMKEY)

>18. **Enhanced Clientside Caching**
>    - Implement server-assisted clientside caching mechanisms
>    - Add Support for cachee invalidation messages
>    - Implement tracking of clientside caches on server

>19. **Pipelining Optimization**
>    - Implement Pipelining mechanism to send multiple commands in single request
>    - Add support for handling pipelined responses efficiently
>    - Create clientside abstractions for easy pipelining usage

>20. **Keyspace Notifications**
>    - Design Pub/Sub system for keyspace events
>    - Add support for configurable notification types (string modifications, list operations, etc.)

>21. **Redis Pattern Implementation**
>    - Implement common Redis patterns like distributed locks
>    - Add support for rate limiting using Redis data structures
>    - Design and implement simple message queue systme
>    - Create Basic caching layer using Redis as backing store

## **Installation and Usage**
1. Clone the repository: 
```
git clone https://github.com/hausenlot/RedisClone.git
```
2. Make sure you have node.js Installed, in my case it was v20.18.1. To check yours: 
```
node -v
```
3. Go to root directory of the project:
```
cd RedisClone
```
4. Install dependencies (jsonpath and fengari-web):
```
npm install
```
5. To run the Server:
```
node redis-clone-server.js master 6379
```
Optional:  To run the slave servers (slave port is up to you):
```
node redis-clone-server.js slave 6380 locahost 6379
```
6. To run the client
```
node redis-clone-client.js secret
```
7. Basic Usage
- SET with EX Options set to 1 Hour
```
SET testKey "This is a Sample String value in a String key" EX 3600
```
- GET key to grab the previous key stored in RedisClone Class storage map
```
GET testKey
```
**I will Include the whole documentation here after my evaluation** 
Testing
