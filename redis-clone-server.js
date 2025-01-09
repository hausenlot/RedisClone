const net = require('net');
const RedisClone = require('./redis-clone');
const PersistenceManager = require('./redis-clone-persistence');
const { lua } = require('fengari');
const { json } = require('stream/consumers');

class RedisCloneServer {
  constructor(port = 6379, mode = 'master', masterHost = null, masterPort = null, password = '12341234', persistenceOptions = {}) {
    // Recover existing data or start fresh
    const persistenceManager = new PersistenceManager(persistenceOptions);
    const recoveredData = persistenceManager.recoverData();

    // This only happens once. Any connection after that is free to connect. Sloppy but I don't have enough time and braincell to make it more secure :/
    this.password = password;
    this.isAuthenticated = false;

    // Replication
    this.port = port;
    this.mode = mode; // 'master' or 'slave'
    this.masterHost = masterHost;
    this.masterPort = masterPort;
    this.slaves = [];

    // Create a single RedisClone instance for the server
    this.redis = new RedisClone();
    // Assigned the maps created in persistence class
    this.redis.storage = recoveredData.storage;
    this.redis.expirations = recoveredData.expirations;
    this.redis.lastIds = recoveredData.lastIds;
    this.redis.consumerGroups = recoveredData.consumerGroups;
    this.redis.channels = recoveredData.channels;
    this.redis.clientSubscriptions = recoveredData.clientSubscriptions;
    
    this.redis.startCleanup();

    // Store persistence manager
    this.persistenceManager = persistenceManager;

    this.subscriberSockets = new Map(); // socket -> clientId
    this.reverseSubscriberSockets = new Map(); // clientId -> socket
    this.nextClientId = 1; // For generating clientIds

    // Checks what mode of the server is starting
    if (mode === 'master') {
      this.createMasterServer();
       // Set up periodic RDB snapshots
      this.rdbInterval = setInterval(() => {
        this.persistenceManager.createRDBSnapshot(this.redis);
      }, persistenceOptions.rdbSnapshotInterval || (5 * 60 * 1000)); // uses ms 
    } else if (mode === 'slave') {
      this.connectToMaster();
      this.createSlaveServer();
    }
  }

  createMasterServer() {
    this.server = net.createServer((socket) => {
      console.log('Client connected');
      const clientId = this.generateClientId();
      
      socket.on('data', (data) => {
        const command = data.toString().trim();
        console.log("RAW Command from socket: ", command)
        
        if (command === 'IDENTIFY-SLAVE') {
          console.log('Slave connected');
          this.slaves.push(socket);
        } else if (command === 'SYNC') {
          console.log('Handling SYNC command manually');
          this.sendFullSync(socket);
        } else {
          const parsedCommand = this.parseCommand(command);
          
          // Handle pub/sub commands specially
          if (this.isPubSubCommand(parsedCommand.command)) {
            this.handlePubSubCommand(parsedCommand, socket, clientId);
          } else {
            // Your existing command handling
            const response = this.executeCommand(parsedCommand, socket);
            socket.write(this.formatResponse(response) + '\n');
          }
        }
      });

      socket.on('end', () => {
        console.log('Client disconnected');
        this.slaves = this.slaves.filter((slave) => slave !== socket);
        // Clean up pub/sub on disconnect
        if (this.subscriberSockets.has(socket)) {
          const clientId = this.subscriberSockets.get(socket);
          this.redis.unsubscribe(clientId);
          this.subscriberSockets.delete(socket);
          this.reverseSubscriberSockets.delete(clientId);
        }
      });
    });

    // Set up message handler for pub/sub
    this.redis.onMessage((clientId, message) => {
      const socket = this.reverseSubscriberSockets.get(clientId);
      if (socket) {
        socket.write(this.formatResponse({
          type: 'message',
          channel: message.channel,
          data: message.message
        }) + '\n');
      }
    });

    this.server.listen(this.port, () => {
      console.log(`Master server listening on port ${this.port}`);
    });
  }

  createSlaveServer() {
    this.server = net.createServer((socket) => {
      console.log('Client connected to slave');
  
      socket.on('data', (data) => {
        const command = this.parseCommand(data.toString().trim());
        const response = this.executeCommand(command, socket);
        socket.write(this.formatResponse(response) + '\n');
      });
  
      socket.on('end', () => {
        console.log('Client disconnected from slave');
      });
    });
  
    this.server.listen(this.port, () => {
      console.log(`Slave server listening on port ${this.port}`);
    });
  }

  connectToMaster() {
    this.masterConnection = net.createConnection({ host: this.masterHost, port: this.masterPort }, () => {
      console.log('Connected to master');

      this.masterConnection.write('IDENTIFY-SLAVE\n');
      setTimeout(() => {
        this.masterConnection.write('SYNC\n');
      }, 10); // 10ms delay
    });

    this.masterConnection.on('data', (data) => {
      const commands = data.toString().trim().split('\n');
      for (const command of commands) {
        const parsedCommand = this.parseCommand(command);
        this.executeCommand(parsedCommand);
      }
    });

    this.masterConnection.on('end', () => {
      console.log('Disconnected from master');
    });
  }

  // Parse raw command string into command and arguments
  parseCommand(rawCommand) {
    // console.log(rawCommand)
    // Split command, handling quoted strings and spaces
    // If the rawCommand is like a json make sure that the value doesn't have white spaces outside of double quotes or else the match regex will seperate them
    if (!rawCommand || !rawCommand.trim()) {
      return {
        command: '',
        args: []
      };
    }
  
    const parts = rawCommand.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    return {
      command: parts[0]?.toUpperCase(),
      args: parts.slice(1).map(arg => 
        arg.replace(/^"|"$/g, '')
      )
    };
  }

  // Execute Redis-like commands
  executeCommand({ command, args }) {
    // console.log("A ",this.mode," is executing a command: ", command)
    try {

      if (!this.isAuthenticated) {
        if (command !== 'AUTH') return 'ERR Authentication required';
        if (args[0] === this.password) {
          this.isAuthenticated = true;
          return 'OK';
        }
        return 'ERR invalid password';
      }

      let result;
      const fullCommand = `${command} ${args.join(' ')}`;
      // Broadcast the command and its argument to the slaves
      if (this.mode === 'master' && command !== 'GET' && command !== 'SYNC') {
        this.broadcastToSlaves(`${command} ${args.join(' ')}`);
      }

      if (this.redis.transactionMode && command !== "EXEC" && command !== "DISCARD") {
        this.redis.commandQueue.push({ command, args }); // Queue the command and its arguments
        return "QUEUED";
      }  

      switch (command) {
        case 'AUTH':
          if (this.isAuthenticated) {
          }
          return 'OK';
        case 'SET':
          // SET key value [EX seconds | PX milliseconds]
          const options = {};
          if (args[2] === 'EX') {
            options.ex = parseInt(args[3]);
          } else if (args[2] === 'PX') {
            options.px = parseInt(args[3]);
          }

          result = this.redis.set(args[0], args[1], options);

          if (this.mode === 'master') {
            
            this.persistenceManager.appendToAOF(fullCommand);
          }
          return result;
        case 'APPEND':
            result = this.redis.append(args[0], args[1]);
            if (this.mode === 'master') {
              this.persistenceManager.appendToAOF(fullCommand);
            }
          return result;        
        case 'GET':
          return this.redis.get(args[0]);
        case 'GETRANGE':
          console.log(args)
          return this.redis.getrange(args[0], args[1], args[2]);        
        case 'SETRANGE':
          console.log(args)
          result = this.redis.setrange(args[0], args[1], args[2]);
          
          if (this.mode === 'master') {
            this.persistenceManager.appendToAOF(fullCommand);
          }

          return result;
        case 'DEL':
          result = this.redis.del(...args);
          if (this.mode === 'master') {
            this.persistenceManager.appendToAOF(fullCommand);
          }
          return result;       
        case 'EXISTS':
          return this.redis.exists(...args);       
        case 'EXPIRE':
          result = this.redis.expire(args[0], parseInt(args[1]));
          if (this.mode === 'master') {
            this.persistenceManager.appendToAOF(fullCommand);
          }
          return result;       
        case 'TTL':
          return this.redis.ttl(args[0]);
        case 'KEYS':
          return this.redis.keys(args[0]);
        case 'STRLEN':
          return this.redis.strlen(args[0]);      
        case 'INCR':
          result = this.redis.incr(args[0]);
          if (this.mode === 'master') {
            this.persistenceManager.appendToAOF(fullCommand);
          }
          return result;
        case 'DECR':
          result = this.redis.decr(args[0]);
          if (this.mode === 'master') {
            this.persistenceManager.appendToAOF(fullCommand);
          }
          return result;
        case 'INCRBY':
          result = this.redis.incrby(args[0], args[1]);
          if (this.mode === 'master') {
            this.persistenceManager.appendToAOF(fullCommand);
          }
          return result;
        case 'DECRBY':
          result = this.redis.decrby(args[0], args[1]);
          if (this.mode === 'master') {
            this.persistenceManager.appendToAOF(fullCommand);
          }
          return result;
        case 'JSON.SET':
          if (args.length < 3) {
            return 'ERR wrong number of arguments for JSON.SET command';
          }
          try {
            // The value (third argument) needs to be parsed as JSON
            // console.log("We are passing the", args[0], args[1], args[2])
            const jsonValue = JSON.parse(args[2]);
            result = this.redis.jsonSet(args[0], args[1], jsonValue);
            
            if (this.mode === 'master') {
              // For AOF persistence, we need to store the command exactly as received
              this.persistenceManager.appendToAOF(fullCommand);
            }
            return result;
          } catch (error) {
            return `ERR ${error.message}`;
          };        
        case 'JSON.GET':
          // JSON.GET requires at least 1 argument (key), path is optional
          if (args.length < 1) {
            return 'ERR wrong number of arguments for JSON.GET command';
          }
          
          try {
            // If path is not provided, use root path "."
            const path = args.length > 1 ? args[1] : ".";
            result = this.redis.jsonGet(args[0], path);
            
            // Return stringified JSON for network transmission
            return JSON.stringify(result);
          } catch (error) {
            return `ERR ${error.message}`;
          };
        case 'JSON.ARRAPPEND':
          if (args.length < 3) {
            return 'ERR wrong number of arguments for JSON.ARRAPPEND command';
          }

          try {
            // If path is not provided, use root path "."
            const path = args.length > 1 ? args[1] : ".";
            result = this.redis.jsonArrAppend(args[0], path, args[2]);
            
            if (this.mode === 'master') {
              // For AOF persistence, we need to store the command exactly as received
              this.persistenceManager.appendToAOF(fullCommand);
            }

            return result;
          } catch (error) {
            return `ERR ${error.message}`;
          };        
        case 'JSON.DEL': 
          if (args.length < 1) {
            return 'ERR wrong number of arguments for JSON.GET command';
          }
          
          try {
            // If path is not provided, use root path "."
            const path = args.length > 1 ? args[1] : ".";
            result = this.redis.jsonDel(args[0], path);
            
            if (this.mode === 'master') {
              // For AOF persistence, we need to store the command exactly as received
              this.persistenceManager.appendToAOF(fullCommand);
            }

            // Return stringified JSON for network transmission
            return result;
          } catch (error) {
            return `ERR ${error.message}`;
          };        
        case 'LPUSH':
          try {
            const values = args.slice(1)
            result = this.redis.lpush(args[0], ...values)

            if (this.mode === 'master') {
              // For AOF persistence, we need to store the command exactly as received
              this.persistenceManager.appendToAOF(fullCommand);
            }
            
            return result
          } catch (error) {
            return `ERR ${error.message}`
          };
        case 'RPUSH':
          try {
            const values = args.slice(1)
            result = this.redis.rpush(args[0], ...values)

            if (this.mode === 'master') {
              // For AOF persistence, we need to store the command exactly as received
              this.persistenceManager.appendToAOF(fullCommand);
            }
            
            return result
          } catch (error) {
            return `ERR ${error.message}`
          };        
        case 'LPOP':
          try {
            const count = args.indexOf('COUNT') < 0 ? 1 : args[args.indexOf('COUNT')+1]
            console.log(count)
            result = this.redis.lpop(args[0], count)

            if (this.mode === 'master') {
              // For AOF persistence, we need to store the command exactly as received
              this.persistenceManager.appendToAOF(fullCommand);
            }
            return result      
          } catch(error) {
            return `ERR ${error.message}`
          };
        case 'RPOP':
          try {
            const count = args.indexOf('COUNT') < 0 ? 1 : args[args.indexOf('COUNT')+1]
            console.log(count)
            result = this.redis.rpop(args[0], count)

            if (this.mode === 'master') {
              // For AOF persistence, we need to store the command exactly as received
              this.persistenceManager.appendToAOF(fullCommand);
            }
            return result      
          } catch(error) {
            return `ERR ${error.message}`
          };
        case 'LRANGE':
          if (args.length < 3) {
            return 'ERR wrong number of arguments for LRANGE command';
          }

          result = this.redis.lrange(args[0], args[1], args[2])
          return result
        case 'LINDEX':
          return this.redis.lindex(args[0], args[1]);
        case 'LSET':
          if (args.length < 3) {
            return 'ERR wrong number of arguments for LRANGE command';
          }
          result = this.redis.lset(args[0], args[1], args[2]);

          if (this.mode === 'master') {
            // For AOF persistence, we need to store the command exactly as received
            this.persistenceManager.appendToAOF(fullCommand);
          }
          
          return result        
        case 'SADD':
          try {
            const values = args.slice(1)
            result = this.redis.sadd(args[0], ...values)

            if (this.mode === 'master') {
              // For AOF persistence, we need to store the command exactly as received
              this.persistenceManager.appendToAOF(fullCommand);
            }
            
            return result
          } catch (error) {
            return `ERR ${error.message}`
          };
        case 'SISMEMBER':
          return this.redis.sismember(args[0], args[1]);        
        case 'SMEMBERS':
          return this.redis.smembers(args[0]);        
        case 'SREM':
          try {
            const values = args.slice(1)
            result = this.redis.srem(args[0], ...values)

            if (this.mode === 'master') {
              // For AOF persistence, we need to store the command exactly as received
              this.persistenceManager.appendToAOF(fullCommand);
            }
            
            return result
          } catch (error) {
            return `ERR ${error.message}`
          };        
        case 'SINTER':
          return this.redis.sinter(...args.slice(0));   
        case 'SUNION':
          return this.redis.sunion(...args.slice(0));
        case 'SDIFF':
          return this.redis.sdiff(...args.slice(0));
        case 'HSET':
          if (args.slice(1).length % 2 !== 0) {
            return 'ERR wrong number o f arguments for HSET command'
          }
          result = this.redis.hset(args[0], ...args.slice(1))
          if (this.mode === 'master') {
            // For AOF persistence, we need to store the command exactly as received
            this.persistenceManager.appendToAOF(fullCommand);
          }
          return result
        case 'HGET':
          return this.redis.hget(args[0], args[1]);
        case 'HMSET':
          if (args.slice(1).length % 2 !== 0) {
            return 'ERR wrong number of arguments for HSET command'
          }
          result = this.redis.hmset(args[0], ...args.slice(1))
          if (this.mode === 'master') {
            // For AOF persistence, we need to store the command exactly as received
            this.persistenceManager.appendToAOF(fullCommand);
          }
          return result
        case 'HGETALL':
          return this.redis.hgetall(args[0]);
        case 'HDEL':
          result = this.redis.hdel(args[0], ...args.slice(1))
          if (this.mode === 'master') {
            // For AOF persistence, we need to store the command exactly as received
            this.persistenceManager.appendToAOF(fullCommand);
          }
          return result
        case 'HEXISTS':
          return this.redis.hexists(args[0], args[1]);
        case 'ZADD':
          if (args.slice(1).length % 2 !== 0) {
            return "ERR wrong number of arguments for ZADD command"
          }
          result = this.redis.zadd(args[0], ...args.slice(1))
          if (this.mode === 'master') {
            // For AOF persistence, we need to store the command exactly as received
            this.persistenceManager.appendToAOF(fullCommand);
          }
          return result
        case 'ZRANGE':
          if (args < 3 ) {
            return "ERR wrong number of arguments for ZRANGE command"
          }
          result = this.redis.zrange(args[0], args[1], args[2], args[3])
          return result
        case 'ZRANK':
          if (args < 2 ) {
            return "ERR wrong number of arguments for ZRANK command"
          }
          result = this.redis.zrank(args[0], args[1], args[2])
          return result
        case 'ZREM':
          if (args < 1 ) {
            return "ERR wrong number of arguments for ZRANGE command"
          }
          result = this.redis.zrem(args[0], ...args.slice(1))
          if (this.mode === 'master') {
            // For AOF persistence, we need to store the command exactly as received
            this.persistenceManager.appendToAOF(fullCommand);
          }
          return result
        case 'ZRANGEBYSCORE':
          if (args < 3 ) {
            return "ERR wrong number of arguments for ZRANGEBYSCORE command"
          }
          result = this.redis.zrangebyscore(args[0], args[1], args[2], args[3])
          return result
        case 'XADD':
          if (args < 4 ) {
            return "ERR wrong number of arguments for XADD command"
          }
          result = this.redis.xadd(args[0], args[1], ...args.slice(2)) 
          if (this.mode === 'master') {
            // For AOF persistence, we need to store the command exactly as received
            this.persistenceManager.appendToAOF(fullCommand);
          }
          return result
        case 'XLEN':
          return this.redis.xlen(args[0]);
        case 'XRANGE':
          if (args < 3 ) {
            return "ERR wrong number of arguments for XRANGE command"
          }
          result = this.redis.xrange(args[0], args[1], args[2], args[3])
          // console.log("From: xrange: ",result)
          return result
        case 'XREAD':
          // (options = {}, streams = [])
          // XREAD COUNT 2 STREAMS mystream writers 0-0
          try {
            const options = {};
            const optionsArray = args.slice(args.indexOf('COUNT') , args.indexOf('STREAM')) // Optional
            const streamsArray = args.slice(args.indexOf('STREAMS') + 1, args.length) // Needed or else the +1 will fuck me
            options.count = optionsArray[1]
            result = this.redis.xread(options, streamsArray)
            return result
          } catch (error){
            return `ERR ${error.message}`;
          };
        case 'XGROUPCREATE':
          if (args < 2 ) {
            return "ERR wrong number of arguments for XGROUPCREATE command"
          }
          try {
            result = this.redis.xgroupCreate(args[0], args[1], args[2])
            if (this.mode === 'master') {
              // For AOF persistence, we need to store the command exactly as received
              this.persistenceManager.appendToAOF(fullCommand);
            }
            return result
          } catch (error) {
            return `ERR ${error.message}`; 
          };
        case 'XREADGROUP':
          // xreadgroup(group, consumer, options = {}, streams = [])
          // XREADGROUP groupName consumerName COUNT 1 STREAMS mykey > 
          try {
            const options = {};
            const optionsArray = args.slice(args.indexOf('COUNT'), args.indexOf('STREAM')) // Optional
            const streamsArray = args.slice(args.indexOf('STREAMS') + 1, args.length) // Needed or else the +1 will fuck me
            options.count = optionsArray[0]
            result = this.redis.xreadgroup(args[0], args[1], options, streamsArray)
            if (this.mode === 'master') {
              // For AOF persistence, we need to store the command exactly as received
              this.persistenceManager.appendToAOF(fullCommand);
            }
            return result
          } catch (error){
            return `ERR ${error.message}`;
          };
        case 'XACK':
          // xack(key, group, ...ids)
          if (args < 2 ) {
            return "ERR wrong number of arguments for XACK command"
          }
          result = this.redis.xack(args[0], args[1], ...args.slice(2));
          if (this.mode === 'master') {
            // For AOF persistence, we need to store the command exactly as received
            this.persistenceManager.appendToAOF(fullCommand);
          }
          return result;
        case 'XPENDING':
          return this.redis.xpending(args[0], args[1]);
        case 'EVAL':
          this.redis.initLuaState();
          // EVAL SCRIPT redis.call("SET", KEYS[1], ARGV[1]) return redis.call("GET", KEYS[1]) KEY myKey VALUE myValue
          // const luaScript = 'redis.call("SET", KEYS[1], ARGV[1]) return redis.call("GET", KEYS[1])';
          // EVAL KEY myKey VALUE myValue
          const script = args.slice(args.indexOf('SCRIPT') + 1, args.indexOf('KEY')).join(' ')
          const key = args.slice(args.indexOf('KEY') + 1 , args.indexOf('VALUE'))
          const value = args.slice(args.indexOf('VALUE') + 1 , args.length)

          // i dont wanna persit this :/
          
          return this.redis.eval(script, key, value);
        case 'MULTI':
          return this.redis.multi();
        case 'EXEC':
          result = this.redis.exec();
          if (this.mode === 'master') {
            if (result && Array.isArray(result)) {
              this.redis.finishedCommand.forEach(({ command, args }) => {
                console.log(`${command} ${args.join(' ')}`);
                // const rawCommand = command + " " + args.join(' ')
                const rawCommand = `${command} ${args.join(' ')}`
                // I think there' no need to check if the one doing the command is master since MULTI, EXEC doenst get logged in AOF
                this.persistenceManager.appendToAOF(rawCommand);
              });
            }
          }
          return result;
        case "DISCARD":
          return this.redis.discard();
        case 'FLUSHALL':
          result = this.redis.flushall();
          if (this.mode === 'master') {
            this.persistenceManager.appendToAOF(fullCommand);
          }
          return result;
        case 'SUBSCRIBE': {
          // subscribe(clientId, ...channelNames) 
          console.log(args)
          const channels = args.slice(1);

          if (channels.length === 0) {
            socket.write('ERROR: No channels specified\n');
            return;
          }
          
          const count = this.redis.subscribe(clientId, ...channels);
          this.subscriberSockets.set(clientId, socket);
          
          // Send subscription confirmation for each channel
          channels.forEach(channel => {
            socket.write(`subscribe ${channel} ${count}\n`);
          });
          break;
        }
      default:
        return `ERR unknown command '${command}'`;
      }
    } catch (error) {
      return `ERR ${error.message}`;
    }
  }

  // Format response for network transmission
  formatResponse(response) {
    console.log("RAW Response: ", response);
    console.log("Type of Response: ", typeof response);
    
    // Handle pub/sub specific responses
    if (response && typeof response === 'object' && response.type) {
        switch(response.type) {
            case 'subscribe':
            case 'unsubscribe':
                return `*3\r\n` + 
                       `$${response.type.length}\r\n${response.type}\r\n` +
                       `$${response.channel.length}\r\n${response.channel}\r\n` +
                       `(integer) ${response.data}`;
            
            case 'message':
                return `*3\r\n` +
                       `$7\r\nmessage\r\n` +
                       `$${response.channel.length}\r\n${response.channel}\r\n` +
                       `$${response.data.length}\r\n${response.data}`;
        }
    }

    // Handle null response
    if (response === null) return '$-1\r\n';

    // Handle number or numeric string response
    if (!isNaN(response) && typeof response !== 'object') {
        return `(integer) ${Number(response)}\r\n`;
    }
    
    // Handle string response
    if (typeof response === 'string') {
        return `(string) ${response}\r\n`;
    }

    // Handle Set response (convert to array)
    if (response instanceof Set) {
        response = Array.from(response);
    }

    // Handle array response
    if (Array.isArray(response)) {
        return `*${response.length}\r\n` + 
               response.map(item => {
                   if (typeof item === 'object') {
                       const jsonString = JSON.stringify(item);
                       return `$${jsonString.length}\r\n${jsonString}`;
                   } else if (typeof item === 'string') {
                       return `$${item.length}\r\n${item}`;
                   } else {
                       const str = String(item);
                       return `$${str.length}\r\n${str}`;
                   }
               }).join('\r\n');
    }

    // Default case: handle other response types
    return `+${JSON.stringify(response)}\r\n`;
  }

  generateClientId() {
    return `client-${this.nextClientId++}-${Date.now()}`;
  }

  isPubSubCommand(command) {
    const cmd = command.toUpperCase();
    return ['SUBSCRIBE', 'UNSUBSCRIBE', 'PUBLISH'].includes(cmd);
  }
  
  handlePubSubCommand(parsedCommand, socket, clientId) {
    const { command, args } = parsedCommand;
    let response;

    // Since the client id is fucking changing when DOING another command
    if (command.toUpperCase() === 'UNSUBSCRIBE') {
      clientId = this.subscriberSockets.get(socket);
      if (!clientId) {
        console.log('No subscription found for this socket');
        return;
      }
    }
  
    switch(command.toUpperCase()) {
      case 'SUBSCRIBE': {
        // Store socket mapping
        this.subscriberSockets.set(socket, clientId);
        this.reverseSubscriberSockets.set(clientId, socket);

        const count = this.redis.subscribe(clientId, ...args);
        
        // Send confirmation for each channel
        args.forEach(channel => {
          socket.write(this.formatResponse({
            type: 'subscribe',
            channel,
            data: count
          }) + '\n');
        });
        break;
      }
  
      case 'UNSUBSCRIBE': {
        const count = this.redis.unsubscribe(clientId, ...args);
      
        // Clean up mappings if no subscriptions remain
        if (count === 0) {
          console.log("Returned a zero without ")
          console.log(`Removing client ${clientId} from subscriber mappings.`);
          this.subscriberSockets.delete(socket);
          this.reverseSubscriberSockets.delete(clientId);
          console.log(this.redis.getSubscriptions(clientId))
        }

        console.log('Socket mappings after unsubscribe:');
        console.log('subscriberSockets:', this.subscriberSockets);
        console.log('reverseSubscriberSockets:', this.reverseSubscriberSockets);
      
        // Respond to client
        const channels = args.length > 0 ? args : Array.from(this.redis.getSubscriptions(clientId));
        channels.forEach(channel => {
          socket.write(this.formatResponse({
            type: 'unsubscribe',
            channel,
            data: count,
          }) + '\n');
        });
      
        break;
      }
  
      case 'PUBLISH': {
        const [channel, ...messageParts] = args;
        const message = messageParts.join(' ');
        const recipients = this.redis.publish(channel, message);
        socket.write(this.formatResponse(recipients) + '\n');
        break;
      }
    }
  }

  broadcastToSlaves(command) {
    this.slaves.forEach((slave) => {
      slave.write(command + '\n');
    });
  }

  sendFullSync(socket) {
    const data = [];
    for (const [key, value] of this.redis.storage.entries()) {
      data.push(`SET ${key} ${value}`);
    }
    socket.write(data.join('\n') + '\n');
  }

  // Stop the server
  stop() {
    this.server.close();
    this.redis.stopCleanup();
    clearInterval(this.rdbInterval);
  }
}

// Export the server class
module.exports = RedisCloneServer;

// If run directly, start the server
if (require.main === module) {
  const mode = process.argv[2] || 'master';
  const port = parseInt(process.argv[3]) || 6379;
  const masterHost = process.argv[4] || null;
  const masterPort = parseInt(process.argv[5]) || null;

  const server = new RedisCloneServer(port, mode, masterHost, masterPort);
}