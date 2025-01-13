const net = require('net');

class RedisCloneClient {
  constructor(port = 6379, host = 'localhost', password) {
    this.port = port;
    this.host = host;
    this.subscriptionMode = false;
    this.messageHandlers = new Set();
    this.password = password;
  }

  async connect() {
    const response = await this.sendCommand(`AUTH ${this.password}`);
    if (!response.includes('OK')) throw new Error('Authentication failed');
  }
  
  // Add message handler
  onMessage(callback) {
    this.messageHandlers.add(callback);
  }

  // Remove message handler
  offMessage(callback) {
    this.messageHandlers.delete(callback);
  }

  // Send a command and return a promise with the response
  sendCommand(command) {
    return new Promise((resolve, reject) => {
      if (this.subscriptionMode && 
        (command.toUpperCase().startsWith('SUBSCRIBE') || command.toUpperCase().startsWith('UNSUBSCRIBE'))) {
        if (this.socket) {  // we'll need to add this.socket property
          this.socket.write(command + '\n');
          resolve(this.socket);
          return;
          }
        } 
      // This is the actual TCP connection. The client in the CLI is the instance of this whole thing
      // This client is a connection
      // CLI client > this client
      const client = new net.Socket();
      let response = '';
      
      client.connect(this.port, this.host, () => {
        client.write(command + '\n');

         if (!command.toUpperCase().startsWith('SUBSCRIBE')) {
          client.end();
        } else {
          this.subscriptionMode = true;
          this.socket = client;  // Store the socket for future pub/sub commands
        }
      });

      client.on('data', (data) => {
        const message = data.toString().trim();
        if (command.toUpperCase().startsWith('SUBSCRIBE')) {
          this.handleSubscriptionMessage(message);
          this.subscriptionMode = true;
          resolve(client);
        } else {
          response = message;
          resolve(response);
        }
      });

      client.on('error', (err) => {
        reject(err);
      });
    });
  }

  handleSubscriptionMessage(message) {
    const lines = message.split('\r\n').filter(line => line.trim() !== '');
    if (lines[0] === '*3') {
      const type = lines[2];
      const channel = lines[4];
      const countStr = lines[5]; // Get the '(integer) X' string
      const count = parseInt(countStr.split(' ')[1]); // Extract just the number
      
      if (type === 'unsubscribe') {
        console.log(`Unsubscribed from channel: ${channel}`);
    
        if (count === 0) {
          // Reset everything
          this.subscriptionMode = false;
          if (this.socket) {
            this.socket.end();
            this.socket = null;
          }
          console.log('No active subscriptions. Exiting subscription mode.');
        }
      } else if (type === 'message') {
        const content = lines[6];
        this.messageHandlers.forEach(handler => handler(channel, content));
      }
    } else {
      console.log('Unrecognized message format:', message);
    }
  }
}

// If run directly, provide a CLI interface
if (require.main === module) {
  const port = process.argv[2]
  const localhost = process.argv[3]
  const password = process.argv[4]
  const client = new RedisCloneClient(port, localhost, password)

  client.connect() // This is the async connect not the .connect event of net module this is an async
    .then(() => {
      readline.prompt();
    })
    .catch(err => {
      console.error('Authentication failed');
      process.exit(1);
    });

    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'REDIS-CLONE> '
    });
  
    // Add message handler for subscriptions
    client.onMessage((channel, message) => {
      console.log(`\nReceived message from ${channel}: ${message}`);
      readline.prompt();
    });
  
    client.onMessage((channel, message) => {
      if (!client.subscriptionMode) {
        readline.prompt();  // Show prompt when exiting subscription mode
      }
    });
  
    readline.prompt();
  
    readline.on('line', async (line) => {
      try {
        const response = await client.sendCommand(line);
        if (response instanceof net.Socket) {
          console.log('Subscription active. Waiting for messages...');
        } else {
          console.log('Response:', response);
        }
      } catch (error) {
        console.error('Error:', error);
      }
      readline.prompt();
    }).on('close', () => {
      process.exit(0);
    });
  }

module.exports = RedisCloneClient;