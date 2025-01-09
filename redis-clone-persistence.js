const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const RedisClone = require('./redis-clone');
const { channel } = require('diagnostics_channel');

class PersistenceManager {
  constructor(options = {}) {
    // Default configuration
    this.config = {
      // Directory to store persistence files
      dataDir: path.join(process.cwd(), 'redis-data'),
      // AOF file name
      aofFileName: 'appendonly.aof',
      // RDB file name
      rdbFileName: 'dump.rdb',
      // Max AOF file size before rewriting (100MB)
      maxAofFileSize: 100 * 1024 * 1024,
      // How often to perform RDB snapshots (in seconds)
      rdbSnapshotInterval: 60 * 5, // 5 minutes
      // Number of RDB snapshots to keep
      maxRdbSnapshots: 5
    };

    // Merge with user-provided options
    this.config = { ...this.config, ...options };

    // Ensure data directory exists
    if (!fs.existsSync(this.config.dataDir)) {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
    }

    // Paths for files
    this.paths = {
      aof: path.join(this.config.dataDir, this.config.aofFileName),
      rdb: path.join(this.config.dataDir, this.config.rdbFileName)
    };
  }

  // Write operation to AOF
  appendToAOF(command) {
    const timestamp = Date.now();
    const logEntry = `${timestamp}:${command}\n`;
    
    try {
      fs.appendFileSync(this.paths.aof, logEntry);
    } catch (error) {
      console.error('Error writing to AOF:', error);
    }

    // Check if AOF needs rewriting
    this.checkAOFRewrite();
  }

  // Rewrite AOF to prevent bloat
  rewriteAOF(redisInstance) {
    const tempAofPath = `${this.paths.aof}.temp`;
    
    try {
      // Create a new temporary AOF file
      const writeStream = fs.createWriteStream(tempAofPath);

      // Iterate through all current keys and write their state
      for (const [key, value] of redisInstance.storage.entries()) {
        const expiration = redisInstance.expirations.get(key);
        
        if (!expiration || expiration > Date.now()) {
          // Reconstruct the original SET command
          const expirationCmd = expiration 
            ? ` EX ${Math.floor((expiration - Date.now()) / 1000)}` 
            : '';
          const cmd = `SET ${key} ${value}${expirationCmd}`;
          writeStream.write(`${Date.now()}:${cmd}\n`);
        }
      }

      writeStream.end();

      // Replace old AOF with new one
      fs.renameSync(tempAofPath, this.paths.aof);
    } catch (error) {
      console.error('Error rewriting AOF:', error);
    }
  }

  // Check if AOF needs rewriting
  checkAOFRewrite() {
    try {
      const stats = fs.statSync(this.paths.aof);
      if (stats.size > this.config.maxAofFileSize) {
        console.log('AOF file too large, scheduling rewrite');
        // In a real-world scenario, you might want to use a background process
        // this.rewriteAOF(redisInstance);
      }
    } catch (error) {
      // File might not exist
      console.error('Error checking AOF size:', error);
    }
  }

  // Create RDB snapshot
  createRDBSnapshot(redisInstance) {
    try {
      // Rotate existing RDB files
      this.rotateRDBSnapshots();

      // Create a compressed RDB snapshot
      const snapshotData = {
        timestamp: Date.now(),
        storage: Array.from(redisInstance.storage.entries()),
        expirations: Array.from(redisInstance.expirations.entries()),
        lastIds: Array.from(redisInstance.lastIds.entries()),
        consumerGroups: Array.from(redisInstance.consumerGroups.entries()),
        channels: Array.from(redisInstance.channels.entries()),
        clientSubscriptions: Array.from(redisInstance.clientSubscriptions.entries())
      };

      // Compress the snapshot
      const compressedData = zlib.gzipSync(JSON.stringify(snapshotData));
      
      // Write compressed snapshot
      const snapshotPath = path.join(
        this.config.dataDir, 
        `dump.${snapshotData.timestamp}.rdb.gz`
      );
      fs.writeFileSync(snapshotPath, compressedData);
    } catch (error) {
      console.error('Error creating RDB snapshot:', error);
    }
  }

  // Rotate RDB snapshots to prevent disk space bloat
  rotateRDBSnapshots() {
    const rdbFiles = fs.readdirSync(this.config.dataDir)
      .filter(file => file.startsWith('dump.') && file.endsWith('.rdb.gz'))
      .sort((a, b) => {
        // Sort by timestamp (newest first)
        const timestampA = parseInt(a.match(/dump\.(\d+)\.rdb\.gz/)[1]);
        const timestampB = parseInt(b.match(/dump\.(\d+)\.rdb\.gz/)[1]);
        return timestampB - timestampA;
      });

    // Remove excess snapshots
    while (rdbFiles.length >= this.config.maxRdbSnapshots) {
      const oldestSnapshot = rdbFiles.pop();
      fs.unlinkSync(path.join(this.config.dataDir, oldestSnapshot));
    }
  }

  // Recover data from persistence files
  recoverData() {
    let recoveredData = {
      storage: new Map(),
      expirations: new Map(),
      lastIds: new Map(),
      consumerGroups: new Map(),
      channels: new Map(),
      clientSubscriptions: new Map()
    };

    // Right now this whole sequence is kinda fucked because of aofRecovery will need to monitor this.
    // Try to recover from RDB first (most recent snapshot)
    const rdbRecovery = this.recoverFromRDB();
    if (rdbRecovery) {
      recoveredData = rdbRecovery;
    }

    // Replay AOF to catch any updates after the RDB snapshot
    const aofRecovery = this.recoverFromAOF(recoveredData);
    
    return aofRecovery;
  }

  // Recover from the most recent RDB snapshot
  recoverFromRDB() {
    try {
      const rdbFiles = fs.readdirSync(this.config.dataDir)
        .filter(file => file.startsWith('dump.') && file.endsWith('.rdb.gz'))
        .sort((a, b) => {
          const timestampA = parseInt(a.match(/dump\.(\d+)\.rdb\.gz/)[1]);
          const timestampB = parseInt(b.match(/dump\.(\d+)\.rdb\.gz/)[1]);
          return timestampB - timestampA;
        });

      if (rdbFiles.length > 0) {
        const mostRecentSnapshot = rdbFiles[0];
        const snapshotPath = path.join(this.config.dataDir, mostRecentSnapshot);
        
        // Decompress and parse the snapshot
        const compressedData = fs.readFileSync(snapshotPath);
        const snapshotData = JSON.parse(zlib.gunzipSync(compressedData));

        const now = Date.now();
        const validStorage = snapshotData.storage.filter(([key]) => {
          const expiration = snapshotData.expirations.find(([expKey]) => expKey === key)?.[1];
          return !expiration || expiration > now;
        });

        // Return all data structures
        return {
          storage: new Map(validStorage),
          expirations: new Map(snapshotData.expirations.filter(([_, expTime]) => expTime > now)),
          lastIds: new Map(snapshotData.lastIds || []),
          consumerGroups: new Map(snapshotData.consumerGroups || []),
          channels: new Map(snapshotData.channels || []),
          clientSubscriptions: new Map(snapshotData.clientSubscriptions || [])
        };
      }
    } catch (error) {
      console.error('Error recovering from RDB:', error);
    }
    return null;
  }

  // Replay AOF to catch updates after RDB snapshot
  // I think I should run this in the RedisClone class but lets see.
  recoverFromAOF(baseData) {
    try {
      if (fs.existsSync(this.paths.aof)) {
        const aofContent = fs.readFileSync(this.paths.aof, 'utf8');
        const lines = aofContent.split('\n').filter(line => line.trim());
        
        // Create temporary RedisClone instance for recovery
        const tempRedis = new RedisClone();
        
        // Initialize with base data if exists
        if (baseData) {
          tempRedis.storage = new Map(baseData.storage);
          tempRedis.expirations = new Map(baseData.expirations);
          tempRedis.lastIds = new Map(baseData.lastIds);
          tempRedis.consumerGroups = new Map(baseData.consumerGroups);
          tempRedis.channels = new Map(baseData.channels);
          tempRedis.clientSubscriptions = new Map(baseData.clientSubscriptions);
        }

        // Replay each command
        lines.forEach(line => {
          const [timestamp, ...commandParts] = line.split(':');
          const command = commandParts.join(':');
          const commandTime = parseInt(timestamp);
          const now = Date.now();
          
          // Special handling for JSON commands
          if (command.startsWith('JSON')) {
            // Find the first space after JSON.SET/JSON.GET etc
            const firstSpace = command.indexOf(' ');
            const cmd = command.substring(0, firstSpace);
            // The rest is our arguments, but we need to parse them carefully
            let remainingArgs = command.substring(firstSpace + 1).trim();
            // Parse arguments maintaining JSON structure
            const args = [];
            let currentArg = '';
            let inQuotes = false;
            let bracketCount = 0;
            
            for (let i = 0; i < remainingArgs.length; i++) {
              const char = remainingArgs[i];
              
              if (char === '"' && remainingArgs[i - 1] !== '\\') {
                inQuotes = !inQuotes;
                currentArg += char;
              } else if (char === '{' || char === '[') {
                bracketCount++;
                currentArg += char;
              } else if (char === '}' || char === ']') {
                bracketCount--;
                currentArg += char;
              } else if (char === ' ' && !inQuotes && bracketCount === 0) {
                if (currentArg) {
                  args.push(currentArg);
                  currentArg = '';
                }
              } else {
                currentArg += char;
              }
            }
            
            if (currentArg) {
              args.push(currentArg);
            }
  
            // For JSON.SET commands, parse the JSON value
            if (cmd === 'JSON.SET' && args.length >= 3) {
              try {
                // The last argument should be JSON
                const jsonStr = args[args.length - 1];
                const parsedJson = JSON.parse(jsonStr);
                args[args.length - 1] = parsedJson;
              } catch (error) {
                console.error('Error parsing JSON value during recovery:', error);
                return; // Skip this command
              }
            }
            try {
              tempRedis._runCommand(cmd, args);
            } catch (error) {
              console.error(`Error executing JSON command during recovery: ${command}`, error);
            }
          } else {
            // Handle non-JSON commands
            const parts = command.trim().split(' ');
            const cmd = parts[0].toUpperCase();
            const args = parts.slice(1);
            // Handle expiration for SET commands
            if (cmd === 'SET') {
              const exIndex = args.indexOf('EX');
              if (exIndex !== -1) {
                const expSeconds = parseInt(args[exIndex + 1]);
                const originalExpirationTime = commandTime + (expSeconds * 1000); // This is always ex so 
                
                if (originalExpirationTime <= now) {
                  return;
                }
                
                // Originally we pass the already converted to seconds
                const remainingTime = Math.ceil((originalExpirationTime - now) / 1000);
                args[exIndex + 1] = remainingTime.toString();
                // Alternative. Passing the originalExpirationTime so we can just set this to expirations.map
                // args[exIndex + 1] = originalExpirationTime
              }
            }
  
            try {
              tempRedis._runCommand(cmd, args);
            } catch (error) {
              console.error(`Error executing command during recovery: ${command}`, error);
            }
          }
        });

        return {
          storage: tempRedis.storage,
          expirations: tempRedis.expirations,
          lastIds: tempRedis.lastIds,
          consumerGroups: tempRedis.consumerGroups,
          channels: tempRedis.channels,
          clientSubscriptions: tempRedis.clientSubscriptions
        };
      }
    } catch (error) {
      console.error('Error recovering from AOF:', error);
    }
    return {
      storage: new Map(),
      expirations: new Map(),
      lastIds: new Map(),
      consumerGroups: new Map(),
      channels: new Map(),
      clientSubscriptions: new Map()
    };
  }
}

module.exports = PersistenceManager;