const fengariWeb = require('fengari-web');
const jsonpath = require('jsonpath');

class RedisClone {
  constructor() {
    // In memory Storage
    this.storage = new Map(); // In-memory storage using a Map
    this.expirations = new Map(); // Support for expiration
    // Transactions
    this.transactionMode = false; // Boolean for transac mode
    this.commandQueue = []; // Queue to store commands during MULTI/transac mode
    this.finishedCommand = [] // Storing the finished commands here so I can append it.
    // Consumer Group for STREAMS data Structure
    this.lastIds = new Map(); // Track last ID for each stream
    this.consumerGroups = new Map(); // Track consumer groups for streams
    // Publisher - Subsciber Feature
    this.channels = new Map(); // Set of subscribers
    this.clientSubscriptions = new Map(); // Set of subscribed channels
  }

  /* Lua interpreter */
  // TIL so what fengari does is initialize a VM of lua and convert the variables in a way js can read it then execute it via js methods in this class
  // 
  initLuaState() {
    console.log('Initializing Lua state with Fengari');
    const self = this; // to be honest I don't know which this. This initLuaState() or this REdisClone Class or the RedisClone Class initialized in the Server class?
    // globalThis.redisInstance I think this is just a naming convention "globalThis" this one though isnt but the "redisInstance" is definitely can be change
    // For real I don't exactly knows that this does but it looks like its the one exposing the method fromt RedisClone class
    globalThis.redisCloneInstance = {
        // Like this. Name of method and the parameters we pass on it
        set: (key, value) => {
            // Log received arguments
            console.log('SET received - key:', key, 'value:', value);
            console.log('SET received - key type:', typeof key, 'value type:', typeof value);

            // Convert to strings if necessary
            const stringKey = String(key);
            const stringValue = String(value);

            console.log('SET converted - key:', stringKey, 'value:', stringValue);
            // Then this is the actualy exposed endpoint in the RedisClone Class
            return self.set(stringKey, stringValue);
        },
        get: (key) => {
            // Log received arguments
            console.log('GET received - key:', key);
            console.log('GET received - key type:', typeof key);

            // Convert to string if necessary
            const stringKey = String(key);

            console.log('GET converted - key:', stringKey);
            return self.get(stringKey);
        },
    };
  }
  eval(script, keys = [], args = []) {
    console.log('Evaluating Lua script:', script);
    console.log('Keys:', keys, 'Args:', args);

    try {
        // Setup KEYS and ARGV with proper escaping
        const setupScript = `
            KEYS = {}
            ARGV = {}
            ${keys.map((key, i) => `KEYS[${i + 1}] = "${key}"`).join('\n')}
            ${args.map((arg, i) => `ARGV[${i + 1}] = "${arg}"`).join('\n')}
        `;

        // Define redis.call
        // So this is the one processing the redis.call command
        // redis then inside is the things i can use so maybe we can add more like instead of call uhh i think its fine with one
        // so inside call it will take the arguments we have in order set, key1 value1 the first one is the command for a switch case
        // the rest are stored as args then once everything is all good we can just call the js.global.redisCloneInstance.set
        // well regardless its just a basically formatting the command to be like a lua script?
        // The hardest part is this return js.global.redisCloneInstance.set(nil, k, v) because it was (k,v) at first then the only value that comes in redisCloneInstance
        // Is just the value the k is missing or rather thee first parameter is always gone soooo
        // The thing about js functions exported/exposed in lua is apparently lua follows a colon syntax. I don't what does it mean
        // So base on the Comment in stackoverflow. Gonna quote him
        // "All functions exported from JS to Lua follow colon syntax in Lua expressions (that is, they always have "self" argument). So, try display(nil,64)" -ESKri
        // My man here solved every Issue that I have even my hair line
        // in lua o:foo(x) so in this case its o.foo(0,x) so assuming that js.global.redisCloneInstance.set(k, v) becaming like that I should just put a nil at self argument
        // I don't understand lua and I'm not gonna pretend I know shit about it but this works on my case and in the case of the guy who asked that has the same problem as mine
        // sO i WILL TAKE IT. ITS A W
        const luaWrapper = `
            redis = {
                call = function(command, ...)
                    local args = {...}
                    if command == "SET" then
                        local k = tostring(args[1])
                        local v = tostring(args[2])
                        return js.global.redisCloneInstance.set(nil, k, v)
                    elseif command == "GET" then
                        local k = tostring(args[1])
                        return js.global.redisCloneInstance.get(nil, k)
                    else
                        error("Unsupported command: " .. command)
                    end
                end
            }
        `;
      
        // This is the big boy who compiles everything we need
        const fullScript = `
            ${setupScript}
            print("Lua KEYS[1]:", KEYS[1])
            print("Lua ARGV[1]:", ARGV[1])
            ${luaWrapper}
            ${script}
        `;

        console.log('Generated script:', fullScript);
        // My man doing all the lifting here. This FENGARI IS BADASS LUA VM and I absolutely no idea what it does in background
        // He might be cheating on his GF, planning a coup or being my girlfriend husband or whatever. Bottom like idk what it does
        const result = fengariWeb.load(fullScript)();
        return result;
    } catch (error) {
        console.error('Lua execution error:', error);
        throw error;
    }
  }

  /* Pub/Sub Mechanism */
  subscribe(clientId, ...channelNames) {
    // Initialize client's subscriptions if not exists
    if (!this.clientSubscriptions.has(clientId)) {
      this.clientSubscriptions.set(clientId, new Set());
    }

    for (const channel of channelNames) {
      // Initialize channel if not exists
      if (!this.channels.has(channel)) {
        this.channels.set(channel, new Set());
      }

      // Add client to channel subscribers
      this.channels.get(channel).add(clientId);
      // Add channel to client's subscriptions
      this.clientSubscriptions.get(clientId).add(channel);
    }
    console.log('After subscribe:');
    console.log('Channels:', this.channels);
    console.log('Client subscriptions:', this.clientSubscriptions);
    return this.clientSubscriptions.get(clientId).size;
  }
  unsubscribe(clientId, ...channelNames) {
    console.log('Attempting to unsubscribe clientId:', clientId);
    console.log('Current client subscriptions:', this.clientSubscriptions);
    console.log('Has client?', this.clientSubscriptions.has(clientId));
    console.log('Client type:', typeof clientId);
    console.log('Keys types:', Array.from(this.clientSubscriptions.keys()).map(k => typeof k));

    if (!this.clientSubscriptions.has(clientId)) {
      console.log('Client not found in subscriptions');
      return 0;
    }

    // If no channels specified, unsubscribe from all
    const channelsToUnsubscribe = channelNames.length > 0 
      ? channelNames 
      : Array.from(this.clientSubscriptions.get(clientId));

    for (const channel of channelsToUnsubscribe) {
      console.log("Inside for loop for channelsToUnsubscribe")
      if (this.channels.has(channel)) {
        // Remove client from channel subscribers
        this.channels.get(channel).delete(clientId);
        
        // Clean up empty channels
        if (this.channels.get(channel).size === 0) {
          this.channels.delete(channel);
        }
      }
      
      // Remove channel from client's subscriptions
      this.clientSubscriptions.get(clientId).delete(channel);
    }

    // Clean up if client has no more subscriptions
    if (this.clientSubscriptions.get(clientId).size === 0) {
      this.clientSubscriptions.delete(clientId);
      return 0;
    }
    return this.clientSubscriptions.get(clientId).size;
  }
  publish(channel, message) {
    if (!this.channels.has(channel)) {
      return 0;
    }

    const subscribers = this.channels.get(channel);
    const messageObject = {
      channel,
      message,
      timestamp: Date.now()
    };

    for (const clientId of subscribers) {
      this.deliverMessage(clientId, messageObject);
    }

    return subscribers.size;
  }
  deliverMessage(clientId, messageObject) {
    const subscribers = this.getSubscribers(messageObject.channel);
    console.log('Checking subscription for:', clientId);
    console.log('Current subscribers:', subscribers);
    if (!subscribers.has(clientId)) {
      console.log(`Skipping delivery: client ${clientId} is no longer subscribed.`);
      return;
    }
  
    console.log(`Delivering to client ${clientId}:`, messageObject);
    if (this.messageCallback) {
      this.messageCallback(clientId, messageObject);
    }
  }
  onMessage(callback) {
    this.messageCallback = callback;
  }
  getSubscribers(channel) {
    return this.channels.get(channel) || new Set();
  }
  getSubscriptions(clientId) {
    return this.clientSubscriptions.get(clientId) || new Set();
  }

  /* Helpers */
  startCleanup(interval = 1000) {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, expiration] of this.expirations.entries()) {
        if (now > expiration) {
          this.storage.delete(key);
          this.expirations.delete(key);
        }
      }
    }, interval);
  }
  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
  _createSortedSetEntry(score, member) {
    return {
      score: parseFloat(score),
      member: member,
      timestamp: Date.now() // For handling ties in score
    };
  }
  _generateStreamId() {
    const timestamp = Date.now();
    const sequence = (this.lastIds.get(timestamp) || 0) + 1;
    this.lastIds.set(timestamp, sequence);
    return `${timestamp}-${sequence}`;
  }
  _incrementStreamId(id) {
    const [timestamp, sequence] = id.split('-').map(Number);
    return `${timestamp}-${sequence + 1}`;
  }
  _compareStreamIds(id1, id2) {
    // console.log("Pure Parameters:", id1, id2) // the first one is the id from the arrow function the second one is the start parameter "1735398970937-1", "1735398970937-1"
    console.log(`We are comparing id1: ${id1} and id2: ${id2}`)
    const [ts1, seq1] = id1.split('-').map(Number); // [timestamp, sequence] it looks like this ["1735398970937", "1"]
    const [ts2, seq2] = id2.split('-').map(Number); // [timestamp, sequence] it looks like this ["1735398970937", "1"]
    console.log(`Right now we have 2 parameters id1: ${[ts1, seq1]} and id2: ${[ts2, seq2]}`);
    console.log(`First test is id1 timestamp: ${ts1} was not equal to ${ts2}? Answer: ${ts1 !== ts2}. If true we return ${ts1 - ts2} if false we return the difference of id1 and id2 sequence: Answer: ${seq1-seq2}`)
    // So in this part it will either return the difference of timestamp or seqeunce
    if (ts1 !== ts2) return ts1 - ts2;
    return seq1 - seq2;
  }
  _getLastStreamId(stream) {
    const entries = Array.from(stream.keys());
    return entries.length > 0 ? entries[entries.length - 1] : '0-0';
  }
  _runCommand(command, args) {
    switch (command) {
      case "SET":
        // Monitor this   then list the things that has bad interactions
        if (args.length > 2) {
          const exIndex = args.indexOf('EX')
          if (exIndex !== -1) {
            const options = {}
            options.ex = parseInt(args[exIndex + 1])
            return this.set(args[0], args.slice(1, exIndex), options) // If there's an expiration
          }
          const value = args.slice(1).join(' ')
          return this.set(args[0], value, {}); // If there's a space
        }
        return this.set(args[0], args[1], {}); // If there's not space
      case "GET":
        return this.get(args[0]);
      case "STRLEN":
        return this.strlen(args[0]);
      case "DEL":
        return this.del(...args);
      case "EXISTS":
        return this.exists(...args);
      case "FLUSHALL":
        return this.flushall();
      case "EXPIRE":
        return this.expire(args[0], parseInt(args[1]));
      case "INCR":
        return this.incr(args[0]);
      case "DECR":
        return this.decr(args[0]);
      case "INCRBY":
        return this.incrby(args[0], args[1]);
      case "DECRBY":
        return this.decrby(args[0], args[1]);
      case "APPEND":
        // Monitor this again
        const value = args.slice(1).join(' ')
        return this.append(args[0], value);
      case "GETRANGE":
        return this.getrange(args[0], args[1], args[2]);
      case "SETRANGE":
        // Monitor again
        if (args.length > 3) {
          return this.setrange(args[0], args[1], args.slice(2).join(' ')); // If there's a space
        }
        return this.setrange(args[0], args[1], args[2]); // If there's not space
      case "JSON.SET":
        return this.jsonSet(args[0], args[1], args[2]);
      case "JSON.GET":
        return this.jsonGet(args[0], args[1]);
      case "JSONPATH.GET":
        return this.jsonPathGet(args[0], args[1]);
      case "JSON.ARRAPPEND":
        return this.jsonArrAppend(args[0], args[1], args[2]);
      case "JSON.DEL":
        return this.jsonDel(args[0], args[1]);
      case "LPUSH":
        return this.lpush(args[0], ...args.slice(1));
      case "RPUSH":
        return this.rpush(args[0], ...args.slice(1));
      case "LPOP":
        if (args.indexOf('COUNT') >= 0) {
          const count = args[args.indexOf('COUNT') + 1]
          return this.lpop(args[0], count); // If there's a COUNT paremeter
        }
        return this.lpop(args[0]); // If there none
      case "RPOP":
        if (args.indexOf('COUNT') >= 0) {
          const count = args[args.indexOf('COUNT') + 1]
          return this.rpop(args[0], count); // If there's a COUNT paremeter
        }
        return this.rpop(args[0]); // If there none
      case "LRANGE":
        return this.lrange(args[0], args[1], args[2]);
      case "LINDEX":
        return this.lindex(args[0], args[1]);
      case "LSET":
        return this.lset(args[0], args[1], args[2]);
      case "SADD":
        return this.sadd(args[0], ...args.slice(1));
      case "SREM":
        return this.srem(args[0], ...args.slice(1));
      case "SISMEMBER":
        return this.sismember(args[0], args[1]);
      case "SMEMBERS":
        return this.smembers(args[0]);
      case "SINTER":
        return this.sinter(...args);
      case "SUNION":
        return this.sunion(...args);
      case "SDIFF":
        return this.sdiff(...args);
      case "HSET":
        return this.hset(args[0], ...args.slice(1));
      case "HGET":
        return this.hget(args[0], args[1]);
      case "HMSET":
        return this.hmset(args[0], ...args.slice(1));
      case "HGETALL":
        return this.hgetall(args[0]);
      case "HDEL":
        return this.hdel(args[0], ...args.slice(1));
      case "HEXISTS":
        return this.hexists(args[0], args[1]);
      case "ZADD":
        return this.zadd(args[0], ...args.slice(1));
      case "ZRANGE":
        return this.zrange(args[0], args[1], args[2], args[3] === "WITHSCORES");
      case "ZRANK":
        return this.zrank(args[0], args[1]);
      case "ZREM":
        return this.zrem(args[0], ...args.slice(1));
      case "ZRANGEBYSCORE":
        return this.zrangebyscore(args[0], args[1], args[2], args[3] === "WITHSCORES");
      case "XADD":
        return this.xadd(args[0], args[1], ...args.slice(2));
      case "XLEN":
        return this.xlen(args[0]);
      case "XRANGE":
        return this.xrange(args[0], args[1], args[2], args[3]);
      case "XREAD":
        const options = {};
        let streamArgs = args;
        if (args[0].toUpperCase() === 'COUNT') {
          options.count = parseInt(args[1]);
          streamArgs = args.slice(2);
        }
        return this.xread(options, streamArgs);
      case "XGROUPCREATE": // I know its XGROUP then CREATE, CREATE is a sub command but fuck it ITS NOT LIKE ILL ADD MORE
        return this.xgroupCreate(args[0], args[1], args[2]);
      case "XREADGROUP":
        const groupOptions = {};
        const optionsArray = args.slice(args.indexOf('COUNT'), args.indexOf('STREAM'))
        const streamsArray = args.slice(args.indexOf('STREAMS') + 1, args.length)
        groupOptions.count = optionsArray[0]
        return this.xreadgroup(args[0], args[1], groupOptions, streamsArray)
      case "XACK":
        return this.xack(args[0], args[1], ...args.slice(2));
      default:
        throw new Error(`Unknown command '${command}'`);
    }
  }

  /* DATE TYPES*/
  // STRINGS
  set(key, value, options = {}) {
    console.log("Set Parameters: ", key, value, options = {})
    this.storage.set(key, value);

    // Handle expiration if provided ** I dont' have PX in persistence as of now so yea
    if (options.ex || options.px) {
      const expiresAt = Date.now() + 
        (options.ex ? options.ex * 1000 : options.px);
      this.expirations.set(key, expiresAt);
    }
    return 'OK';
  }
  append(key, value) {
    console.log("APPEND Parameters: ", key, value)
    const currentValue = this.get(key) || ""; // Use an empty string if the key doesn't exist
    if (typeof currentValue !== "string") {
      throw new Error("ERR value is not a string");
    }
    const newValue = currentValue + value;
    this.set(key, newValue);
    return newValue.length;
  }
  incr(key) {
    console.log("INCR parameters: ", key)
    const currentValue = this.get(key);
    const numValue = currentValue === null ? 0 : Number(currentValue);
    
    if (isNaN(numValue)) {
      throw new Error('ERR value is not an integer or out of range');
    }
    
    const newValue = numValue + 1;
    this.set(key, newValue);
    return newValue;
  }
  decr(key) {
    console.log("DECR parameters: ", key)
    const currentValue = this.get(key);
    const numValue = currentValue === null ? 0 : Number(currentValue);
    
    if (isNaN(numValue)) {
      throw new Error('ERR value is not an integer or out of range');
    }
    
    const newValue = numValue - 1;
    this.set(key, newValue);
    return newValue;
  }
  incrby(key, increment) {
    console.log("INCRBY parameters: ", key, increment)
    const currentValue = this.get(key) || 0;
    const numValue = Number(currentValue);
    if (isNaN(numValue)) {
      throw new Error("ERR value is not an integer or out of range");
    }
    const newValue = numValue + Number(increment);
    this.set(key, newValue);
    return newValue;
  }
  decrby(key, increment) {
    console.log("DECRBY parameters: ", key, increment)
    const currentValue = this.get(key) || 0;
    const numValue = Number(currentValue);
    if (isNaN(numValue)) {
      throw new Error("ERR value is not an integer or out of range");
    }
    const newValue = numValue - Number(increment);
    this.set(key, newValue);
    return newValue;
  }
  setrange(key, offset, value){
    console.log("SETRANGE parameters: ", key, offset, value)
    const currentValue = this.get(key)
    if (typeof currentValue !== "string" || null ) {
      return ("ERR value is not a string or it already expired");
    }
    // padEnd takes 2 arguments, targetLength and padString
    // if the currentValue for example has 10 charaLength and the targetLenght is 9 it will not add a padString e.g dachshunds
    // if its over charaLength then it will add a padString e.g dachshunds++++
    const paddedValue = currentValue.padEnd(Number(offset), "\0"); 
    // console.log(paddedValue)
    // we basically slicing from the start to the offset and adding the value
    // then we add the offset to the end
    // if we edit a character inside a string e.g "Deck"
    // offset value is 1 (its an array) we want to change e to u so the value is u
    // in newValue we slice the string to start to offset in this case is 0 to 1 [D,E,C,K] its out if D then add the value now its DU
    // then we add the next part which is 1 + 1. that's offset + value's chara lenght so we slice the string starting to 2 [D,E,C,K] that's ck we didnt say the range so its automatically going till the end
    // console.log(paddedValue.slice(0, Number(offset)) + value)
    // console.log(paddedValue.slice(Number(offset) + value.length))
    const newValue = paddedValue.slice(0, Number(offset)) + value + paddedValue.slice(Number(offset) + value.length);
    // console.log(newValue)
    this.set(key, newValue);
    return newValue.length;
  }
  strlen(key) {
    console.log("STRLEN parameters:", key )
    const value = this.get(key);
    if (value === null) return 0; // Key doesn't exist
    if (typeof value !== "string") {
      throw new Error("ERR value is not a string");
    }
    return value.length;
  }
  getrange(key, start, end) {
    console.log(key, start, end)
    const value = this.get(key);
    if (value === null) return ""; // Key doesn't exist
    if (typeof value !== "string") {
      throw new Error("ERR value is not a string");
    }
    return value.slice(Number(start), Number(end) + 1); // take care on this +1 
  }

  // JSONs (Complicated)
  jsonSet(key, path, value) {
    console.log("JSON.SET parameters: ", key, path, value)
    let jsonValue = this.get(key) || {};
    
    // Parse string JSON if needed
    if (typeof jsonValue === 'string') {
      try {
        jsonValue = JSON.parse(jsonValue);
      } catch (error) {
        jsonValue = {};
      }
    }
  
    // Parse value if it's a JSON string
    if (typeof value === 'string' && 
        (value.startsWith('{') || value.startsWith('[')) &&
        (value.endsWith('}') || value.endsWith(']'))) {
      try {
        value = JSON.parse(value);
      } catch (error) {
        console.error('Error parsing JSON value:', error);
      }
    }
  
    if (typeof jsonValue !== "object") {
      throw new Error("ERR value is not a valid JSON object");
    }
  
    // Handle root path
    if (path === "." || path === "$") {
      jsonValue = value;
    } else {
      // Use jsonpath to find the parent node
      const parentPath = path.substring(0, path.lastIndexOf('.'));
      const fieldName = path.substring(path.lastIndexOf('.') + 1);
      
      // Handle array access in the final field
      const arrayMatch = fieldName.match(/^([^\[]+)\[(\d+)\]$/);
      if (arrayMatch) {
        const [_, arrayField, index] = arrayMatch;
        const parent = jsonpath.value(jsonValue, parentPath);
        if (!parent[arrayField]) parent[arrayField] = [];
        parent[arrayField][parseInt(index)] = value;
      } else {
        // Regular field assignment
        const parent = jsonpath.value(jsonValue, parentPath);
        if (parent) {
          parent[fieldName] = value;
        }
      }
    }
    console.log("JSON.SET Value: ", jsonValue)
    this.set(key, jsonValue);
    return 'OK';
  }
  jsonArrAppend(key, path, value) {
    console.log("JSON.ARRAPPPEND parameters: ", key, path, value)
    const jsonValue = this.jsonGet(key, path); // This one is much robust.
    console.log("It looks like this: ",jsonValue)
    if (!Array.isArray(jsonValue)) {
      throw new Error("ERR target is not an array");
    }
    
    // I'm not sure if the jsonValue will have how many arrays inside. I just need it to be 1 array so here we go.
    const flattenArray = jsonValue.flat(Infinity)
    console.log("I tried flatenning it: ", flattenArray)
    console.log("I neeed to this inside: ", value)
    flattenArray.push(value)
    console.log("I pushed it inside: ", flattenArray)
    console.log("I will put it in here: ", path)
    console.log("The value that I will pass on jsonSet: ", flattenArray)
    console.log("JSON.ARRAPPEND value: ", flattenArray)
    this.jsonSet(key, path, flattenArray)
    return jsonValue.length;
  }
  jsonDel(key, path = ".") {
    // defauit is root
    console.log("JSON.DEL parameters: ", key, path)
    let jsonValue = this.get(key);
  
    if (typeof jsonValue !== "object") {
      throw new Error("ERR value is not a valid JSON object");
    }
  
    if (path === "." || path === "$") {
      this.del(key); // Delete the entire key
      return 1;
    }
  
    // Find all matching paths for the given JSONPath

    const nodes = jsonpath.nodes(jsonValue, path);
  
    if (!nodes.length) {
      return 0; // No matching path
    }
  
    // Delete the matching paths
    nodes.forEach(({ path: jsonPath }) => {
      const fieldToDelete = jsonPath.pop(); // Get the last element in the path
      const parent = jsonpath.value(jsonValue, jsonPath); // Get the parent object/array
  
      if (Array.isArray(parent)) {
        parent.splice(fieldToDelete, 1); // Remove array element
      } else {
        delete parent[fieldToDelete]; // Remove object field
      }
    });
  
    this.set(key, jsonValue); // Update the JSON after deletion
    return nodes.length; // Return the number of deleted elements
  }
  jsonGet(key, query) {
    console.log("JSON.GET parameters: ", key, query)
    const jsonValue = this.get(key);
    console.log("Raw jsonValue value from storage:", jsonValue)
    if (typeof jsonValue !== "object") {
      throw new Error("ERR value is not a valid JSON object");
    }

    // Use jsonpath to query the JSON value
    // This thing returns an array :/
    const result = jsonpath.query(jsonValue, query);
    // We ball and get the first result hahaha
    return result.length ? result[0] : null;
  }
  // LISTS
  lpush(key, ...values) {
    console.log("LPUSH parameters: ", key, values)
    // The values here is accepting indefinite number of values and will group them in array called value
    let list = this.get(key);
    if (list === null) {
      list = [];
    } else if (!Array.isArray(list)) {
      throw new Error('ERR value is not a list');
    }
    
    // reverse the order of the array
    values.reverse()
    // makes a space at the beginning of array then unpack the values(this is an array) to the list
    list.unshift(...values);
    this.set(key, list);
    return list.length;
  }
  rpush(key, ...values) {
    console.log("RPUSH parameters: ", key, values)
    let list = this.get(key);
    if (list === null) {
      list = [];
    } else if (!Array.isArray(list)) {
      throw new Error('ERR value is not a list');
    }
    
    list.push(...values);
    this.set(key, list);
    return list.length;
  }
  lpop(key, count = 1) {
    console.log("LPOP parameters: ", key, count)
    const list = this.get(key);
    if (list === null) return null;
    if (!Array.isArray(list)) {
      throw new Error('ERR value is not a list');
    }
    
    if (list.length === 0) return null;
    
    count = parseInt(count);
    if (count <= 0) return null;
    
    // Adjust count to the maximum possible
    count = Math.min(count, list.length);
    
    if (count === 1) {
      const value = list.shift();
      this.set(key, list);
      return value;
    }

    const values = list.splice(0, count);
    console.log("Value of List: ", list)
    this.set(key, list);
    return values;
  }
  rpop(key, count = 1) {
    console.log("RPOP parameters: ", key, count)
    const list = this.get(key);
    console.log("Initial value: ", list)
    if (list === null) return null;
    if (!Array.isArray(list)) {
      throw new Error('ERR value is not a list');
    }
    
    if (list.length === 0) return null;
    
    count = parseInt(count);
    if (count <= 0) return null;
    
    // Adjust count to the maximum possible
    count = Math.min(count, list.length);
    
    if (count === 1) {
      const value = list.pop();
      console.log("Final value: ", list)
      this.set(key, list);
      return value;
    }
    
    const values = list.splice(-count); // Removes the last `count` elements
    console.log("Value of List: ", list)
    this.set(key, list);
    return values;
  }
  lset(key, index, value) {
    console.log("LSET parameters: ", key, index, value)
    const list = this.get(key);
    if (list === null || !Array.isArray(list)) {
      throw new Error('ERR no such key or not a list');
    }

    // Handle negative index
    index = parseInt(index);
    if (index < 0) index = list.length + index;

    if (index < 0 || index >= list.length) {
      throw new Error('ERR index out of range');
    }

    list[index] = value;
    console.log("Current list: ", list)
    this.set(key, list);
    return 'OK';
  }
  lrange(key, start, end) {
    console.log("lrange parameters: ", key, start, end)
    const list = this.get(key);
    if (list === null) return [];
    if (!Array.isArray(list)) {
      throw new Error('ERR value is not a list');
    }

    // Convert to numbers and handle negative indices
    start = parseInt(start);
    end = parseInt(end);
    if (start < 0) start = list.length + start;
    if (end < 0) end = list.length + end;
    
    // Ensure bounds
    start = Math.max(0, start);
    end = Math.min(list.length - 1, end);
    
    return list.slice(start, end + 1);
  }
  lindex(key, index) {
    console.log("LINDEX parameters: ", key, index)
    const list = this.get(key);
    if (list === null) return null;
    if (!Array.isArray(list)) {
      throw new Error('ERR value is not a list');
    }

    // Handle negative index
    index = parseInt(index);
    if (index < 0) index = list.length + index;
    
    return list[index] !== undefined ? list[index] : null;
  }
  // SETS (Complicated)
  sadd(key, ...members) {
    console.log("SADD parameters: ", key, members)
    let set = this.get(key);
    if (set === null) {
      set = new Set();
    } else if (!(set instanceof Set)) {
      throw new Error('ERR value is not a set');
    }

    let addedCount = 0;
    for (const member of members) {
      if (!set.has(member)) {
        set.add(member);
        addedCount++;
      }
    }
    console.log("Current Set: ", set)
    this.storage.set(key, set);
    return addedCount;
  }
  srem(key, ...members) {
    console.log("SADD parameters: ", key, members)
    const set = this.get(key);
    if (set === null) return 0;
    if (!(set instanceof Set)) {
      throw new Error('ERR value is not a set');
    }

    let removedCount = 0;
    for (const member of members) {
      if (set.has(member)) {
        set.delete(member);
        removedCount++;
      }
    }
    console.log("Current Set: ", set)
    this.storage.set(key, set);
    return removedCount;
  }
  sismember(key, member) {
    console.log("SISMBER parameters: ", key, member)
    const set = this.get(key);
    if (set === null) return 0;
    if (!(set instanceof Set)) {
      throw new Error('ERR value is not a set');
    }

    return set.has(member) ? 1 : 0;
  }
  smembers(key) {
    console.log("SMEMBERS parameters: ", key)
    const set = this.get(key);
    if (set === null) return [];
    if (!(set instanceof Set)) {
      throw new Error('ERR value is not a set');
    }

    return Array.from(set);
  }
  sinter(...keys) {
    console.log("SINTER parameters: ". keys)
    if (keys.length === 0) return [];

    const sets = keys.map(key => {
      const set = this.get(key);
      if (set === null) return new Set();
      if (!(set instanceof Set)) {
        throw new Error('ERR value is not a set');
      }
      return set;
    });

    if (sets.length === 0) return [];

    // Start with the first set and intersect with others
    const result = new Set(sets[0]);
    // Just loop it the set first so we can get its things we start at 1 since 0 is inside results already
    for (let i = 1; i < sets.length; i++) {
      console.log("Set Loop, Current Set: ", sets)
      // Now were inside the sets let's take a look in items inside it
      for (const item of result) {
        console.log("Inside Result: ", result)
        console.log("Item:", item)
        // We just need to use .has to find the item within the set
        if (!sets[i].has(item)) {
          result.delete(item);
        }
      }
    }
    console.log("Current Set: ", result)
    return Array.from(result);
  }
  sunion(...keys) {
    console.log("SUNION Parameters: ", keys)
    const result = new Set();

    // iterate the keys
    for (const key of keys) {
      // query it
      const set = this.get(key);
      if (set === null) continue;
      if (!(set instanceof Set)) {
        throw new Error('ERR value is not a set');
      }
      // for every item inside the set put it isnide the result
      for (const item of set) {
        result.add(item);
      }
    }
    console.log("Current set:", result)
    return Array.from(result);
  }
  sdiff(...keys) {
    console.log("SDIFF parameters: ", keys)
    if (keys.length === 0) return [];
    const firstSet = this.get(keys[0]);

    if (firstSet === null) return [];
    if (!(firstSet instanceof Set)) {
      throw new Error('ERR value is not a set');
    }

    // Set the first set right away
    const result = new Set(firstSet);

    // Now start the loop start at 1 instead of 0
    for (let i = 1; i < keys.length; i++) {
      // query it
      const set = this.get(keys[i]);
      if (set === null) continue;
      if (!(set instanceof Set)) {
        throw new Error('ERR value is not a set');
      }
      // loop through the set
      for (const item of set) {
        // So the idea is to delete the matching item in result
        result.delete(item);
      }
    }
    console.log("Current set:", result)
    return Array.from(result);
  }
  // HASHES (Complicated)
  hset(key, ...fieldValues) {
    console.log("HSET Parameters: ", key, fieldValues)
    if (fieldValues.length % 2 !== 0) {
      throw new Error('ERR wrong number of arguments for HSET');
    }

    let hash = this.get(key);
    if (hash === null) {
      hash = {};
    } else if (typeof hash !== 'object' || Array.isArray(hash)) {
      throw new Error('ERR value is not a hash');
    }

    let fieldsSet = 0;
    // If the field does not exist within the hash it will be added.
    for (let i = 0; i < fieldValues.length; i += 2) {
      const field = fieldValues[i];
      const value = fieldValues[i + 1];
      if (!(field in hash)) {
        fieldsSet++;
      }
      hash[field] = value;
    }

    console.log("Current has: ", hash)
    this.set(key, hash);
    return fieldsSet;
  }
  hmset(key, ...fieldValues) {
    console.log("HMSET Parameters: ", key, fieldValues)
    if (fieldValues.length % 2 !== 0) {
      throw new Error('ERR wrong number of arguments for HMSET');
    }
    
    let hash = this.get(key);

    if (hash === null) {
      hash = {};
    } else if (typeof hash !== 'object' || Array.isArray(hash)) {
      throw new Error('ERR value is not a hash');
    }

    for (let i = 0; i < fieldValues.length; i += 2) {
      const field = fieldValues[i];
      const value = fieldValues[i + 1];
      hash[field] = value;
    }
    console.log("Current has: ", hash)
    this.set(key, hash);
    return 'OK';
  }
  hdel(key, ...fields) {
    console.log("HDEL Parameters: ", key, fields)
    const hash = this.get(key);
    if (hash === null) return 0;
    if (typeof hash !== 'object' || Array.isArray(hash)) {
      throw new Error('ERR value is not a hash');
    }

    let deletedCount = 0;
    for (const field of fields) {
      if (field in hash) {
        delete hash[field];
        deletedCount++;
      }
    }
    console.log("Current has: ", hash)
    this.set(key, hash);
    return deletedCount;
  }
  hget(key, field) {
    console.log("HGET Parameters: ", key, field)
    const hash = this.get(key);
    if (hash === null) return null;
    if (typeof hash !== 'object' || Array.isArray(hash)) {
      throw new Error('ERR value is not a hash');
    }

    return hash[field] || null;
  }
  hgetall(key) {
    console.log("HGETALL Parameters: ", key)
    const hash = this.get(key);
    if (hash === null) return {};
    if (typeof hash !== 'object' || Array.isArray(hash)) {
      throw new Error('ERR value is not a hash');
    }

    return hash;
  }
  hexists(key, field) {
    console.log("HEXISTS Parameters: ", key, field)
    const hash = this.get(key);
    if (hash === null) return 0;
    if (typeof hash !== 'object' || Array.isArray(hash)) {
      throw new Error('ERR value is not a hash');
    }

    return field in hash ? 1 : 0;
  }
  // SORTED SETS (Complicated)
  zadd(key, ...scoreMembers) {
    console.log("ZADD parameters: ", key, scoreMembers)
    if (scoreMembers.length % 2 !== 0) {
      throw new Error('ERR wrong number of arguments for ZADD');
    }

    let zset = this.get(key);
    if (zset === null) {
      zset = [];
    } else if (!Array.isArray(zset)) {
      throw new Error('ERR value is not a sorted set');
    }

    let added = 0;
    // Building the object and the zset array
    for (let i = 0; i < scoreMembers.length; i += 2) {
      const score = parseFloat(scoreMembers[i]);
      const member = scoreMembers[i + 1];

      if (isNaN(score)) {
        throw new Error('ERR score is not a valid float');
      }

      // Check if member already exists
      const existingIndex = zset.findIndex(entry => entry.member === member);
      
      // It creates and object then store in array
      if (existingIndex === -1) {
        // Add new member
        zset.push(this._createSortedSetEntry(score, member));
        added++;
      } else {
        // Update existing member's score
        zset[existingIndex].score = score;
      }
    }
    console.log("unsorted zset: ", zset)
    // Sort the set by score, then by timestamp for equal scores
    // I dont exactly know how it works but i think
    /* zset = [
      { score: 20, member: 'item1', timestamp: 1735933491411 },
      { score: 80, member: 'item2', timestamp: 1735933491411 },
      { score: 10, member: 'item3', timestamp: 1735933491411 }
    ]
      item1 < item2, then move again item2 < item3 then move again
      item3 < item1 and so on
      With that pattern is checks it every time within the array if the statement is true
    */
    zset.sort((a, b) => {
      if (a.score !== b.score) {
        return a.score - b.score;
      }
      return a.timestamp - b.timestamp;
    });

    console.log("Current set: ", zset)
    this.set(key, zset);
    return added;
  }
  zrem(key, ...members) {
    console.log("ZREM parameters: ", key, members)
    const zset = this.get(key);
    if (zset === null) return 0;
    if (!Array.isArray(zset)) {
      throw new Error('ERR value is not a sorted set');
    }

    let removed = 0;
    // It basically iteration every record in array and store it on entry
    // so now we can now use the members.includes then if it returns true it will get filtered out
    const newZset = zset.filter(entry => {
      if (members.includes(entry.member)) {
        removed++;
        return false;
      }
      return true;
    });

    if (removed > 0) {
      this.set(key, newZset);
    }
    console.log("Current set: ", newZset)
    return removed;
  }
  zrange(key, start, stop, withScores = false) {
    console.log("ZRANGE parameters: ", key, start, stop, withScores)
    const zset = this.get(key);
    if (zset === null) return [];
    if (!Array.isArray(zset)) {
      throw new Error('ERR value is not a sorted set');
    }

    // Convert string parameters to numbers and handle negative indices
    start = parseInt(start);
    stop = parseInt(stop);
    
    if (start < 0) start = zset.length + start;
    if (stop < 0) stop = zset.length + stop;

    // Ensure bounds
    start = Math.max(0, start);
    stop = Math.min(zset.length - 1, stop);

    // Get the range
    const result = zset.slice(start, stop + 1);

    // Return with or without scores
    if (withScores) {
      return result.map(entry => [entry.member, entry.score]);
    }
    return result.map(entry => entry.member);
  }
  zrank(key, member, withScores = false) {
    console.log("ZRANK parameters: ", key, member, withScores)
    const zset = this.get(key);
    console.log(zset)
    if (zset === null) return null;
    if (!Array.isArray(zset)) {
      throw new Error('ERR value is not a sorted set');
    }

    const index = zset.findIndex(entry => entry.member === member);

    if (withScores) {
      const score = zset[index].score

      return index === -1 ? null : `${index}, ${score}`;
    } 

    return index === -1 ? null : index;
  }
  zrangebyscore(key, min, max, withScores = false) {
    console.log("ZRANGEBYSCORE parameters: ", key, min, max, withScores)
    const zset = this.get(key);
    if (zset === null) return [];
    if (!Array.isArray(zset)) {
      throw new Error('ERR value is not a sorted set');
    }

    // Handle infinity values
    min = min === '-inf' ? -Infinity : parseFloat(min);
    max = max === '+inf' ? Infinity : parseFloat(max);

    if (isNaN(min) || isNaN(max)) {
      throw new Error('ERR min or max is not a float');
    }

    // Filter entries within score range
    // does t he same thing in zrem
    const result = zset.filter(entry => 
      entry.score >= min && entry.score <= max
    );

    // Return with or without scores
    if (withScores) {
      return result.map(entry => [entry.member, entry.score]);
    }
    return result.map(entry => entry.member);
  }
  // STREAMS (Complicated)
  xadd(key, id, ...fieldValues) {
    console.log("XADD parameters ", key, id, ...fieldValues)
    // Checks if the fieldValues are a pair
    if (fieldValues.length % 2 !== 0) {
      throw new Error('ERR wrong number of arguments for XADD');
    }

    // assign an existing stream
    let stream = this.get(key);
    // if there's no stream make one and if there is checks if its a map
    if (stream === null) {
      stream = new Map(); // Use Map to maintain insertion order
    } else if (!(stream instanceof Map)) {
      throw new Error('ERR value is not a stream');
    }

    // If the id is not assigned generates one if is assigned then use it
    const entryId = id === '*' ? this._generateStreamId() : id;
    // format is timestap-id (123456789-0[++])
    if (!entryId.match(/^\d+-\d+$/)) {
      throw new Error('ERR invalid stream ID format');
    }

    // Create entry object, since its a pair we can abuse it by 0 : 0 + 1 then next iteration if there is 0+2 to skip the first and second entry
    const entry = {};
    for (let i = 0; i < fieldValues.length; i += 2) {
      entry[fieldValues[i]] = fieldValues[i + 1];
    }

    // Add entry to stream map we just create new Map().set(entryId, entry)
    stream.set(entryId, entry);
    // Map it in the storage map for redis
    console.log("Current stream: ", stream)
    this.set(key, stream);
    console.log("Current Stored Stream:", this.get(key))
    // return timestap-id or the id you assigned
    return entryId;
  }
  xlen(key) {
    console.log("XLEN parameters ", key)
    const stream = this.get(key);
    if (stream === null) return 0;
    if (!(stream instanceof Map)) {
      throw new Error('ERR value is not a stream');
    }
    // Returns the number of streams/object inside the key
    return stream.size;
  }
  xrange(key, start = '-', end = '+', count = null) {
    console.log(`Paremeter I have: Key: ${key}, Start: ${start}, End: ${end}, Count: ${count}`)
    const stream = this.get(key);
    if (stream === null) return [];
    if (!(stream instanceof Map)) {
      throw new Error('ERR value is not a stream');
    }

    const entries = Array.from(stream.entries());
    let filtered = entries;
    // console.log("Pure filtered: ", filtered)
    // Filter by range, - + in redis its minimum maximum respectively
    // If both of these are false will use the original stated above
    if (start !== '-') {
      // the value of this this._compareStreamIds(id, start) >= 0 is boolean
      // so this expression filtered = filtered.filter(([id]) => this._compareStreamIds(id, start) >= 0); filtes the id base on the result of the arrow function (true or false)
      filtered = filtered.filter(([id]) => this._compareStreamIds(id, start) >= 0);
      // filtered = filtered.filter(([id]) => console.log("The value is", this._compareStreamIds(id, start), "This statement is:", this._compareStreamIds(id, start) >=0));
    }
    if (end !== '+') {
      filtered = filtered.filter(([id]) => this._compareStreamIds(id, end) <=0);
    }

    // Apply count limit if specified
    if (count !== null) {
      filtered = filtered.slice(0, parseInt(count));
    }

    // Format output as object
    const result = filtered.map(([id, fields]) => {
      console.log('Processing id:', id);
      console.log('Fields:', fields);
      console.log('Object.entries(fields):', Object.entries(fields));
      
      return {
        id,
        fields: Object.entries(fields)
      };
    });
    console.log("Stored it in a variable: ", result)
    return filtered.map(([id, fields]) => ({
      id,
      fields: Object.entries(fields).flat()
    }));
  }
  xread(options = {}, streams = []) {
    console.log("Inside XREAD method, Paremeters: ", "Options: ", options, "Streams: ", streams)
    if (streams.length % 2 !== 0) {
      throw new Error('ERR wrong number of arguments for XREAD');
    }

    const result = [];
    for (let i = 0; i < streams.length; i += 2) {
      const key = streams[i]; // 0, 2, 4, 6, ...
      const lastId = streams[i + 1]; // 1, 3, 5, 7, ...
      console.log("Current key: ", key)
      console.log("Current lastID: ", lastId)
      
      const stream = this.get(key);
      console.log("stream base on get method: ", stream)
      if (stream === null) continue;
      if (!(stream instanceof Map)) {
        throw new Error('ERR value is not a stream');
      }

      // Will look up like this key, timestamp-sequence greater than the lastId, + (everything that's greater than it), count
      const entries = this.xrange(key, `${this._incrementStreamId(lastId)}`, '+', options.count);
      console.log("Current entry: ", entries)
      if (entries.length > 0) {
        result.push({
          name: key,
          entries
        });
      }
    }
    return result;
  }
  xgroupCreate(key, groupName, id = '$') {
    // Get key where we stored the stream
    const stream = this.get(key);
    console.log(key, groupName, id)
    console.log("Testing persistence: ", stream)
    if (stream === null || !(stream instanceof Map)) {
      throw new Error('ERR stream does not exist');
    }

    // If the a key does not exist then make one
    if (!this.consumerGroups.has(key)) {
      console.log("I didn't saw this key in my map so I'll make one")
      this.consumerGroups.set(key, new Map()); // look like this Map(1) { 'mystream' => Map(0) {} } 
      console.log("Here is the whole map looks now: ", this.consumerGroups)
    }

    // assigned the map in something
    const streamGroups = this.consumerGroups.get(key);
    // Check if the group exist within that key
    if (streamGroups.has(groupName)) {
      throw new Error('ERR group already exists');
    }

    // Initialize group
    streamGroups.set(groupName, {
      lastDeliveredId: id === '$' ? this._getLastStreamId(stream) : id,
      consumers: new Map(),
      pending: new Map(),
      deliveredMessages: new Set() // Track which messages have been delivered to any consumer
    });

    console.log("Now it looks like this:")
    console.log(this.consumerGroups)

    // This is how it look on this.consumerGroup
    // Map(1) {                                 << This is the this.consumerGroup // The whole map
    //   'mystream' => Map(1) {                 << This is the this.consumerGroup.get(key) // An entry inside the whole map
    //     'myGroup' => {                       << This is the this.consumerGroup.get(key).get(group) // An entry inside an entry of the whole map
    //       lastDeliveredId: '1735509085682-1',
    //       consumers: Map(0) {},
    //       pending: Map(0) {},
    //       deliveredMessages: Set(0) {}
    //     }
    //   }
    // }
    return 'OK';
  }
  xreadgroup(group, consumer, options = {}, streams = []) {
    console.log("XREADGROUP PARAMETERS: ", group, consumer, options, streams)
    if (streams.length % 2 !== 0) {
      throw new Error('ERR wrong number of arguments for XREADGROUP');
    }

    const result = [];
    for (let i = 0; i < streams.length; i += 2) {
      const key = streams[i];
      const id = streams[i + 1];

      const stream = this.get(key);
      if (stream === null || !(stream instanceof Map)) {
        throw new Error('ERR stream does not exist');
      }
      console.log("Current consumerGroups", this.consumerGroups)
      const streamGroups = this.consumerGroups.get(key);
      if (!streamGroups || !streamGroups.has(group)) {
        throw new Error('ERR group does not exist');
      }

      const groupData = streamGroups.get(group);
      console.log("This is the group:", groupData)

      let entries;
      if (id === '>') {
        // For the first read, we want all undelivered messages
        const startId = groupData.lastDeliveredId === this._getLastStreamId(stream) ? 
          '0-0' : // If we haven't read any messages yet, start from beginning
          groupData.lastDeliveredId; // Otherwise, start after last delivered
        
        // Get all messages after startId
        console.log("Parameter check:", key, startId, '+', options.count)
        entries = this.xrange(key, startId, '+', options.count);
        console.log("Newly assgined entries: ", entries)
        // Filter out messages that have already been delivered to this group
        entries = entries.filter(entry => !groupData.deliveredMessages.has(entry.id));
        
        // Update last delivered ID and mark messages as delivered
        if (entries.length > 0) {
          groupData.lastDeliveredId = entries[entries.length - 1].id;
          entries.forEach(entry => {
            groupData.deliveredMessages.add(entry.id);
          });
        }
        console.log("Group data now: ", groupData)
      } else {
        // FUCK THIS I ONLY SUPPORT SPECIAL ID > THIS IS TOO MUCH I AM AIMING FOR FULL STACK NOT SOFTWARE ENGINEER
        throw new Error('ERR specific IDs are not supported. MY HEAD IS ABOUT TO BURSTS SEND HELP'); 
      }
      console.log("Entry Array:", entries)
      // Add to pending entries
      entries.forEach(entry => {
        groupData.pending.set(entry.id, {
          consumer,
          deliveryTime: Date.now(),
          deliveryCount: (groupData.pending.get(entry.id)?.deliveryCount || 0) + 1,
          fields: entry.fields
        });
      });

      if (entries.length > 0) {
        result.push({
          name: key,
          entries
        });
      }
      console.log("The final group data:", groupData)
      console.log("The consumer group: ", this.consumerGroups)
      console.log("The group we added ", this.consumerGroups.get(key))
    }
    return result;
  }
  xack(key, group, ...ids) {
    console.log("XACK parameters: ", key, group, ...ids)
    const streamGroups = this.consumerGroups.get(key);
    if (!streamGroups || !streamGroups.has(group)) {
      throw new Error('ERR group does not exist');
    }

    const groupData = streamGroups.get(group);
    let acknowledged = 0;

    ids.forEach(id => {
      if (groupData.pending.delete(id)) {
        acknowledged++;
      }
    });
    console.log("The current consumer group:", this.consumerGroups.get(key))
    return acknowledged;
  }
  xpending(key, group) {
    console.log("XPENDING PARAMETERS", key, group)
    const streamGroups = this.consumerGroups.get(key);
    if (!streamGroups || !streamGroups.has(group)) {
      throw new Error('ERR group does not exist');
    }
  
    const groupData = streamGroups.get(group);
    console.log("XPENDING: ", groupData)
    return {
      count: groupData.pending.size,
      start: Array.from(groupData.pending.keys())[0] || null,
      end: Array.from(groupData.pending.keys()).pop() || null,
      consumers: Array.from(groupData.pending.values()).reduce((acc, curr) => {
        acc[curr.consumer] = (acc[curr.consumer] || 0) + 1;
        return acc;
      }, {})
    };
  }
  // UNIVERSAL OPERATIONS
  del(...keys) {
    let deletedCount = 0;
    keys.forEach(key => {
      if (this.storage.has(key)) {
        this.storage.delete(key);
        this.expirations.delete(key);
        deletedCount++;
      }
    });
    return deletedCount;
  }
  get(key) {
    console.log("GET Parameters:", key)
    const expiration = this.expirations.get(key);
    if (expiration && Date.now() > expiration) {
      // Key has expired, remove it
      this.storage.delete(key);
      this.expirations.delete(key);
      return null;
    }
    return this.storage.get(key) || null;
  }
  keys(pattern = '*') {
    console.log("Keys Parameter: ", pattern)
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    console.log("Pattern replaced: ", regex)
    return [...this.storage.keys()].filter(key => regex.test(key));
  }
  exists(...keys) {
    return keys.filter(key => this.storage.has(key)).length;
  }
  multi() {
    this.transactionMode = true;
    this.commandQueue = [];
    return "OK";
  }
  exec() {
    if (!this.transactionMode) return "ERROR: Not in transaction mode";
  
    const responses = [];
    // The commandQueue is being emptied once this finish so I created a new array in constructor
    for (const { command, args } of this.commandQueue) {
      // Use a helper method to run the command within RedisClone
      const response = this._runCommand(command, args);
      responses.push(response);
      // My idea is to push it in the array we made in constructor so we can access it in server and avoid declaring the server in this class or returning two things
      this.finishedCommand.push({ command, args })
    }
    this.transactionMode = false; // Exit transaction mode
    this.commandQueue = []; // Clear the queue
    return responses;
  }
  discard() {
    if (!this.transactionMode) return "ERROR: Not in transaction mode";
  
    this.transactionMode = false;
    this.commandQueue = [];
    return "OK";
  }
  expire(key, seconds) {
    if (!this.storage.has(key)) return 0;
    
    const expiresAt = Date.now() + (seconds * 1000);
    this.expirations.set(key, expiresAt);
    return 1;
  }
  ttl(key) {
    if (!this.storage.has(key)) {
        // Key does not exist
        return -2; // Standard Redis response for non-existent keys
    }
    if (!this.expirations.has(key)) {
        // Key exists but has no expiration
        return -1; // Standard Redis response for keys with no associated timeout
    }

    const expiresAt = this.expirations.get(key);
    const now = Date.now();
    const remainingTime = Math.ceil((expiresAt - now) / 1000);

    return remainingTime > 0 ? remainingTime : -2; // Return -2 if the key has already expired
  }
  flushall() {
    // Clear both storage and expirations
    this.storage.clear();
    this.expirations.clear();
    
    return 'OK';
  }
}

module.exports = RedisClone;