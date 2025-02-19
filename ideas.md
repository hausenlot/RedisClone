# Ideas to implement
All of this are going to be psuedo code with assumptions and technically a theory to create a proof of concept

## **Client Development**
So right now my client doesnt have the following:
1. The CLI doesnt have a reconnection logic once the server shuts down
2. In subscription mode when connection is forcebly close the server will crash too
3. Full controll on server related features such as Persistence, Master/Slave, Cleanups, etc.

---

**In pseudo code here's we deal with the reconnection (1.)**

We need to implement this like this: 

A method will be called and this method is responsible now for all connection from server
We use a promise to enclose the connection to make sure that the process wont continue as long as the promise is not fulfilled
```
  async connect() {
    return new return new Promise((resolve, reject) => {
      //A socket
      //Connection to server using that socket
        // So I guess I need a way to know if its connected really
        // A resolve or reject here
      //Handling of data coming from server
        // So lets pass this on the handleResponses or handleResponse pub/sub or combine them
        // Then we assign that data as a resolve for the command
        // We dont need a resolve and reject here we just hijacking this part for the event in the socket
      //We need to catch an error from the server/connection to trigger a reconnection
        // reconnecting method here
        // resolve or reject here or maybe lets make the method return something as a response and put it on resolve function
      //Let add an end socket here to close the connection in disconnect so the server wont crash
    });
  }
```

**In pseudo code here's we deal with the server crashing on disconnect (2.)**

So its going to be an overhaul on pub/sub but either way the issue is because my implementation on pub/sub right now is base on socket being stored and the cause of crashes is about that socket closing prematurely due to user input we just need to abandon the socket storing method since we already using a persitent socket we just need to overhaul the pub/sub response on the handleResponse method.

```
//Inside the handleResponse method
//We check first if the response is for pub/sub
//We do that by looking in the content response
//If it include a subscribe, unsubscribe and message then it is else we let it through since its already beed formatted
//Then if its subscribe or unsubscibe we process it like other command but if its message we just need to prompt it via console.log or to be robust store it in a map so we can use it later as history or something else
```

**In pseudo code here's we deal with the missing server functionalities (3.)**
This is easy we just need to add more commands in the executeCommand method to process that commands  

**RDB snapshot interval**
```
// first instead of making a fix value on 
/*let minutes
  this.rdbInterval = setInterval(() => {
        this.persistenceManager.createRDBSnapshot(this.redis);
      }, persistenceOptions.rdbSnapshotInterval || (minutes * 60 * 1000));*/
// We change the 5 as minutes* then we can make it an inmutable

...
case 'RDBSNAPSHOT'
    minutes = args[1] // so assuming the args is [MIN 5] 0, 1 index
return 'OK'
```
**Master/Slave**
Just one idea comes to mind for now its the count of live Slave, I dont have any idea for the health state or remote disconnection as of now but its on the idea list.
```
this.slaves = [];
case 'SLAVECOUNT'
return this.slaves.length
```

**Cleanups**
So the starting and stopping of cleanups is base on the server. and can't be access by cli so lets expose it

So like we can do this
```
startCleanup(duration = 1) { // make it default to 1
    const interval = duration * 1000 // add a new variable to conver it to ms so by default it 1*1000 = 1 sec
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

case 'STARTCLEANUP'
  duration = args[1] // assuming that [DURATION 1]. 0, 1 in index
  this.redis.startCleanup(args[1]); // this is sloppy but you get the idea
return 'OK'
case 'STOPCLEANUP'
  this.redis.stopCleanup();
return 'OK'
```

## **VECTOR DATABASE IMPLEMENTATION**

So this is complicated first lets figure out what does Vector Database do:

So in a nutshell it converts data into a vector and store it, To be exact it takes the data run it to a language model to convert the data into a vector embeddings with the metadata for retrieval later then plot it to the vector database then if there's an indexing we get the vector to be index by HNSW and plotted to its own mapping for fast query

So that is the core concept of it so lets try to pseudo code it

```
const hnswlib = require('hnswlib-node'); // HNSW library
const { OpenAI } = require('openai'); // OpenAI SDK

class VectorMode {
  constructor(redisInstance) { // expecting the redisinstance from server 
    this.redis = redisInstance; 
    this.dim = 1536; // base on the embedding
    this.index = new hnswlib.Index(this.dim); // make a storage
    this.index.initIndex(); // initialize it as per documentation

    this.openai = new OpenAI({
      // API key
    });
  }
  // lets say this is where the server throws the parsed command
  setMethod(key, query) { // So lets say its a whole query that I decided to pass
    const data = query //Process the query

    //First convert the data into vector
    const vector = vectorEmbeding(data)

    //store it 
    this.redis.set(key, vector) // i dont exactly know whats the format
    this.index.set(vector) // This is the search map
    return 'OK'
  }

  // i dont exactly know how to search but base on the test i need to use convert the query into a vector
  // then use that vector to perform fanct mathematics like euclidean and cosine
  searchMethod(query) {
    //return the probable results
  }

  async vectorEmbeding(data) {
    // Use OpenAI's embedding API to get the vector representation of the text
    const response = await this.openai.embeddings.create({
      model: 'text-embedding-ada-002', // Example: OpenAI's embedding model
      input: data,
    });

    // Get the embedding vector from the response
    const vector = response.data[0].embedding; // Returns a 1536-dimensional vector
    return vector;
  }

}
```

There's a lot of whole to fill but this is just an idea regardless.

## **DOCUMENT DATABASE IMPLEMENTATION**

It basically how a nosql works but only affects documents data as it should be so we can still use the existing storage for the redisclone class

this wont use the exisitng JSON data though we need a way that when stored in the storage its a key and an object that stores the document with a pattern like this:

```
{
  type: 'document',  // Type identifier
  collection: 'users', // Logical grouping
  data: {           // Actual document data
    name: 'John',
    age: 30
  }
}
```

So the flow goes like this 

1. Client sends command → DOCSET users {"name":"John", "age":30}
2. Generate unique ID → "users:timestamp"
3. Wrap in type envelope → {type: 'document', collection: 'users', data: {name:'John', age:30}}
4. Serialize to string → JSON.stringify(envelope)
5. Store in main storage → storage.set(id, serializedData)
6. If indexes exist → Update all relevant indexes

As for querying the flow will go like this 

1. Client sends query → DOCFIND users {"age": {"$gt": 25}}
2. Check for usable indexes:
   - Look for index on queried fields
   - If found → Use index to get candidate documents
   - If not → Full scan needed
3. Apply filters:
   - Parse query operators ($gt, $lt, etc.)
   - Match documents against criteria
4. Return matching documents
